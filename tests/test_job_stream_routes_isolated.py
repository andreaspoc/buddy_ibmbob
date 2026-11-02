"""Isolated coverage of job ownership, replay and WebSocket cleanup."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException
from app import main


class Socket:
    def __init__(self, origin='https://example.test'):
        self.headers = {'origin': origin, 'host': 'example.test'}
        self.accept = AsyncMock()
        self.close = AsyncMock()
        self.send_json = AsyncMock()
        async def wait_for_disconnect():
            await asyncio.Event().wait()
        self.receive_text = AsyncMock(side_effect=wait_for_disconnect)


class JobRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.job_id = uuid4()
        self.user = {'username': 'alice'}

    async def test_policy_reads_and_updates_are_owner_scoped(self):
        policy = main.ApprovalPolicy(mode='selected', actions=['files'])
        with patch.object(main.job_queue, 'get_approval_policy', return_value={'revision': 1}) as get:
            self.assertEqual(await main.get_job_approval_policy(self.job_id, self.user), {'revision': 1})
            get.assert_called_once_with(str(self.job_id), 'alice')
        with patch.object(main.job_queue, 'update_approval_policy', return_value={'revision': 2}) as update:
            self.assertEqual(await main.put_job_approval_policy(self.job_id, policy, self.user), {'revision': 2})
            update.assert_called_once_with(str(self.job_id), 'alice', {'mode': 'selected', 'actions': ['files']})

    async def test_policy_missing_and_conflicts_are_translated(self):
        policy = main.ApprovalPolicy()
        with patch.object(main.job_queue, 'get_approval_policy', return_value=None):
            with self.assertRaises(HTTPException) as error:
                await main.get_job_approval_policy(self.job_id, self.user)
            self.assertEqual(error.exception.status_code, 404)
        for result, status in [(None, 404), (ValueError('stale'), 409)]:
            with patch.object(main.job_queue, 'update_approval_policy', side_effect=result if isinstance(result, Exception) else None, return_value=None):
                with self.assertRaises(HTTPException) as error:
                    await main.put_job_approval_policy(self.job_id, policy, self.user)
                self.assertEqual(error.exception.status_code, status)

    async def test_decision_validation_and_conflict(self):
        req = main.ApprovalDecisionRequest(decision='approve')
        with patch.object(main.job_queue, 'decide_approval', side_effect=ValueError('already decided')) as decide:
            with self.assertRaises(HTTPException) as error:
                await main.decide_job_approval('invalid', str(uuid4()), req, self.user)
            self.assertEqual(error.exception.status_code, 404)
            decide.assert_not_called()
            with self.assertRaises(HTTPException) as error:
                await main.decide_job_approval(str(self.job_id), str(uuid4()), req, self.user)
            self.assertEqual(error.exception.status_code, 409)

    async def test_cancel_records_event_and_reports_terminal_state(self):
        initial = {'workspace_id': 'space', 'cancel_event': {'type': 'cancel'}}
        final = {'status': 'cancelled', 'payload': {'cancel_requested': True}}
        with patch.object(main.job_queue, 'request_cancel', return_value=initial), \
             patch.object(main.job_queue, 'get_job', return_value=final), \
             patch.object(main, 'append_history') as append:
            self.assertEqual(await main.cancel_job(self.job_id, self.user), {'status': 'stopped'})
            append.assert_called_once_with('space', 'alice', initial['cancel_event'])

    async def test_cancel_pending_returns_accepted_and_missing_is_not_found(self):
        with patch.object(main.job_queue, 'request_cancel', return_value=None):
            with self.assertRaises(HTTPException) as error:
                await main.cancel_job(self.job_id, self.user)
            self.assertEqual(error.exception.status_code, 404)
        active = {'status': 'running', 'payload': {}}
        with patch.object(main.job_queue, 'request_cancel', return_value={ 'workspace_id': 'space'}), \
             patch.object(main.job_queue, 'get_job', return_value=active), \
             patch.object(main.asyncio, 'sleep', new_callable=AsyncMock):
            response = await main.cancel_job(self.job_id, self.user)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(json.loads(response.body), {'status': 'stopping'})

    async def test_replay_paginates_terminal_batch_and_closes_connection(self):
        conn = Mock(close=AsyncMock())
        full_page = [{'id': n, 'event': {'type': 'progress'}} for n in range(1, 201)]
        last_page = [{'id': 201, 'event': {'type': 'done'}}]
        with patch.object(main.job_queue, 'stream_reader', new=AsyncMock(return_value=conn)), \
             patch.object(main.job_queue, 'read_stream_events', new=AsyncMock(side_effect=[(full_page, 'done'), (last_page, 'done')])) as read:
            events = [json.loads(item) async for item in main._replay_job_events(str(self.job_id), -3)]
        self.assertEqual(len(events), 201)
        self.assertEqual(events[-1], {'type': 'done', 'event_id': 201})
        self.assertEqual(read.await_args_list[0].args[-1], 0)
        self.assertEqual(read.await_args_list[1].args[-1], 200)
        conn.close.assert_awaited_once()

    async def test_socket_rejects_cross_origin_and_unknown_job(self):
        bad = Socket('https://attacker.test')
        with patch.object(main, 'current_user', new_callable=AsyncMock) as current:
            await main.artifact_socket(bad, self.job_id)
            current.assert_not_awaited()
        bad.close.assert_awaited_once_with(code=1008)
        unknown = Socket()
        with patch.object(main, 'current_user', new=AsyncMock(return_value=self.user)), \
             patch.object(main.job_queue, 'get_job', return_value=None):
            await main.artifact_socket(unknown, self.job_id)
        unknown.close.assert_awaited_once_with(code=1008)
        unknown.accept.assert_not_awaited()

    async def test_socket_delivers_artifacts_and_closes_resources(self):
        socket = Socket()
        conn = Mock(execute=AsyncMock(), close=AsyncMock())
        job = {'workspace_id': 'workspace', 'payload': {}}
        async def events(*args):
            yield {'type': 'artifact', 'path': 'report.md', 'event_id': 3}
        with patch.object(main, 'current_user', new=AsyncMock(return_value=self.user)), \
             patch.object(main.job_queue, 'get_job', return_value=job), \
             patch.object(main.job_queue, 'stream_reader', new=AsyncMock(return_value=conn)), \
             patch('app.live_artifacts.artifact_events', side_effect=events):
            await main.artifact_socket(socket, self.job_id, 2)
        socket.accept.assert_awaited_once()
        self.assertEqual(socket.send_json.await_args.args[0]['path'], 'report.md')
        conn.execute.assert_awaited_once_with('LISTEN bob_job_events')
        conn.close.assert_awaited_once()
        socket.close.assert_awaited_once()

    async def test_knowledge_preview_handles_stale_and_invalid_citations(self):
        user = {'username': 'alice', 'is_admin': False}
        citation = uuid4()
        with patch.object(main.rag, 'citation_preview', return_value={'text': 'passage'}) as preview:
            response = await main.preview_knowledge(self.job_id, 'shared', citation, 'text', user)
            self.assertEqual(json.loads(response.body), {'text': 'passage'})
            self.assertEqual(response.headers['cache-control'], 'no-store')
            preview.assert_called_once_with('alice', 'shared', str(self.job_id), str(citation), 'text')
        for outcome, status in [(None, 404), (ValueError('bad citation'), 422)]:
            with patch.object(main.rag, 'citation_preview', side_effect=outcome if isinstance(outcome, Exception) else None, return_value=None):
                with self.assertRaises(HTTPException) as error:
                    await main.preview_knowledge(self.job_id, 'shared', None, None, user)
                self.assertEqual(error.exception.status_code, status)

    async def test_prepared_document_requires_ready_status(self):
        user = {'username': 'alice', 'is_admin': False}
        for doc in [None, {'status': 'pending'}]:
            with patch.object(main.rag, 'get_document', return_value=doc):
                with self.assertRaises(HTTPException) as error:
                    await main.prepared_knowledge(self.job_id, 'shared', user)
                self.assertEqual(error.exception.status_code, 404)
        with patch.object(main.rag, 'get_document', return_value={'status': 'ready', 'prepared_text': 'ready text'}):
            response = await main.prepared_knowledge(self.job_id, 'shared', user)
            self.assertEqual(response.body, b'ready text')
            self.assertEqual(response.headers['cache-control'], 'no-store')

    async def test_knowledge_search_returns_safe_failure(self):
        request = main.KnowledgeSearchRequest(query='query', knowledge_base='company')
        with patch.object(main.rag, 'retrieve', new=AsyncMock(side_effect=ValueError('internal details'))):
            with self.assertRaises(HTTPException) as error:
                await main.search_knowledge(request, self.user)
            self.assertEqual(error.exception.status_code, 503)
            self.assertNotIn('internal details', error.exception.detail)
