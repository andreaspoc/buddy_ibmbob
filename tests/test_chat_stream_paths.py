"""Chat submission routing with persistence and remote work replaced by mocks."""
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException
from app import main


class ChatStreamPathsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = None
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        replacements = [
            (main, 'workspace_for', MagicMock(return_value='/tmp/fixture')),
            (main.job_queue, '_connect', connect),
            (main.job_queue, 'find_submission', MagicMock(return_value=None)),
            (main.job_queue, 'enqueue', MagicMock(return_value='fixture-job')),
            (main.storage, 'get_file', MagicMock(return_value=None)),
            (main, 'storage_scope', MagicMock(return_value='session:fixture')),
            (main, 'workspace_key', MagicMock(return_value='alice:fixture')),
            (main, 'read_history', MagicMock(return_value=[])),
            (main, 'list_modes', MagicMock(return_value=[{'slug': 'agent'}, {'slug': 'presentation'}])),
            (main, 'list_skills', MagicMock(return_value=[])),
            (main, 'presentation_intent', MagicMock(return_value={'presentation': False})),
            (main, 'touch_session', MagicMock()),
            (main, 'execute_event_hooks', AsyncMock(return_value=(True, '', ''))),
            (main, '_chat_submission_response', MagicMock(side_effect=lambda job, payload, workspace, **kw: payload)),
        ]
        for owner, name, value in replacements:
            self.stack.enter_context(patch.object(owner, name, value))
        self.request = SimpleNamespace(headers={})
        self.user = {'username': 'alice'}

    async def test_plain_prompt_enqueues_with_correlation_and_approval_policy(self):
        req = main.StreamRequest(prompt='Explain this', workspace_id='legacy', mode='agent')
        result = await main.chat_stream(req, self.request, self.user)
        self.assertEqual(result['prompt'], 'Explain this')
        self.assertEqual(result['mode'], 'agent')
        self.assertTrue(result['correlation_id'])
        self.assertEqual(result['approval_runtime'], 'acp')
        main.job_queue.enqueue.assert_called_once()
        main.touch_session.assert_called_once_with('legacy', 'alice', 'Explain this')

    async def test_invalid_idempotency_or_missing_workspace_never_enqueues(self):
        request = SimpleNamespace(headers={'idempotency-key': 'invalid key'})
        req = main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent')
        with self.assertRaises(HTTPException) as error:
            await main.chat_stream(req, request, self.user)
        self.assertEqual(error.exception.status_code, 422)
        main.job_queue.enqueue.assert_not_called()
        main.workspace_for.side_effect = FileNotFoundError()
        with self.assertRaises(HTTPException) as error:
            await main.chat_stream(req, self.request, self.user)
        self.assertEqual(error.exception.status_code, 404)

    async def test_existing_artifact_edits_without_resuming_agent(self):
        main.storage.get_file.return_value = {'content': b'<html></html>'}
        req = main.StreamRequest(prompt='Change title', workspace_id='legacy', mode='agent', edit_artifact_path='report.html', session_id='a' * 32)
        result = await main.chat_stream(req, self.request, self.user)
        self.assertEqual(result['edit_artifact_path'], 'report.html')
        self.assertIsNone(result['session_id'])
        self.assertIn('report.html', result['bob_prompt'])

    async def test_unknown_mode_or_skill_is_rejected(self):
        for changes in ({'mode': 'missing'}, {'mode': 'agent', 'skill_name': 'missing-buddy'}):
            with self.subTest(changes=changes), self.assertRaises(HTTPException) as error:
                await main.chat_stream(main.StreamRequest(prompt='Explain', workspace_id='legacy', **changes), self.request, self.user)
            self.assertEqual(error.exception.status_code, 404)
        main.job_queue.enqueue.assert_not_called()

    async def test_hook_denial_does_not_enqueue(self):
        main.execute_event_hooks.return_value = (False, '', 'fixture block')
        response = await main.chat_stream(main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent'), self.request, self.user)
        self.assertEqual(response.status_code, 200)
        text = ''.join([chunk async for chunk in response.body_iterator])
        self.assertIn('fixture block', text)
        main.job_queue.enqueue.assert_not_called()

    async def test_replayed_submission_returns_existing_payload_without_enqueuing(self):
        existing = SimpleNamespace(payload={'prompt': 'previous'})
        main.job_queue.find_submission.return_value = existing
        response = await main.chat_stream(main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent'), self.request, self.user)
        self.assertEqual(response, {'prompt': 'previous'})
        self.assertTrue(main._chat_submission_response.call_args.kwargs['reused'])
        main.job_queue.enqueue.assert_not_called()

    async def test_presentation_setup_and_artifact_validation(self):
        main.presentation_intent.return_value = {'presentation': True, 'slide_count': 4, 'format': 'html'}
        with self.assertRaises(HTTPException) as error:
            await main.chat_stream(main.StreamRequest(prompt='Create slides', workspace_id='legacy', mode='agent'), self.request, self.user)
        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(error.exception.detail['code'], 'presentation_setup_required')
        main.presentation_intent.return_value = {'presentation': False}
        for path, code in (('../bad.html', 422), ('document.exe', 422), ('missing.html', 404)):
            with self.subTest(path=path), self.assertRaises(HTTPException) as error:
                await main.chat_stream(main.StreamRequest(prompt='Edit', workspace_id='legacy', mode='agent', edit_artifact_path=path), self.request, self.user)
            self.assertEqual(error.exception.status_code, code)
        main.job_queue.enqueue.assert_not_called()

    async def test_skills_are_routed_and_remote_skill_combinations_rejected(self):
        main.list_skills.return_value = [{'name': 'sample-buddy'}]
        req = main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent', skill_name='sample-buddy')
        with patch('app.workspace_config.resolve_skill_name', side_effect=lambda name: name):
            result = await main.chat_stream(req, self.request, self.user)
            self.assertEqual(result['skill_name'], 'sample-buddy')
            self.assertIn('$sample-buddy', result['bob_prompt'])
            req = main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent', skill_name='sample-buddy', agent_name='remote')
            with self.assertRaises(HTTPException) as error:
                await main.chat_stream(req, self.request, self.user)
            self.assertEqual(error.exception.status_code, 422)

    async def test_preset_is_applied_and_missing_preset_is_rejected(self):
        req = main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent', preset_id='a' * 32)
        with patch.object(main, 'get_preset', return_value={'mode': 'agent', 'instructions': 'Use headings'}):
            result = await main.chat_stream(req, self.request, self.user)
        self.assertIn('Use headings', result['bob_prompt'])
        with patch.object(main, 'get_preset', return_value=None):
            with self.assertRaises(HTTPException) as error:
                await main.chat_stream(main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent', preset_id='b' * 32), self.request, self.user)
        self.assertEqual(error.exception.status_code, 404)

    async def test_voice_with_explicit_skill_is_rejected(self):
        req = main.StreamRequest(prompt='Explain', workspace_id='legacy', mode='agent', voice_mode=True, skill_name='sample-buddy')
        with self.assertRaises(HTTPException) as error:
            await main.chat_stream(req, self.request, self.user)
        self.assertEqual(error.exception.status_code, 422)
        main.job_queue.enqueue.assert_not_called()


if __name__ == '__main__':
    unittest.main()
