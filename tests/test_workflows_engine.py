"""Unit tests covering app/workflows.py dispatch, scheduling, and routes."""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

from fastapi import HTTPException, Response

from app import workflows
from app.workflows import WorkflowSpec


class WorkflowsEngineTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'alice', 'is_admin': True}
        self.wid = uuid.uuid4()

    def test_spec_validations(self):
        # Invalid timezone
        with self.assertRaises(ValueError):
            WorkflowSpec(name='W', prompt='P', timezone='Bad/Timezone')
        # Empty name or prompt
        with self.assertRaises(ValueError):
            WorkflowSpec(name='  ', prompt='P')
        # Iterations > 1 without completion criteria
        with self.assertRaises(ValueError):
            WorkflowSpec(name='W', prompt='P', max_iterations=2, completion_criteria='')
        # Presentation without template
        with self.assertRaises(ValueError):
            WorkflowSpec(name='W', prompt='P', presentation_format='html', template_id=None, slide_count=5)

        # Valid spec
        spec = WorkflowSpec(name='W', prompt='P', max_iterations=2, completion_criteria='Done when checked')
        self.assertEqual(spec.name, 'W')

    def test_public(self):
        now = datetime.now(timezone.utc)
        row = {
            'id': self.wid,
            'spec': {'name': 'W', 'prompt': 'P'},
            'enabled': True,
            'next_run': now,
            'last_job_id': uuid.uuid4(),
            'last_error': None,
        }
        res = workflows.public(row)
        self.assertEqual(res['id'], str(self.wid))
        self.assertEqual(res['name'], 'W')
        self.assertEqual(res['next_run'], now.isoformat())

    def test_validate_resources(self):
        # Skill not found
        spec_skill = WorkflowSpec(name='W', prompt='P', skill_name='unknown-skill')
        with patch('app.workspace_config.list_skills', return_value=[]):
            with self.assertRaises(ValueError):
                workflows.validate_resources(spec_skill)

        # Web search without API key
        spec_search = WorkflowSpec(name='W', prompt='P', web_search=True)
        with patch.dict(os.environ, {'BRAVE_API_KEY': ''}):
            with self.assertRaises(ValueError):
                workflows.validate_resources(spec_search)

        # Web search without user access
        with patch.dict(os.environ, {'BRAVE_API_KEY': 'secret_key'}), \
             patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value=None):
            with self.assertRaises(ValueError):
                workflows.validate_resources(spec_search, username='alice')

        # Presentation template check
        spec_pres = WorkflowSpec(name='W', prompt='P', presentation_format='html', template_id='buddy-starter', slide_count=5)
        with patch('app.presentation.get_presentation_template') as mock_tmpl:
            workflows.validate_resources(spec_pres)
            mock_tmpl.assert_called_once_with('buddy-starter')

    def test_dispatch(self):
        db = MagicMock()
        spec = WorkflowSpec(name='W', prompt='P')

        # User not found
        with patch('app.postgres_storage._lock'):
            db.execute.return_value.fetchone.return_value = None
            with self.assertRaises(ValueError) as exc:
                workflows._dispatch(db, 'alice', spec)
            self.assertIn('Account no longer exists', str(exc.exception))

        # Project not found
        spec_proj = WorkflowSpec(name='W', prompt='P', project_id='0123456789abcdef0123456789abcdef')
        with patch('app.postgres_storage._lock'):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: (1,)), # user exists
                MagicMock(fetchone=lambda: None), # project does not exist
            ]
            with self.assertRaises(ValueError) as exc2:
                workflows._dispatch(db, 'alice', spec_proj)
            self.assertIn('Project no longer exists', str(exc2.exception))

        # Project has active task
        with patch('app.postgres_storage._lock'):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: (1,)), # user exists
                MagicMock(fetchone=lambda: (1,)), # project exists
                MagicMock(fetchone=lambda: (1,)), # active task
            ]
            with self.assertRaises(ValueError) as exc3:
                workflows._dispatch(db, 'alice', spec_proj)
            self.assertIn('Project has an active task', str(exc3.exception))

        # Workflow already has active run
        with patch('app.postgres_storage._lock'):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: (1,)), # user exists
                MagicMock(fetchone=lambda: None), # no workspace active task
                MagicMock(fetchone=lambda: (1,)), # workflow active run
            ]
            with self.assertRaises(ValueError) as exc4:
                workflows._dispatch(db, 'alice', spec, workflow_id=self.wid)
            self.assertIn('already has an active run', str(exc4.exception))

        # Dispatch success
        with patch('app.postgres_storage._lock'):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: (1,)), # user exists
                MagicMock(fetchone=lambda: None), # no workspace active task
                MagicMock(fetchone=lambda: None), # no workflow active task
                MagicMock(), # insert conversation
                MagicMock(), # insert job
                MagicMock(), # insert history
                MagicMock(), # insert event
                MagicMock(), # notify
            ]
            res = workflows._dispatch(db, 'alice', spec, workflow_id=self.wid)
            self.assertIn('job_id', res)
            self.assertIn('session_id', res)

    def test_save_workflow(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        spec = WorkflowSpec(name='W', prompt='P')
        # Limit reached
        with patch.object(workflows, 'ensure_schema'), \
             patch.object(workflows, 'validate_resources'), \
             patch('app.workflows.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: {'n': 50}), # count
            ]
            with self.assertRaises(ValueError) as exc:
                workflows.save_workflow('alice', spec)
            self.assertIn('Limit of 50', str(exc.exception))

        # Success
        with patch.object(workflows, 'ensure_schema'), \
             patch.object(workflows, 'validate_resources'), \
             patch('app.workflows.job_queue._connect', mock_conn):
            row = {'id': self.wid, 'spec': spec.model_dump(), 'enabled': True, 'next_run': None, 'last_job_id': None, 'last_error': None}
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: {'n': 5}), # count
                MagicMock(fetchone=lambda: row), # insert
            ]
            pub = workflows.save_workflow('alice', spec)
            self.assertEqual(pub['name'], 'W')

    def test_run_now_and_change_workflow(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        spec = WorkflowSpec(name='W', prompt='P')
        row = {'id': self.wid, 'spec': spec.model_dump(), 'enabled': True, 'next_run': None, 'last_job_id': None, 'last_error': None}

        # run_now not found
        with patch.object(workflows, 'ensure_schema'), patch('app.workflows.job_queue._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = None
            res = workflows.run_now('alice', workflow_id=str(self.wid))
            self.assertIsNone(res)

        # run_now success
        with patch.object(workflows, 'ensure_schema'), \
             patch('app.workflows.job_queue._connect', mock_conn), \
             patch.object(workflows, 'validate_resources'), \
             patch.object(workflows, '_dispatch', return_value={'job_id': 'jid1', 'session_id': 'sid1'}):
            db.execute.return_value.fetchone.return_value = row
            res2 = workflows.run_now('alice', workflow_id=str(self.wid))
            self.assertEqual(res2['job_id'], 'jid1')

        # change_workflow delete
        with patch.object(workflows, 'ensure_schema'), patch('app.workflows.job_queue._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = row
            res_del = workflows.change_workflow('alice', str(self.wid), delete=True)
            self.assertEqual(res_del, {'deleted': True})

        # change_workflow toggle enabled
        with patch.object(workflows, 'ensure_schema'), patch('app.workflows.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: row),
                MagicMock(fetchone=lambda: {**row, 'enabled': False}),
            ]
            res_tog = workflows.change_workflow('alice', str(self.wid), enabled=False)
            self.assertFalse(res_tog['enabled'])

    def test_dispatch_due(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        spec = WorkflowSpec(name='W', prompt='P', frequency='daily')
        row = {'id': self.wid, 'username': 'alice', 'spec': spec.model_dump(), 'enabled': True, 'next_run': datetime.now(timezone.utc)}

        # Success run
        with patch.object(workflows, 'ensure_schema'), \
             patch('app.workflows.job_queue._connect', mock_conn), \
             patch.object(workflows, '_dispatch', return_value={'job_id': 'jid1'}):
            db.execute.side_effect = [
                MagicMock(fetchall=lambda: [row]), # select due
                MagicMock(), # update next_run
            ]
            workflows.dispatch_due()

        # Failure run (project busy)
        with patch.object(workflows, 'ensure_schema'), \
             patch('app.workflows.job_queue._connect', mock_conn), \
             patch.object(workflows, '_dispatch', side_effect=ValueError('Project has an active task')):
            db.execute.side_effect = [
                MagicMock(fetchall=lambda: [row]),
                MagicMock(), # update retry
            ]
            workflows.dispatch_due()

    def test_router_endpoints(self):
        # capabilities
        with patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value=True), \
             patch.dict(os.environ, {'BRAVE_API_KEY': 'brave_key'}):
            caps = asyncio.run(workflows.capabilities(self.user))
            self.assertTrue(caps['web_search'])
            self.assertEqual(caps['max_roles'], 3)

        # get_workflows
        resp = Response()
        with patch.object(workflows, 'list_workflows', return_value=[]):
            out = asyncio.run(workflows.get_workflows(resp, self.user))
            self.assertEqual(out, [])
            self.assertEqual(resp.headers.get('cache-control'), 'no-store')

        # create_workflow
        spec = WorkflowSpec(name='W', prompt='P')
        with patch.object(workflows, 'save_workflow', return_value={'id': str(self.wid)}):
            res_cw = asyncio.run(workflows.create_workflow(spec, self.user))
            self.assertEqual(res_cw['id'], str(self.wid))

        with patch.object(workflows, 'save_workflow', side_effect=ValueError('Limit reached')):
            with self.assertRaises(HTTPException) as exc_cw:
                asyncio.run(workflows.create_workflow(spec, self.user))
            self.assertEqual(exc_cw.exception.status_code, 422)

        # start_workflow
        with patch.object(workflows, 'run_now', return_value={'job_id': 'j1'}):
            res_sw = asyncio.run(workflows.start_workflow(spec, self.user))
            self.assertEqual(res_sw['job_id'], 'j1')

        # start_saved not found
        with patch.object(workflows, 'run_now', return_value=None):
            with self.assertRaises(HTTPException) as exc_ss:
                asyncio.run(workflows.start_saved(self.wid, None, self.user))
            self.assertEqual(exc_ss.exception.status_code, 404)

        # toggle_saved not found
        with patch.object(workflows, 'change_workflow', return_value=None):
            with self.assertRaises(HTTPException) as exc_ts:
                asyncio.run(workflows.toggle_saved(self.wid, workflows.EnabledRequest(enabled=True), self.user))
            self.assertEqual(exc_ts.exception.status_code, 404)

        # delete_saved not found
        with patch.object(workflows, 'change_workflow', return_value=None):
            with self.assertRaises(HTTPException) as exc_ds:
                asyncio.run(workflows.delete_saved(self.wid, self.user))
            self.assertEqual(exc_ds.exception.status_code, 404)


if __name__ == '__main__':
    unittest.main()
