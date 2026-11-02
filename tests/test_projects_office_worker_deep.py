"""Comprehensive hermetic unit tests for Projects, Office, Worker, and RAG modules.

Hermetically mocks all external dependencies, network sockets, S3, Keycloak,
and PostgreSQL databases. Adheres strictly to the Zero Fake Data Policy.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import date, datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4
import zipfile

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import Response

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT / 'plugins' / 'projects') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'projects'))
if str(PROJECT_ROOT / 'plugins' / 'office') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'office'))

import buddy_projects.service as projects_service
import buddy_office.office as office_service
import buddy_office.office_chat as office_chat
from app import rag, worker


class DummyDb:
    """Mock database connection and cursor for hermetic tests."""
    def __init__(self, fetchone_val=None, fetchall_val=None):
        self.fetchone_val = fetchone_val
        self.fetchall_val = fetchall_val if fetchall_val is not None else []
        self.executed = []
        self.info = SimpleNamespace(transaction_status=projects_service.TransactionStatus.IDLE)

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        if isinstance(self.fetchone_val, list):
            return self.fetchone_val.pop(0) if self.fetchone_val else None
        return self.fetchone_val

    def fetchall(self):
        if isinstance(self.fetchall_val, list) and self.fetchall_val and isinstance(self.fetchall_val[0], list):
            return self.fetchall_val.pop(0)
        return self.fetchall_val

    def cursor(self):
        return self

    def executemany(self, sql, seq_of_params):
        self.executed.append((sql, seq_of_params))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class ProjectsServiceDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/projects/buddy_projects/service.py."""

    def test_update_person(self):
        db = DummyDb()
        patch_body = projects_service.PersonPatch(status='leaving', departure_date=date(2026, 12, 31))
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'require_person') as mock_req, \
             patch.object(projects_service, 'directory', return_value=[{'id': 'p1', 'name': 'P1', 'status': 'leaving'}]), \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.update_person('p1', patch_body, user={'username': 'admin'})
            mock_req.assert_called_once_with(db, 'p1')
            mock_evt.assert_called_once()
            self.assertEqual(res['id'], 'p1')

    def test_create_assignment_with_backup_and_validation(self):
        db = DummyDb(fetchone_val={'id': 1, 'project_id': 10, 'person_id': 'p1', 'backup_person_id': 'p2'})
        assignment = projects_service.Assignment(
            project_id=10,
            person_id='p1',
            responsibility='lead development',
            role='contributor',
            backup_person_id='p2',
            allocation=100,
        )
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'require_project') as mock_proj, \
             patch.object(projects_service, 'require_person') as mock_person, \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.create_assignment(assignment, user={'username': 'admin'})
            mock_proj.assert_called_once_with(db, 10)
            self.assertEqual(mock_person.call_count, 2)
            mock_evt.assert_called_once()
            self.assertEqual(res['id'], 1)

    def test_create_and_delete_dependency(self):
        db = DummyDb(fetchone_val={'id': 5, 'source_project_id': 1, 'target_project_id': 2})
        dep = projects_service.Dependency(source_project_id=1, target_project_id=2, description='API dependency')
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'require_project'), \
             patch.object(projects_service, 'event'):
            res = projects_service.create_dependency(dep, user={'username': 'admin'})
            self.assertEqual(res['id'], 5)

        # Self-dependency error
        self_dep = projects_service.Dependency(source_project_id=1, target_project_id=1, description='Loop')
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'require_project'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_dependency(self_dep, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 422)

        # Conflict error when row is None
        db_conflict = DummyDb(fetchone_val=None)
        with patch.object(projects_service, 'connection', return_value=db_conflict), \
             patch.object(projects_service, 'require_project'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_dependency(dep, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 409)

        # Delete dependency
        with patch.object(projects_service, 'delete_entity', return_value={'ok': True}) as mock_del:
            self.assertEqual(projects_service.delete_dependency(5, user={'username': 'admin'}), {'ok': True})
            mock_del.assert_called_once_with('dependencies', 5, {'username': 'admin'})

        # Delete assignment
        with patch.object(projects_service, 'delete_entity', return_value={'ok': True}) as mock_del:
            self.assertEqual(projects_service.delete_assignment(3, user={'username': 'admin'}), {'ok': True})
            mock_del.assert_called_once_with('assignments', 3, {'username': 'admin'})

    def test_delete_entity_not_found(self):
        db = DummyDb(fetchone_val=None)
        with patch.object(projects_service, 'connection', return_value=db):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.delete_entity('assignments', 999, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

    def test_validate_work_milestone_and_deliverable(self):
        db = DummyDb()
        # Milestone without due date
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {'kind': 'milestone', 'due_date': None})
        self.assertEqual(ctx.exception.status_code, 422)

        # Accepted deliverable missing criteria or reviewer
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'deliverable',
                'status': 'accepted',
                'acceptance_criteria': '',
                'reviewer_id': 'rev',
                'acceptance_evidence': 'evidence',
            })
        self.assertEqual(ctx.exception.status_code, 422)

        # Invalid predecessor links (negative or duplicate)
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'task',
                'project_id': 1,
                'predecessor_ids': [-1, 2],
            })
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'task',
                'project_id': 1,
                'predecessor_ids': [2, 2],
            })
        self.assertEqual(ctx.exception.status_code, 422)

        # Relationships referencing missing items
        db.fetchall_val = [[{'id': 2}]]
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'task',
                'project_id': 1,
                'predecessor_ids': [2, 3],
            })
        self.assertEqual(ctx.exception.status_code, 422)

        # Relationships cycle detection
        db.fetchall_val = [[{'id': 2}]]
        db.fetchone_val = {'?column?': 1}
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'task',
                'project_id': 1,
                'predecessor_ids': [2],
            }, item_id=2)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_create_work_item(self):
        db = DummyDb()
        # Project not found
        db.fetchone_val = None
        work = projects_service.WorkItem(
            project_id=1,
            kind='task',
            title='Task 1',
            status='todo',
            priority='medium',
        )
        with patch.object(projects_service, 'connection', return_value=db):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_work_item(work, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

        # Success path
        db.fetchone_val = [
            {'id': 1},  # project update
            {'id': 100},  # insert work_items
            {'id': 100, 'title': 'Task 1', 'project_id': 1},  # work_record
        ]
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'validate_work'), \
             patch.object(projects_service, 'save_predecessors') as mock_pred, \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.create_work_item(work, user={'username': 'admin'})
            mock_pred.assert_called_once_with(db, 100, [])
            mock_evt.assert_called_once()
            self.assertEqual(res['id'], 100)

    def test_update_work_item(self):
        db = DummyDb()
        # Not found
        db.fetchone_val = None
        patch_item = projects_service.WorkItemPatch(expected_revision=1, title='New Title')
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, patch_item, user={'username': 'u1', 'is_admin': False})
            self.assertEqual(ctx.exception.status_code, 404)

        # Non-admin not owner
        original = {'id': 10, 'project_id': 1, 'owner_id': 'u2', 'kind': 'task', 'status': 'todo'}
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', return_value=original):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, patch_item, user={'username': 'u1', 'is_admin': False})
            self.assertEqual(ctx.exception.status_code, 403)

        # Non-admin owner updating forbidden field
        original['owner_id'] = 'u1'
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', return_value=original):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, patch_item, user={'username': 'u1', 'is_admin': False})
            self.assertEqual(ctx.exception.status_code, 403)

        # Invalid status for kind
        bad_status_patch = projects_service.WorkItemPatch(expected_revision=1, status='open')
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', return_value=original), \
             patch.object(projects_service, 'check_revision'), \
             patch.object(projects_service, 'validate_dates'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, bad_status_patch, user={'username': 'admin', 'is_admin': True})
            self.assertEqual(ctx.exception.status_code, 422)

        # Success update with changes
        good_patch = projects_service.WorkItemPatch(expected_revision=1, status='in_progress', predecessor_ids=[5])
        original['predecessor_ids'] = []
        updated_record = {**original, 'status': 'in_progress', 'predecessor_ids': [5]}
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', side_effect=[original, updated_record]), \
             patch.object(projects_service, 'check_revision'), \
             patch.object(projects_service, 'validate_dates'), \
             patch.object(projects_service, 'validate_work'), \
             patch.object(projects_service, '_safe_update', return_value=('UPDATE sql', ())), \
             patch.object(projects_service, 'save_predecessors') as mock_pred, \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.update_work_item(10, good_patch, user={'username': 'admin', 'is_admin': True})
            mock_pred.assert_called_once_with(db, 10, [5])
            mock_evt.assert_called_once()
            self.assertEqual(res['status'], 'in_progress')

    def test_delete_work_item(self):
        db = DummyDb()
        db.fetchone_val = [{'project_id': 1}]  # existing
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.delete_work_item(10, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

        orig = {'id': 10, 'project_id': 1, 'title': 'Item 10', 'predecessor_ids': []}
        affected_orig = {'id': 11, 'project_id': 1, 'parent_id': 10, 'predecessor_ids': [10]}
        affected_after = {'id': 11, 'project_id': 1, 'parent_id': None, 'predecessor_ids': []}
        db.fetchall_val = [[{'id': 11}]]
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'work_record', side_effect=[orig, affected_orig, affected_after]), \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.delete_work_item(10, user={'username': 'admin'})
            self.assertEqual(res, {'ok': True})
            self.assertEqual(mock_evt.call_count, 2)

    def test_create_stage_approval(self):
        db = DummyDb()
        # Project not found
        db.fetchone_val = None
        approval = projects_service.StageApproval(
            expected_revision=1,
            stage='planning',
            approver_id='appr1',
            decision='approved',
            evidence='Signed charter',
        )
        with patch.object(projects_service, 'connection', return_value=db):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_stage_approval(1, approval, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

        # Stage mismatch
        proj_row = {'id': 1, 'revision': 1, 'stage': 'initiation'}
        db.fetchone_val = [proj_row]
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'check_revision'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_stage_approval(1, approval, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 422)

        # Evidence empty
        approval.stage = 'initiation'
        approval.evidence = '   '
        db.fetchone_val = [proj_row]
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'check_revision'), \
             patch.object(projects_service, 'require_person'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_stage_approval(1, approval, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 422)

        # Success
        approval.evidence = 'Signed document'
        db.fetchone_val = [
            proj_row,
            {'id': 10, 'project_id': 1, 'stage': 'initiation', 'decision': 'approved', 'evidence': 'Signed document'},
        ]
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'check_revision'), \
             patch.object(projects_service, 'require_person'), \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.create_stage_approval(1, approval, user={'username': 'admin'})
            mock_evt.assert_called_once()
            self.assertEqual(res['id'], 10)

    def test_preview_and_apply_impact(self):
        db = DummyDb()
        change = projects_service.Change(
            kind='person_departure',
            person_id='p1',
            departure_date=date(2026, 12, 1),
            status='leaving',
        )
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'validate_change'), \
             patch.object(projects_service, 'snapshot', return_value={'projects': [], 'people': []}), \
             patch.object(projects_service, 'analyze', return_value={'items': []}):
            res = projects_service.preview(change, user={'username': 'admin'})
            self.assertEqual(res, {'items': []})

        # Apply project change not found
        proj_change = projects_service.Change(
            kind='project_change',
            project_id=1,
            expected_revision=1,
            status='planned',
        )
        db.fetchone_val = None
        with patch.object(projects_service, 'connection', return_value=db):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.apply(proj_change, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

        # Apply project change success with update
        db.fetchone_val = [{'id': 1, 'revision': 1}]
        snapshot_data = {
            'projects': [{'id': 1, 'status': 'active', 'tolerance_days': 0}],
            'people': [],
        }
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'check_revision'), \
             patch.object(projects_service, 'validate_change'), \
             patch.object(projects_service, 'snapshot', side_effect=[snapshot_data, snapshot_data]), \
             patch.object(projects_service, 'analyze', return_value={'items': []}), \
             patch.object(projects_service, '_safe_update', return_value=('UPDATE sql', ())), \
             patch.object(projects_service, 'event') as mock_evt:
            res = projects_service.apply(proj_change, user={'username': 'admin'})
            self.assertIn('impact', res)
            self.assertEqual(mock_evt.call_count, 2)

    def test_context_filtering(self):
        db = DummyDb()
        portfolio_snapshot = {
            'projects': [{'id': 1, 'name': 'P1'}, {'id': 2, 'name': 'P2'}],
            'stage_approvals': [{'project_id': 1, 'approver_id': 'u1', 'actor': 'u2'}],
            'assignments': [{'project_id': 1, 'person_id': 'u1', 'backup_person_id': None}],
            'work_items': [{'project_id': 1, 'owner_id': 'u1', 'reviewer_id': 'u2'}],
            'dependencies': [{'source_project_id': 1, 'target_project_id': 2}],
            'impact': {'items': [{'project_id': 1, 'level': 'confirmed'}], 'summary': {}},
            'recent_change_impacts': [{'project_id': 1, 'impact': {'items': [{'project_id': 1, 'level': 'risk'}]}}],
            'people': [{'id': 'u1'}, {'id': 'u2'}, {'id': 'u3'}],
            'events': [{'id': 1}],
        }
        with patch.object(projects_service, 'connection', return_value=db), \
             patch.object(projects_service, 'snapshot', return_value=portfolio_snapshot):
            # Non-existent project
            with self.assertRaises(HTTPException) as ctx:
                projects_service.context(project_id=999, user={'username': 'admin'})
            self.assertEqual(ctx.exception.status_code, 404)

            # Filtered project context
            res = projects_service.context(project_id=1, user={'username': 'admin'})
            self.assertEqual(len(res['portfolio']['projects']), 1)
            self.assertEqual(res['portfolio']['projects'][0]['id'], 1)
            self.assertNotIn('events', res['portfolio'])
            self.assertEqual(res['portfolio']['impact']['summary']['confirmed'], 1)

    def test_agent_context_endpoint(self):
        async def run():
            request = MagicMock(spec=Request)
            async def mock_stream():
                yield b'{"project_id": 1}'
            request.stream = mock_stream
            request.headers = {'authorization': 'Bearer token'}
            with patch('app.app_agent_capabilities.verify', return_value='agent_user'), \
                 patch('app.app_agents.user_record', return_value={'username': 'agent_user'}), \
                 patch('app.project_agent_access.require_reader'), \
                 patch.object(projects_service, 'context', return_value={'portfolio': {}}) as mock_ctx:
                res = await projects_service.agent_context(request)
                self.assertEqual(res, {'portfolio': {}})
                mock_ctx.assert_called_once_with(1, {'username': 'agent_user'})

            # Payload too large
            big_request = MagicMock(spec=Request)
            async def mock_big_stream():
                yield b'x' * 2000
            big_request.stream = mock_big_stream
            with self.assertRaises(HTTPException) as ctx:
                await projects_service.agent_context(big_request)
            self.assertEqual(ctx.exception.status_code, 413)

        asyncio.run(run())


class OfficeServiceDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/office/buddy_office/office.py."""

    def test_ensure_schema_execution(self):
        db = DummyDb()
        office_service._schema_urls.clear()
        with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://test:test@localhost/testdb'}), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch('buddy_office.office_folders.migrate') as mock_mig:
            office_service.ensure_schema()
            self.assertTrue(any('CREATE SCHEMA IF NOT EXISTS "office"' in sql for sql, _ in db.executed))
            self.assertTrue(any('CREATE TABLE IF NOT EXISTS office.bob_office_files' in sql for sql, _ in db.executed))
            mock_mig.assert_called_once_with(db)
            self.assertIn('postgresql://test:test@localhost/testdb', office_service._schema_urls)

    def test_status_endpoint(self):
        user = {'username': 'alice'}
        # Healthcheck not ok
        mock_http = MagicMock()
        mock_http.get.return_value = MagicMock(text='false', raise_for_status=MagicMock())
        mock_http.__enter__.return_value = mock_http
        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'secret', return_value='secret'), \
             patch('httpx.Client', return_value=mock_http):
            with self.assertRaises(HTTPException) as ctx:
                office_service.status(user=user)
            self.assertEqual(ctx.exception.status_code, 503)

        # S3 error
        mock_http.get.return_value = MagicMock(text='true', raise_for_status=MagicMock())
        mock_s3 = MagicMock()
        mock_s3.list_objects_v2.side_effect = RuntimeError('S3 down')
        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'secret', return_value='secret'), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch('httpx.Client', return_value=mock_http), \
             patch.object(office_service, 's3', return_value=mock_s3):
            with self.assertRaises(HTTPException) as ctx:
                office_service.status(user=user)
            self.assertEqual(ctx.exception.status_code, 503)

        # Success
        mock_s3.list_objects_v2.side_effect = None
        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'secret', return_value='secret'), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch('httpx.Client', return_value=mock_http), \
             patch.object(office_service, 's3', return_value=mock_s3):
            res = office_service.status(user=user)
            self.assertTrue(res['ready'])

    def test_files_and_file_info_endpoints(self):
        user = {'username': 'alice'}
        fid = uuid4()
        now = datetime.now(timezone.utc)
        file_row = {
            'id': fid, 'username': 'alice', 'name': 'Doc.docx', 'extension': 'docx',
            'object_key': 'key', 'size': 100, 'sha256': 'hash', 'revision': 1,
            'save_sequence': 0, 'created_at': now, 'saved_at': now, 'folder_id': None, 'access': 'owner',
            'is_owner': True, 'owner_display': 'Alice', 'share_count': 0,
        }
        db = DummyDb(fetchall_val=[[file_row]], fetchone_val=[file_row, {'last_error': None, 'last_receipt': 'r1'}])
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db):
            res = office_service.files(user=user)
            self.assertEqual(len(res['items']), 1)
            self.assertEqual(res['items'][0]['id'], str(fid))

            info_res = office_service.file_info(fid, user=user)
            self.assertEqual(info_res['id'], str(fid))
            self.assertEqual(info_res['save_receipt'], 'r1')

    def test_delete_file_endpoint(self):
        user = {'username': 'alice'}
        fid = uuid4()
        file_row = {'id': fid, 'username': 'alice'}
        db = DummyDb(fetchone_val=file_row)
        mock_s3 = MagicMock()
        mock_s3.list_objects_v2.return_value = {'Contents': [{'Key': 'users/alice/office/f1/file'}]}
        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, '_file', return_value=file_row), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(office_service, 's3', return_value=mock_s3):
            res = office_service.delete_file(fid, user=user)
            self.assertTrue(res['deleted'])
            mock_s3.delete_object.assert_called_once_with(Bucket='test-bucket', Key='users/alice/office/f1/file')

    def test_office_users_and_shares(self):
        user = {'username': 'alice'}
        fid = uuid4()
        db = DummyDb(fetchall_val=[[{'username': 'bob', 'display_name': 'Bob', 'email': 'bob@test.org', 'online': True}]])
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db):
            res = office_service.office_users(user=user)
            self.assertEqual(res['items'][0]['username'], 'bob')

        # Share to self error
        req = office_service.ShareRequest(username='alice', permission='read')
        with patch.object(office_service, 'ensure_schema'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.set_share(fid, req, user=user)
            self.assertEqual(ctx.exception.status_code, 422)

        # Share user not found
        req.username = 'unknown'
        db_not_found = DummyDb(fetchone_val=None)
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_not_found), \
             patch.object(office_service, '_file'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.set_share(fid, req, user=user)
            self.assertEqual(ctx.exception.status_code, 404)

        # Share success & remove share
        share_rows = [{'username': 'bob', 'permission': 'read', 'created_at': '2026-01-01', 'display_name': 'Bob', 'email': 'bob@test.org', 'online': True}]
        db_success = DummyDb(fetchone_val={'1': 1}, fetchall_val=[share_rows, share_rows])
        req.username = 'bob'
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_success), \
             patch.object(office_service, '_file'):
            shares = office_service.set_share(fid, req, user=user)
            self.assertEqual(shares['items'][0]['username'], 'bob')

            shares_del = office_service.remove_share(fid, 'bob', user=user)
            self.assertEqual(len(shares_del['items']), 1)

    def test_upload_endpoint(self):
        async def run():
            user = {'username': 'alice'}
            mock_upload = MagicMock()
            mock_upload.filename = 'document.docx'
            mock_upload.read = AsyncMock(side_effect=[b'x' * 1024, b''])
            mock_upload.close = AsyncMock()

            with patch.object(office_service, 'store_new', return_value={'id': 'f1'}) as mock_store:
                res = await office_service.upload(mock_upload, user=user)
                self.assertEqual(res, {'id': 'f1'})
                mock_store.assert_called_once_with('alice', 'document.docx', b'x' * 1024)

            # Too large
            mock_upload_big = MagicMock()
            mock_upload_big.filename = 'big.docx'
            mock_upload_big.read = AsyncMock(side_effect=[b'x' * (51 * 1024 * 1024), b''])
            mock_upload_big.close = AsyncMock()
            with self.assertRaises(HTTPException) as ctx:
                await office_service.upload(mock_upload_big, user=user)
            self.assertEqual(ctx.exception.status_code, 413)

        asyncio.run(run())

    def test_convert_csv(self):
        mock_http = MagicMock()
        mock_http.post.return_value = MagicMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={'endConvert': True, 'fileUrl': 'http://editor/saved.csv'}),
        )
        mock_http.__enter__.return_value = mock_http
        with patch.object(office_service, 'secret', return_value='secret-key-that-is-at-least-32-bytes-long!'), \
             patch.object(office_service, 'internal_url', return_value='http://editor'), \
             patch.object(office_service, 'output_url', return_value='http://storage/saved.xlsx'), \
             patch.object(office_service, 'saved_content', return_value=b'a,b\n1,2'), \
             patch('httpx.Client', return_value=mock_http):
            res = office_service.convert_csv('http://storage/saved.xlsx', b'a,b\n1,2')
            self.assertEqual(res, b'a,b\n1,2')

        # Error branch
        mock_http.post.return_value.json.return_value = {'error': 1}
        with patch.object(office_service, 'secret', return_value='secret-key-that-is-at-least-32-bytes-long!'), \
             patch.object(office_service, 'internal_url', return_value='http://editor'), \
             patch.object(office_service, 'output_url', return_value='http://storage/saved.xlsx'), \
             patch('httpx.Client', return_value=mock_http):
            with self.assertRaises(ValueError):
                office_service.convert_csv('http://storage/saved.xlsx', b'a,b\n1,2')

    def test_handle_callback_states(self):
        sid = uuid4()
        fid = uuid4()
        session_row = {'id': sid, 'file_id': fid, 'active': True}
        file_row = {
            'id': fid, 'username': 'alice', 'name': 'sheet.xlsx', 'extension': 'xlsx',
            'object_key': 'obj_key', 'size': 100, 'sha256': 'old_hash', 'revision': 1,
        }
        # Inactive session
        inactive_session = {'id': sid, 'active': False}
        db = DummyDb(fetchone_val=inactive_session)
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db):
            res = office_service.handle_callback({'key': str(sid), 'status': 2})
            self.assertEqual(res, {'error': 0})

        # Save state (status = 2)
        db_save = DummyDb(fetchone_val=[session_row, file_row])
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_save), \
             patch.object(office_service, 'saved_content', return_value=b'new_content'), \
             patch.object(office_service, 'validate_content'), \
             patch.object(office_service, 'put'):
            res = office_service.handle_callback({'key': str(sid), 'status': 2, 'url': 'http://editor/file'})
            self.assertEqual(res, {'error': 0})

        # Error state (status = 3)
        db_err = DummyDb(fetchone_val=session_row)
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_err):
            res = office_service.handle_callback({'key': str(sid), 'status': 3})
            self.assertEqual(res, {'error': 0})

        # Exception handled
        db_exc = DummyDb()
        db_exc.fetchone = MagicMock(side_effect=RuntimeError('DB crash'))
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_exc):
            res = office_service.handle_callback({'key': str(sid), 'status': 2})
            self.assertEqual(res, {'error': 1})

    def test_force_save_endpoint(self):
        user = {'username': 'alice'}
        fid = uuid4()
        sid = uuid4()
        # No session -> 409
        db_no_sess = DummyDb(fetchone_val=None)
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_no_sess), \
             patch.object(office_service, '_file', return_value={'revision': 1}):
            with self.assertRaises(HTTPException) as ctx:
                office_service.force_save(fid, user=user)
            self.assertEqual(ctx.exception.status_code, 409)

        # Editor unreachable -> 502
        import httpx
        db_sess = DummyDb(fetchone_val={'id': sid})
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_sess), \
             patch.object(office_service, '_file', return_value={'revision': 1}), \
             patch.object(office_service, 'secret', return_value='secret-key-that-is-at-least-32-bytes-long!'), \
             patch('httpx.Client.post', side_effect=httpx.HTTPError('timeout')):
            with self.assertRaises(HTTPException) as ctx:
                office_service.force_save(fid, user=user)
            self.assertEqual(ctx.exception.status_code, 502)

        # Editor returns error != 0, 4 -> 502
        mock_resp = MagicMock(raise_for_status=MagicMock(), json=MagicMock(return_value={'error': 1}))
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_sess), \
             patch.object(office_service, '_file', return_value={'revision': 1}), \
             patch.object(office_service, 'secret', return_value='secret-key-that-is-at-least-32-bytes-long!'), \
             patch('httpx.Client.post', return_value=mock_resp):
            with self.assertRaises(HTTPException) as ctx:
                office_service.force_save(fid, user=user)
            self.assertEqual(ctx.exception.status_code, 502)

        # Success
        mock_resp.json.return_value = {'error': 0}
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db_sess), \
             patch.object(office_service, '_file', return_value={'revision': 1}), \
             patch.object(office_service, 'secret', return_value='secret-key-that-is-at-least-32-bytes-long!'), \
             patch('httpx.Client.post', return_value=mock_resp):
            res = office_service.force_save(fid, user=user)
            self.assertTrue(res['pending'])


class OfficeChatDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/office/buddy_office/office_chat.py."""

    def test_visible_text_parser(self):
        parser = office_chat.VisibleText()
        parser.feed('<html><head><style>body { color: red; }</style></head><body><h1>Title</h1><p>Content</p><script>alert(1);</script></body></html>')
        self.assertEqual(parser.parts, ['Title', 'Content'])

        # SnapshotLimit raised on max text
        with patch.object(office_chat, 'MAX_TEXT', 10):
            lim_parser = office_chat.VisibleText()
            with self.assertRaises(office_chat.SnapshotLimit):
                lim_parser.feed('<div>This is way too long to fit in 10 characters</div>')

    def test_extract_snapshot_docx_pdf_csv(self):
        # CSV
        csv_bytes = b'header1,header2\nval1,val2'
        res = office_chat.extract_snapshot('csv', csv_bytes)
        self.assertIn('header1 | header2', res['text'])
        self.assertIn('val1 | val2', res['text'])
        self.assertFalse(res['truncated'])

        # DOCX / PDF mock
        with patch('app.document_comparison.extract_document', return_value=[('p1', 'Hello world')]):
            doc_res = office_chat.extract_snapshot('docx', b'fake docx')
            self.assertIn('[p1] Hello world', doc_res['text'])

        # HTML
        html_bytes = b'<div>First section</div><div>Second section</div>'
        html_res = office_chat.extract_snapshot('html', html_bytes)
        self.assertIn('[text 1] First section', html_res['text'])
        self.assertIn('[text 2] Second section', html_res['text'])

    def test_extract_snapshot_pptx(self):
        # Build minimal PPTX zip
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Slide 1 text</a:t></a:r></a:p></p:sld>')
            zf.writestr('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>')
            zf.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>')
        raw = buf.getvalue()

        res = office_chat.extract_snapshot('pptx', raw)
        self.assertIn('[slide 1] Slide 1 text', res['text'])

        # Invalid slide relationship
        buf_bad = io.BytesIO()
        with zipfile.ZipFile(buf_bad, 'w') as zf:
            zf.writestr('ppt/slides/slide1.xml', '<slide/>')
            zf.writestr('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>')
            zf.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/missing.xml"/></Relationships>')
        with self.assertRaises(ValueError):
            office_chat.extract_snapshot('pptx', buf_bad.getvalue())

    def test_extract_snapshot_xlsx(self):
        mock_sheet = MagicMock()
        mock_sheet.title = 'Sheet1'
        mock_sheet.max_column = 2
        mock_sheet.iter_rows.return_value = [('Col1', 'Col2'), ('Val1', 'Val2')]
        mock_book = [mock_sheet]
        mock_book_obj = MagicMock(__iter__=lambda s: iter(mock_book), close=MagicMock())

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('xl/workbook.xml', '<workbook/>')
        raw = buf.getvalue()

        with patch('openpyxl.load_workbook', return_value=mock_book_obj):
            res = office_chat.extract_snapshot('xlsx', raw)
            self.assertIn('[Sheet1, row 1] Col1 | Col2', res['text'])
            self.assertIn('[Sheet1, row 2] Val1 | Val2', res['text'])

    def test_extract_snapshot_limits_and_errors(self):
        # File too large
        with self.assertRaises(ValueError):
            office_chat.extract_snapshot('docx', b'x' * (21 * 1024 * 1024))

        # Unsupported type
        with self.assertRaises(ValueError):
            office_chat.extract_snapshot('unknown', b'data')

        # Empty text
        with self.assertRaises(ValueError):
            office_chat.extract_snapshot('csv', b'')

    def test_extract_child_and_bounded_snapshot(self):
        mock_conn = MagicMock()
        with patch('resource.setrlimit'), \
             patch('buddy_office.office_chat.extract_snapshot', return_value={'text': 'sample', 'truncated': False}):
            office_chat._extract_child(mock_conn, 'csv', b'a,b')
            mock_conn.send.assert_called_once_with((True, {'text': 'sample', 'truncated': False}))
            mock_conn.close.assert_called_once()

        # Exception branch
        mock_conn_err = MagicMock()
        with patch('resource.setrlimit'), \
             patch('buddy_office.office_chat.extract_snapshot', side_effect=RuntimeError('Crash')):
            office_chat._extract_child(mock_conn_err, 'csv', b'a,b')
            mock_conn_err.send.assert_called_once_with((False, None))

        # bounded_snapshot success
        mock_recv = MagicMock()
        mock_recv.poll.return_value = True
        mock_recv.recv.return_value = (True, {'text': 'bounded'})
        mock_proc = MagicMock(pid=123, is_alive=MagicMock(return_value=False))
        mock_ctx = MagicMock()
        mock_ctx.Pipe.return_value = (mock_recv, MagicMock())
        mock_ctx.Process.return_value = mock_proc
        with patch('multiprocessing.get_context', return_value=mock_ctx):
            res = office_chat.bounded_snapshot('csv', b'data')
            self.assertEqual(res, {'text': 'bounded'})

        # bounded_snapshot timeout
        mock_recv.poll.return_value = False
        with patch('multiprocessing.get_context', return_value=mock_ctx):
            with self.assertRaises(ValueError):
                office_chat.bounded_snapshot('csv', b'data')

    def test_chat_context(self):
        fid = uuid4()
        row = {
            'id': fid, 'username': 'alice', 'name': 'test.docx',
            'extension': 'docx', 'object_key': 'key', 'size': 100, 'revision': 1,
        }
        db = DummyDb()
        with patch('buddy_office.office.require_storage'), \
             patch('buddy_office.office.ensure_schema'), \
             patch('buddy_office.office.job_queue._connect', return_value=db), \
             patch('buddy_office.office._file', return_value=row), \
             patch('buddy_office.office.read', return_value=b'docx_bytes'), \
             patch.object(office_chat, 'bounded_snapshot', return_value={'text': 'Document text', 'truncated': False}):
            text, summary = office_chat.chat_context('alice', [fid])
            self.assertIn('Document text', text)
            self.assertEqual(summary[0]['name'], 'test.docx')

        # Size too large in row
        row_big = {**row, 'size': 25 * 1024 * 1024}
        with patch('buddy_office.office.require_storage'), \
             patch('buddy_office.office.ensure_schema'), \
             patch('buddy_office.office.job_queue._connect', return_value=db), \
             patch('buddy_office.office._file', return_value=row_big):
            with self.assertRaises(HTTPException) as ctx:
                office_chat.chat_context('alice', [fid])
            self.assertEqual(ctx.exception.status_code, 413)

        # Bounded snapshot error wraps in 422
        with patch('buddy_office.office.require_storage'), \
             patch('buddy_office.office.ensure_schema'), \
             patch('buddy_office.office.job_queue._connect', return_value=db), \
             patch('buddy_office.office._file', return_value=row), \
             patch('buddy_office.office.read', return_value=b'docx_bytes'), \
             patch.object(office_chat, 'bounded_snapshot', side_effect=RuntimeError('Parse error')):
            with self.assertRaises(HTTPException) as ctx:
                office_chat.chat_context('alice', [fid])
            self.assertEqual(ctx.exception.status_code, 422)


class RagDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/rag.py."""

    def test_ensure_schema(self):
        db = DummyDb()
        rag._schema_ready = False
        with patch.object(rag.job_queue, '_connect', return_value=db), \
             patch('app.blob_storage.schema') as mock_blob_schema:
            rag.ensure_schema()
            self.assertTrue(rag._schema_ready)
            self.assertTrue(any('CREATE TABLE IF NOT EXISTS bob_knowledge_documents' in sql for sql, _ in db.executed))
            mock_blob_schema.assert_called_once()

    def test_list_and_preview_documents(self):
        doc = {
            'id': uuid4(), 'filename': 'guide.txt', 'description': 'User guide',
            'username': 'alice', 'status': 'ready', 'error': None, 'chunk_count': 5,
            'created_at': datetime.now(timezone.utc), 'knowledge_base': 'company',
            'audience': 'both', 'owner': 'alice', 'review_due': None, 'reviewed_at': None,
            'size': 100,
        }
        db = DummyDb(fetchall_val=[[doc], [doc]])
        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, 'access_filter', return_value=('TRUE', ())), \
             patch.object(rag.job_queue, '_connect', return_value=db):
            docs = rag.list_documents('alice')
            self.assertEqual(len(docs), 1)
            self.assertEqual(docs[0]['filename'], 'guide.txt')

        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, 'profile_access_filter', return_value=('TRUE', ())), \
             patch.object(rag.job_queue, '_connect', return_value=db):
            preview = rag.preview_documents({'is_admin': True})
            self.assertEqual(len(preview), 1)

    def test_add_and_replace_document(self):
        # Suffix validation
        with patch.object(rag, 'require_admin'):
            with self.assertRaises(ValueError):
                rag.add_document('admin', 'shared', 'bad.exe', b'content', admin=True)

        # Empty content
        with patch.object(rag, 'require_admin'):
            with self.assertRaises(ValueError):
                rag.add_document('admin', 'shared', 'file.txt', b'', admin=True)

        doc_row = {
            'id': uuid4(), 'filename': 'doc.txt', 'username': 'admin', 'status': 'queued',
            'description': 'desc', 'knowledge_base': 'company', 'audience': 'both',
            'created_at': datetime.now(timezone.utc), 'owner': '', 'review_due': None,
            'reviewed_at': None, 'chunk_count': 0, 'error': None, 'size': 10,
        }
        db = DummyDb(fetchone_val=[None, {'n': 10}, doc_row])
        with patch.object(rag, 'require_admin'), \
             patch.object(rag, 'ensure_schema'), \
             patch.object(rag.job_queue, '_connect', return_value=db), \
             patch('app.blob_storage.store', return_value={'content': b'blob', 'object_key': 'key', 'object_bucket': 'b', 'size': 10}):
            res = rag.add_document('admin', 'shared', 'doc.txt', b'content', description='desc', admin=True)
            self.assertEqual(res['filename'], 'doc.txt')

        # Replace document
        db_rep = DummyDb(fetchone_val=[doc_row, None, doc_row])
        with patch.object(rag, 'require_admin'), \
             patch.object(rag, 'ensure_schema'), \
             patch.object(rag.job_queue, '_connect', return_value=db_rep), \
             patch('app.blob_storage.store', return_value={'content': b'blob', 'object_key': 'key', 'object_bucket': 'b', 'size': 10}):
            rep_res = rag.replace_document('admin', 'shared', str(doc_row['id']), 'doc2.txt', b'new content', admin=True)
            self.assertEqual(rep_res['filename'], 'doc.txt')

    def test_get_and_remove_and_retry_document(self):
        fid = uuid4()
        doc = {'id': fid, 'filename': 'doc.txt', 'visibility': 'shared', 'content': b'encrypted'}
        db = DummyDb(fetchone_val=doc)
        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, 'access_filter', return_value=('TRUE', ())), \
             patch.object(rag.job_queue, '_connect', return_value=db), \
             patch('app.blob_storage.read', return_value=b'decrypted'):
            res = rag.get_document('alice', 'shared', str(fid))
            self.assertEqual(res['content'], b'decrypted')

        # Remove document
        db_del = DummyDb(fetchone_val={'id': fid})
        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, '_manage_document', return_value=doc), \
             patch.object(rag.job_queue, '_connect', return_value=db_del):
            self.assertTrue(rag.remove_document('admin', 'shared', str(fid), admin=True))

        # Retry document
        db_retry = DummyDb(fetchone_val={'id': fid})
        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, '_manage_document', return_value=doc), \
             patch.object(rag.job_queue, '_connect', return_value=db_retry):
            self.assertTrue(rag.retry_document('admin', 'shared', str(fid), admin=True))

    def test_update_classification_and_freshness(self):
        fid = uuid4()
        doc = {
            'id': fid, 'username': 'admin', 'sha256': 'abc', 'knowledge_base': 'company', 'audience': 'both',
            'filename': 'f.txt', 'status': 'ready', 'created_at': datetime.now(timezone.utc),
            'owner': 'admin', 'review_due': None, 'reviewed_at': None, 'chunk_count': 1, 'error': None, 'size': 10,
            'description': '',
        }
        db = DummyDb(fetchone_val=[doc, None, doc])
        with patch.object(rag, 'require_admin'), \
             patch.object(rag, 'ensure_schema'), \
             patch.object(rag.job_queue, '_connect', return_value=db), \
             patch('app.auth.valid_audience', return_value=True):
            res = rag.update_classification('admin', 'shared', str(fid), 'company', 'group-id', admin=True)
            self.assertEqual(res['filename'], 'f.txt')

        # Update freshness
        db_fresh = DummyDb(fetchone_val=[doc, doc])
        with patch.object(rag, 'require_admin'), \
             patch.object(rag, 'ensure_schema'), \
             patch.object(rag.job_queue, '_connect', return_value=db_fresh):
            fresh_res = rag.update_freshness('admin', 'shared', str(fid), 'owner1', '2026-11-01', reviewed=True, admin=True)
            self.assertEqual(fresh_res['filename'], 'f.txt')

        # Invalid date
        with patch.object(rag, 'require_admin'):
            with self.assertRaises(ValueError):
                rag.update_freshness('admin', 'shared', str(fid), 'owner1', 'invalid-date', admin=True)

    def test_extract_various_formats(self):
        # CSV and TSV
        csv_sections = rag.extract('data.csv', b'Name,Score\nAlice,100\nBob,90')
        self.assertEqual(len(csv_sections), 2)
        self.assertIn('Name: Alice; Score: 100', csv_sections[0][1])

        tsv_sections = rag.extract('data.tsv', b'Name\tScore\nAlice\t100')
        self.assertEqual(len(tsv_sections), 1)

        # PDF encrypted mock
        mock_pdf = MagicMock(is_encrypted=True)
        with patch('pypdf.PdfReader', return_value=mock_pdf):
            with self.assertRaises(ValueError):
                rag.extract('protected.pdf', b'%PDF...')

        # PDF page limit mock
        mock_pdf_long = MagicMock(is_encrypted=False, pages=[1] * 501)
        with patch('pypdf.PdfReader', return_value=mock_pdf_long):
            with self.assertRaises(ValueError):
                rag.extract('long.pdf', b'%PDF...')

        # DOCX limit
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('word/document.xml', 'x' * (11 * 1024 * 1024))
        with self.assertRaises(ValueError):
            rag.extract('big.docx', buf.getvalue())

    def test_save_and_fail_index(self):
        doc = {'id': uuid4(), 'worker_token': uuid4()}
        chunks = [{'location': 'p1', 'text': 'content', 'embedding': [0.1, 0.2]}]
        db = DummyDb(fetchone_val=[{'id': doc['id']}, {'n': 10}])
        with patch.object(rag.job_queue, '_connect', return_value=db):
            rag.save_index(doc, chunks, 'digest123', 'prepared')
            self.assertTrue(any('UPDATE bob_knowledge_documents SET status=\'ready\'' in sql for sql, _ in db.executed))

        # Max library chunks exceeded
        db_exceeded = DummyDb(fetchone_val=[{'id': doc['id']}, {'n': 5000}])
        with patch.object(rag.job_queue, '_connect', return_value=db_exceeded):
            with self.assertRaises(ValueError):
                rag.save_index(doc, chunks, 'digest123', 'prepared')

        # Fail index
        db_fail = DummyDb()
        with patch.object(rag.job_queue, '_connect', return_value=db_fail):
            rag.fail_index(doc, 'Index error')
            self.assertTrue(any('status=\'failed\'' in sql for sql, _ in db_fail.executed))

    def test_citation_preview_and_attach_context(self):
        fid = uuid4()
        cid = uuid4()
        citation_row = {'location': 'p1', 'text': 'Source sentence.'}
        db = DummyDb(
            fetchone_val={'filename': 'doc.txt'},
            fetchall_val=[[citation_row], [citation_row], [citation_row]],
        )
        with patch.object(rag, 'ensure_schema'), \
             patch.object(rag, 'access_filter', return_value=('TRUE', ())), \
             patch.object(rag.job_queue, '_connect', return_value=db):
            # Exact match
            preview = rag.citation_preview('alice', 'shared', str(fid), str(cid), 'Source sentence.')
            self.assertTrue(preview['exact'])
            self.assertEqual(preview['passages'][0]['text'], 'Source sentence.')

            # No quote
            no_quote = rag.citation_preview('alice', 'shared', str(fid), str(cid), None)
            self.assertFalse(no_quote['exact'])

            # No citation id
            no_cid = rag.citation_preview('alice', 'shared', str(fid), None, None)
            self.assertFalse(no_cid['exact'])

            # Mismatched quote raises ValueError
            with self.assertRaises(ValueError):
                rag.citation_preview('alice', 'shared', str(fid), str(cid), 'Completely different claim.')

        # attach_context
        prompt = rag.attach_context('Original prompt', [], 'ws')
        self.assertEqual(prompt, 'Original prompt')

        passages = [{
            'id': fid, 'ordinal': 0, 'filename': 'doc.txt', 'location': 'p1',
            'citation_id': str(cid), 'text': 'Passage text',
        }]
        attached = rag.attach_context('Original prompt', passages, 'ws')
        self.assertIn('Retrieved knowledge passages', attached)
        self.assertIn(f'?citation={cid}', attached)


class WorkerDeepCoverageTests(unittest.IsolatedAsyncioTestCase):
    """Deep coverage for app/worker.py."""

    def test_complete_html_deck_and_restore(self):
        with patch('pathlib.Path.is_file', return_value=False):
            self.assertFalse(worker._complete_html_deck(Path('missing.html')))

        # File exists and contains presentation html
        mock_path = MagicMock(spec=Path)
        mock_path.is_file.return_value = True
        mock_path.read_text.return_value = '<html><body>Presentation content</body></html>'
        with patch('app.presentation.artifact_role', return_value={'is_presentation': True}):
            self.assertTrue(worker._complete_html_deck(mock_path))

        # Restore incomplete html
        with patch.object(worker, '_complete_html_deck', return_value=False):
            self.assertTrue(worker._restore_incomplete_html(mock_path, b'original html'))
            mock_path.write_bytes.assert_called_once_with(b'original html')

    async def test_heartbeat_and_watch_cancel_errors(self):
        task = MagicMock()
        # Exception during heartbeat handles gracefully
        with patch.object(worker.asyncio, 'sleep', AsyncMock(side_effect=[None, asyncio.CancelledError])), \
             patch.object(worker.job_queue, 'heartbeat', side_effect=RuntimeError('DB lost')):
            with self.assertRaises(asyncio.CancelledError):
                await worker._heartbeat('j1', 't1', task)

        # Exception during watch cancel handles gracefully
        task.done.side_effect = [False, False, True]
        with patch.object(worker.asyncio, 'sleep', AsyncMock()), \
             patch.object(worker.job_queue, 'cancellation_requested', side_effect=RuntimeError('Err')):
            await worker._watch_cancel('j1', task)

    async def test_run_emit_approval_and_scaffold(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'html_artifact_output_path': 'dashboard.html',
                'prompt': 'Create dashboard',
                'approval_policy': {'mode': 'default'},
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        mock_scaffold = MagicMock()
        mock_scaffold.exists.return_value = True
        mock_ws.__truediv__.return_value = mock_scaffold

        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch.object(worker.storage, 'validate_path'), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            with self.assertRaises(RuntimeError) as ctx:
                await worker._run(job)
            self.assertIn('Dashboard output already exists', str(ctx.exception))

    async def test_run_selected_approval_with_agent_name_rejected(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'agent_name': 'remote_agent',
                'approval_policy': {'mode': 'selected'},
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            with self.assertRaises(RuntimeError) as ctx:
                await worker._run(job)
            self.assertIn('Remote agents cannot enforce selected approvals', str(ctx.exception))

    async def test_run_agent_name_execution_flow(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'agent_name': 'agent_1',
                'prompt': 'Ask something',
                'approval_policy': {'mode': 'default'},
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.record_event = AsyncMock(return_value=True)
        mock_recorder.finish = AsyncMock()
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        agent_config = {
            'name': 'Agent 1', 'slug': 'agent_1', 'endpoint': 'http://localhost:3000/a2a', 'enabled': True,
        }

        async def dummy_a2a_stream(*args, **kwargs):
            yield {'type': 'delta', 'text': 'Part 1'}
            yield {'type': 'a2a_result', 'text': 'Full answer', 'context_id': 'ctx1'}

        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch('app.agent_budget.RunBudget.consume', AsyncMock()), \
             patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder), \
             patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)), \
             patch.object(worker, 'get_agent', return_value=agent_config), \
             patch('app.execution_policy.ExecutionAuthorizer.authorize', AsyncMock()), \
             patch('app.execution_policy.ExecutionAuthorizer.assert_active', AsyncMock()), \
             patch('app.worker.stream_a2a_message', dummy_a2a_stream), \
             patch('app.carbon_chart_assets.package_changed_carbon_html'), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            await worker._run(job)
            mock_recorder.record_event.assert_awaited()
            mock_recorder.finish.assert_awaited()

    async def test_run_skills_limit_and_web_search(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'bob_prompt': 'Prompt',
                'prompt': 'Prompt',
                'mode': 'chat',
                'approval_policy': {'mode': 'default'},
                'skill_names': ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.record_event = AsyncMock(return_value=True)
        mock_recorder.finish = AsyncMock()
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch.object(worker.bridge, 'prewarm_approval'), \
             patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder), \
             patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)), \
             patch('app.personalization.personalize_prompt', return_value='Prompt'), \
             patch('app.workspace_config.ensure_brave_mcp'), \
             patch.object(worker.storage, 'list_files', return_value=[]), \
             patch.object(worker, 'read_history', return_value=[]), \
             patch('app.project_memory.context_for_session', return_value=''), \
             patch('app.conversation_documents.context_manifest', return_value=''), \
             patch('app.worker.list_skills', return_value=[]), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            with self.assertRaises(RuntimeError) as ctx:
                await worker._run(job)
            self.assertIn('Select up to 6 skills', str(ctx.exception))

    async def test_run_bob_prompt_stream_and_finish(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'bob_prompt': 'Hello',
                'prompt': 'Hello',
                'mode': 'chat',
                'approval_policy': {'mode': 'default'},
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        mock_ws.__truediv__.return_value = MagicMock(is_file=MagicMock(return_value=False))
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.record_event = AsyncMock(return_value=True)
        mock_recorder.finish = AsyncMock()
        mock_recorder.correlation = {}
        mock_recorder.activity_secrets = []
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        async def mock_stream(*args, **kwargs):
            yield {'type': 'delta', 'text': 'Hello there!'}
            yield {'type': 'done'}

        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch.object(worker.bridge, 'prewarm_approval'), \
             patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder), \
             patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)), \
             patch('app.personalization.personalize_prompt', return_value='Hello'), \
             patch('app.workspace_config.ensure_brave_mcp'), \
             patch.object(worker.storage, 'list_files', return_value=[]), \
             patch.object(worker, 'read_history', return_value=[]), \
             patch('app.project_memory.context_for_session', return_value=''), \
             patch('app.conversation_documents.context_manifest', return_value=''), \
             patch('app.worker.list_skills', return_value=[]), \
             patch('app.mcp_access.allowed_servers', return_value={}), \
             patch('app.mcp_access.catalog', return_value=[]), \
             patch.object(worker.bridge, 'stream_with_approvals', mock_stream), \
             patch('app.carbon_chart_assets.package_changed_carbon_html'), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            await worker._run(job)
            mock_recorder.finish.assert_awaited_with({'type': 'done'})

    async def test_blob_cleanup_loop_and_main(self):
        with patch('app.postgres_storage.ensure_schema'), \
             patch('app.rag.ensure_schema'), \
             patch('app.blob_storage.collect_garbage', side_effect=RuntimeError('Err')), \
             patch('asyncio.sleep', AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await worker._blob_cleanup_loop()

        # main taskgroup
        mock_tg = MagicMock()
        def fake_create_task(coro):
            coro.close()
            return MagicMock()
        mock_tg.create_task = fake_create_task
        mock_tg.__aenter__ = AsyncMock(return_value=mock_tg)
        mock_tg.__aexit__ = AsyncMock(side_effect=asyncio.CancelledError)
        with patch('asyncio.TaskGroup', return_value=mock_tg), \
             patch('app.plugin_client.enabled', return_value=False):
            with self.assertRaises(asyncio.CancelledError):
                await worker.main()

    async def test_run_web_search_authorization(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'bob_prompt': 'Search query',
                'prompt': 'Search query',
                'mode': 'chat',
                'approval_policy': {'mode': 'default'},
                'workflow': {'web_search': True},
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        mock_ws.__truediv__.return_value = MagicMock(is_file=MagicMock(return_value=False))
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.finish = AsyncMock()
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        # Brave disabled
        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch.object(worker.bridge, 'prewarm_approval'), \
             patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder), \
             patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)), \
             patch('app.personalization.personalize_prompt', return_value='Search query'), \
             patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value={'disabled': True}), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            await worker._run(job)
            mock_recorder.finish.assert_awaited_with({'type': 'error', 'message': 'Web search is not available for your employee groups'})

        # Missing API KEY
        with patch.object(worker.storage, 'job_workspace', mock_job_workspace), \
             patch('app.carbon_chart_assets.carbon_html_versions', return_value={}), \
             patch('app.agent_attachments.selected_agents', return_value=[]), \
             patch.object(worker.bridge, 'prewarm_approval'), \
             patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder), \
             patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)), \
             patch('app.personalization.personalize_prompt', return_value='Search query'), \
             patch('app.workspace_config.ensure_brave_mcp'), \
             patch('app.mcp_access.get_authorized_server', return_value={'disabled': False}), \
             patch.dict(os.environ, {'BRAVE_API_KEY': ''}), \
             patch.object(worker.storage, 'persist_job'), \
             patch.object(worker.bridge, 'release_prepared'):
            await worker._run(job)
            mock_recorder.finish.assert_awaited_with({'type': 'error', 'message': 'Web search requires BRAVE_API_KEY'})

    async def test_run_workflow_hooks_and_intents(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'bob_prompt': 'Hello',
                'prompt': 'quiz questions and note reminder',
                'mode': 'chat',
                'approval_policy': {'mode': 'default'},
                'voice_mode': True,
                'quiz_grading_context': 'Grading test',
                'skill_names': ['quiz-skill'],
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        mock_ws.__truediv__.return_value = MagicMock(is_file=MagicMock(return_value=False))
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.record_event = AsyncMock(return_value=True)
        mock_recorder.finish = AsyncMock()
        mock_recorder.correlation = {}
        mock_recorder.activity_secrets = []
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        async def mock_stream(*args, **kwargs):
            yield {'type': 'delta', 'text': 'Quiz review answer'}
            yield {'type': 'done'}

        import contextlib
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(worker.storage, 'job_workspace', mock_job_workspace))
            stack.enter_context(patch('app.carbon_chart_assets.carbon_html_versions', return_value={}))
            stack.enter_context(patch('app.agent_attachments.selected_agents', return_value=[]))
            stack.enter_context(patch.object(worker.bridge, 'prewarm_approval'))
            stack.enter_context(patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder))
            stack.enter_context(patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)))
            stack.enter_context(patch('app.personalization.personalize_prompt', return_value='Hello'))
            stack.enter_context(patch('app.workspace_config.ensure_brave_mcp'))
            stack.enter_context(patch.object(worker.storage, 'list_files', return_value=[]))
            stack.enter_context(patch.object(worker, 'read_history', return_value=[]))
            stack.enter_context(patch('app.project_memory.context_for_session', return_value=''))
            stack.enter_context(patch('app.conversation_documents.context_manifest', return_value=''))
            stack.enter_context(patch('app.worker.list_skills', return_value=[{'name': 'quiz-skill'}]))
            stack.enter_context(patch('app.worker.resolve_skill_name', return_value='quiz-skill'))
            stack.enter_context(patch('app.mcp_access.allowed_servers', return_value={}))
            stack.enter_context(patch('app.mcp_access.catalog', return_value=[]))
            stack.enter_context(patch.object(worker.bridge, 'stream_with_approvals', mock_stream))
            stack.enter_context(patch('app.quiz_review.finalize_review', AsyncMock(return_value='Final feedback')))
            stack.enter_context(patch('app.carbon_chart_assets.package_changed_carbon_html'))
            stack.enter_context(patch.object(worker.storage, 'persist_job'))
            stack.enter_context(patch.object(worker.bridge, 'release_prepared'))
            await worker._run(job)
            mock_recorder.finish.assert_awaited()

    async def test_run_agent_name_approval_change_and_stream_error(self):
        job = {
            'id': 'j1', 'worker_token': 'token1', 'username': 'alice',
            'workspace_id': 'legacy',
            'payload': {
                'agent_name': 'agent_1',
                'prompt': 'Prompt',
                'approval_policy': {'mode': 'default'},
                'context_rebuilt': True,
            },
        }
        mock_root = MagicMock(spec=Path)
        mock_ws = MagicMock(spec=Path)
        @contextmanager
        def mock_job_workspace(user, sid):
            yield mock_root, mock_ws

        mock_recorder = MagicMock()
        mock_recorder.record_event = AsyncMock(return_value=True)
        mock_recorder.finish = AsyncMock()
        mock_recorder.__aenter__ = AsyncMock(return_value=mock_recorder)
        mock_recorder.__aexit__ = AsyncMock(return_value=None)

        agent_original = {'name': 'Agent 1', 'endpoint': 'http://localhost:3000/a2a'}
        agent_changed = {'name': 'Agent 1 Modified', 'endpoint': 'http://other:3000/a2a'}

        import contextlib
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(worker.storage, 'job_workspace', mock_job_workspace))
            stack.enter_context(patch('app.carbon_chart_assets.carbon_html_versions', return_value={}))
            stack.enter_context(patch('app.agent_attachments.selected_agents', return_value=[]))
            stack.enter_context(patch('app.agent_budget.RunBudget.consume', AsyncMock()))
            stack.enter_context(patch.object(worker.job_queue, 'JobStreamRecorder', return_value=mock_recorder))
            stack.enter_context(patch('app.toolbar_reminders.handle_direct_request', AsyncMock(return_value=False)))
            stack.enter_context(patch.object(worker, 'get_agent', side_effect=[agent_original, agent_changed]))
            stack.enter_context(patch('app.execution_policy.ExecutionAuthorizer.authorize', AsyncMock()))
            stack.enter_context(patch.object(worker, 'read_history', return_value=[]))
            stack.enter_context(patch('app.carbon_chart_assets.package_changed_carbon_html'))
            stack.enter_context(patch.object(worker.storage, 'persist_job'))
            stack.enter_context(patch.object(worker.bridge, 'release_prepared'))
            await worker._run(job)
            mock_recorder.finish.assert_awaited_with({'type': 'error', 'message': "A2A agent 'Agent 1' error: A2A agent configuration changed during approval"})


if __name__ == '__main__':
    unittest.main()
