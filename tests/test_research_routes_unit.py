"""Unit tests for app.research routes and usage aggregation."""
import datetime
import os
import unittest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException

from app import research
from app.research import ResearchSpec, research_usage


class ResearchUnitTests(unittest.TestCase):
    def test_research_usage_aggregation(self):
        events = [
            {'type': 'other', 'cost': 100},
            {'type': 'research_usage', 'phase': 'search', 'cost': 0.02, 'tokens': 150},
            {'type': 'research_usage', 'phase': 'synthesize', 'cost': 0.05, 'tokens': 300},
            {'type': 'done', 'cost': 0.07, 'tokens': 450},
        ]
        res = research_usage(events)
        self.assertAlmostEqual(res['bobcoins'], 0.07)
        self.assertEqual(res['tokens'], 450)
        self.assertEqual(len(res['phases']), 2)

    def test_capabilities(self):
        with patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value={'command': 'brave'}), \
             patch.dict(os.environ, {'BRAVE_API_KEY': 'brave-key'}), \
             patch('app.research_sources.office_available', return_value=True):
            caps = research.capabilities(user={'username': 'alice'})
            self.assertTrue(caps['web_search'])
            self.assertTrue(caps['knowledge'])
            self.assertTrue(caps['office'])

    def test_create_validations(self):
        spec = ResearchSpec(topic='Detailed AI topic for research', web_search=True)

        with patch('app.workspace_config.ensure_brave_mcp'):
            # web_search not allowed
            with patch('app.mcp_access.get_authorized_server', return_value=None):
                with self.assertRaises(HTTPException) as ctx:
                    research.create(spec, user={'username': 'alice'})
                self.assertEqual(ctx.exception.status_code, 403)

            # office not available
            spec_off = ResearchSpec(topic='Detailed AI topic for research', office=True, web_search=False)
            with patch('app.research_sources.office_available', return_value=False):
                with self.assertRaises(HTTPException) as ctx:
                    research.create(spec_off, user={'username': 'alice'})
                self.assertEqual(ctx.exception.status_code, 403)

            # no sources selected
            spec_none = ResearchSpec(topic='Detailed AI topic for research', web_search=False, knowledge=False, office=False)
            with self.assertRaises(HTTPException) as ctx:
                research.create(spec_none, user={'username': 'alice'})
            self.assertEqual(ctx.exception.status_code, 422)

            # web_search but no BRAVE_API_KEY
            with patch('app.mcp_access.get_authorized_server', return_value={'command': 'brave'}), \
                 patch.dict(os.environ, {'BRAVE_API_KEY': ''}):
                with self.assertRaises(HTTPException) as ctx:
                    research.create(spec, user={'username': 'alice'})
                self.assertEqual(ctx.exception.status_code, 422)

    def test_create_success(self):
        spec = ResearchSpec(topic='Detailed AI topic for research', web_search=True, timeout_seconds=120)
        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value={'command': 'brave'}), \
             patch.dict(os.environ, {'BRAVE_API_KEY': 'key-123'}), \
             patch('app.research.ensure_schema'), \
             patch('app.research._dispatch', return_value={'job_id': 'j1', 'session_id': 's1'}), \
             patch('app.job_queue._connect', return_value=mock_ctx):
            res = research.create(spec, user={'username': 'alice'})
            self.assertEqual(res['job_id'], 'j1')
            mock_db.execute.assert_called()

    def test_reports_list(self):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = [
            {'id': 's1', 'record': {'title': 'Report 1', 'updated': '2026-01-01'}, 'job_id': 'j1', 'status': 'completed', 'payload': {}}
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.research.ensure_schema'), \
             patch('app.job_queue._connect', return_value=mock_ctx):
            reports = research.reports(user={'username': 'alice'})
            self.assertEqual(len(reports), 1)
            self.assertEqual(reports[0]['title'], 'Report 1')
            self.assertEqual(reports[0]['status'], 'completed')

    def test_chat_report_needs_a_full_document(self):
        full = '# Title\n' + '\n'.join(f'## Section {i}\n' + 'Finding text. ' * 60 for i in range(4))
        answer = 'I gathered the data.\n\n---\n\n' + full + '\n```bobnext\n{"options":[]}\n```\n'
        self.assertEqual(research.report_from_chat(answer), full.strip())
        self.assertEqual(research.report_from_chat('Done. Updated chart 4.\n## Note\nFixed.'), '')
        self.assertEqual(research.report_from_chat('no headings ' * 400), '')
        self.assertEqual(research.report_from_chat(None), '')

    def test_latest_chat_report_prefers_the_most_complete_answer(self):
        full = '# Title\n' + '\n'.join(f'## Section {i}\n' + 'Finding text. ' * 60 for i in range(4))
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchall.return_value = [{'id': 'new'}, {'id': 'gone'}, {'id': 'old'}]
        context = MagicMock()
        context.__enter__.return_value = mock_db
        section = '# Chart fix\n' + '\n'.join(f'## Part {i}\n' + 'Note. ' * 90 for i in range(4))
        results = {'new': {'result': section}, 'gone': None, 'old': {'result': full + '\n' + full}}
        with patch('app.job_queue._connect', return_value=context), patch('app.tasks.task_detail', side_effect=lambda _, job: results[job]):
            self.assertEqual(research.latest_chat_report('alice', 's1'), (full + '\n' + full).strip())
        results.update(new={'result': 'Short'}, old={'result': 'Short'})
        with patch('app.job_queue._connect', return_value=context), patch('app.tasks.task_detail', side_effect=lambda _, job: results[job]):
            self.assertEqual(research.latest_chat_report('alice', 's1'), '')

    def test_explicit_stop_is_reported_as_stopped(self):
        self.assertEqual(research.public_status({'status': 'failed', 'payload': {'cancel_requested': True}}), 'stopped')
        self.assertEqual(research.public_status({'status': 'failed', 'payload': {}}), 'failed')
        self.assertEqual(research.public_status({'status': 'running'}), 'running')

    def _resume(self, row, **kwargs):
        mock_db = MagicMock()
        mock_db.execute.return_value.fetchone.return_value = row
        context = MagicMock()
        context.__enter__.return_value = mock_db
        enqueue = kwargs.get('enqueue') or MagicMock(return_value='job-2')
        with patch('app.research.scope_for', return_value='session:s1'), patch('app.research.ensure_schema'), \
             patch('app.job_queue._connect', return_value=context), patch('app.job_queue.enqueue', enqueue), \
             patch('app.research.authorize_sources', kwargs.get('authorize') or MagicMock()):
            return research.resume('s1', user={'username': 'alice'}), enqueue, mock_db

    def test_resume_requeues_same_workspace_without_stop_flags(self):
        row = {'status': 'failed', 'workspace_key': 'alice:session:s1',
               'payload': {'prompt': 'Topic', 'cancel_requested': True, 'superseded': True, 'research': {'web_search': True}}}
        result, enqueue, db = self._resume(row)
        self.assertEqual(result, {'job_id': 'job-2', 'session_id': 's1'})
        username, session, key, payload = enqueue.call_args.args
        self.assertEqual((username, session, key), ('alice', 's1', 'alice:session:s1'))
        self.assertEqual(payload, {'prompt': 'Topic', 'research': {'web_search': True, 'session_id': 's1'}})
        self.assertEqual(db.execute.call_args.args[1], (research.RESEARCH_ATTEMPTS, 'job-2'))

    def test_resume_refused_when_missing_active_finished_or_revoked(self):
        with self.assertRaises(HTTPException) as ctx:
            self._resume(None)
        self.assertEqual(ctx.exception.status_code, 404)
        for status in ('queued', 'running', 'completed'):
            with self.subTest(status=status), self.assertRaises(HTTPException) as ctx:
                self._resume({'status': status, 'workspace_key': 'k', 'payload': {'research': {}}})
            self.assertEqual(ctx.exception.status_code, 409)
        row = {'status': 'failed', 'workspace_key': 'k', 'payload': {'research': {'web_search': True}}}
        enqueue = MagicMock()
        with self.assertRaises(HTTPException) as ctx:
            self._resume(row, enqueue=enqueue, authorize=MagicMock(side_effect=HTTPException(403, 'Denied')))
        self.assertEqual(ctx.exception.status_code, 403)
        enqueue.assert_not_called()
        with self.assertRaises(HTTPException) as ctx:
            self._resume(row, enqueue=MagicMock(side_effect=ValueError('Conversation is being deleted')))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_detail_and_export(self):
        mock_db = MagicMock()
        now = datetime.datetime.now(datetime.timezone.utc)

        def router(query, *args):
            q = str(query)
            m = MagicMock()
            if 'FROM bob_conversations c' in q:
                m.fetchone.return_value = {
                    'record': {'title': 'Research Report'}, 'status': 'completed', 'job_id': 'j1', 'payload': {}
                }
            elif 'FROM bob_job_events' in q and 'DESC LIMIT 40' in q:
                m.fetchall.return_value = [{'event': {'type': 'tool', 'input': {'query': 'test'}}, 'created_at': now}]
            elif 'FROM bob_job_events' in q and 'ORDER BY e.id' in q:
                m.fetchall.return_value = [{'event': {'type': 'done', 'cost': 0.01, 'tokens': 50}}]
            else:
                m.fetchall.return_value = []
                m.fetchone.return_value = None
            return m

        mock_db.execute.side_effect = router
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db

        with patch('app.research.scope_for', return_value='session:s1'), \
             patch('app.job_queue._connect', return_value=mock_ctx), \
             patch('app.postgres_storage.get_file', return_value={'content': b'# My Final Report'}), \
             patch('app.tasks.task_detail', return_value={'progress': '100%'}):
            d = research.detail('s1', user={'username': 'alice'})
            self.assertEqual(d['title'], 'Research Report')
            self.assertEqual(d['report'], '# My Final Report')
            self.assertEqual(d['job_id'], 'j1')
            self.assertFalse(d['can_resume'])

            # export markdown
            exp = research.export('s1', format='markdown', user={'username': 'alice'})
            self.assertEqual(exp.body, b'# My Final Report')

            # export invalid format
            with self.assertRaises(HTTPException) as ctx:
                research.export('s1', format='pdf', user={'username': 'alice'})
            self.assertEqual(ctx.exception.status_code, 422)


if __name__ == '__main__':
    unittest.main()
