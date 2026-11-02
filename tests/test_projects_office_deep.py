"""Comprehensive unit tests for Buddy Projects service and Buddy Office.

Hermetic tests mocking all database queries, external dependencies, S3, and HTTP clients.
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4
import zipfile

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT / 'plugins' / 'projects') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'projects'))
if str(PROJECT_ROOT / 'plugins' / 'office') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'office'))

import buddy_projects.service as projects_service
import buddy_office.office as office_service


class DummyDb:
    """Mock database connection and cursor for testing."""
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


class ProjectsServiceDeepTests(unittest.TestCase):
    """Deep unit tests covering plugins/projects/buddy_projects/service.py."""

    def test_ensure_schema(self):
        db = DummyDb()
        with patch.object(projects_service.job_queue, '_connect', return_value=db):
            projects_service.ensure_schema()
            self.assertTrue(any('CREATE SCHEMA IF NOT EXISTS projects' in sql for sql, _ in db.executed))
            self.assertTrue(any('CREATE TABLE IF NOT EXISTS projects.projects' in sql for sql, _ in db.executed))

    def test_connection_context_manager_normal_and_conflict(self):
        db = DummyDb()
        with patch.object(projects_service.job_queue, '_connect', return_value=db):
            with projects_service.connection() as conn:
                self.assertIs(conn, db)
            self.assertTrue(any('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' in sql for sql, _ in db.executed))

        from psycopg.errors import SerializationFailure
        with patch.object(projects_service.job_queue, '_connect', side_effect=SerializationFailure('conflict')):
            with self.assertRaises(HTTPException) as ctx:
                with projects_service.connection():
                    pass
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail.get('code'), 'revision_conflict')

    def test_check_revision(self):
        with self.assertRaises(HTTPException) as ctx:
            projects_service.check_revision({'revision': 1}, None)
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            projects_service.check_revision({'revision': 2}, 1)
        self.assertEqual(ctx.exception.status_code, 409)

        projects_service.check_revision({'revision': 3}, 3)

    def test_issuer(self):
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ' https://id.example.com/realm/ '}):
            self.assertEqual(projects_service.issuer(), 'https://id.example.com/realm')

    def test_permitted(self):
        req = MagicMock(spec=Request)
        req.method = 'GET'
        res = Response()
        user = {'username': 'testuser', 'is_admin': False}
        with patch('app.project_agent_access.require_reader', return_value=user):
            result = asyncio.run(projects_service.permitted(req, res, user))
            self.assertEqual(result, user)
            self.assertEqual(res.headers['Cache-Control'], 'no-store')

        req.method = 'POST'
        req.headers = {'origin': 'https://attacker.com', 'host': 'app.local'}
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(projects_service.permitted(req, res, user))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn('Cross-origin', ctx.exception.detail)

        req.headers = {'origin': 'https://app.local', 'host': 'app.local'}
        req.url = SimpleNamespace(path='/api/projects/projects')
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(projects_service.permitted(req, res, user))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn('administrator', ctx.exception.detail)

        req.method = 'PATCH'
        req.url = SimpleNamespace(path='/api/projects/work-items/42')
        with patch('app.project_agent_access.require_reader', return_value=user):
            result = asyncio.run(projects_service.permitted(req, res, user))
            self.assertEqual(result, user)

    def test_directory_with_and_without_issuer(self):
        db = DummyDb(fetchall_val=[{'id': 'u1', 'name': 'User 1'}])
        with patch.object(projects_service, 'issuer', return_value=''):
            res = projects_service.directory(db, ['u1'])
            self.assertEqual(res, [{'id': 'u1', 'name': 'User 1'}])

        db.fetchone_val = {'relation': 'public.bob_keycloak_identities'}
        with patch.object(projects_service, 'issuer', return_value='https://auth.example.com'):
            res = projects_service.directory(db, ['u1'])
            self.assertEqual(res, [{'id': 'u1', 'name': 'User 1'}])

    def test_snapshot_admin_and_member(self):
        db = DummyDb()
        db.fetchone_val = {'relation': None}
        admin_user = {'username': 'admin', 'is_admin': True}

        p1 = {'id': 1, 'name': 'Project 1', 'revision': 1, 'created_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}
        w1 = {'id': 10, 'project_id': 1, 'owner_id': 'dev1', 'reviewer_id': None, 'predecessor_ids': []}
        a1 = {'id': 100, 'project_id': 1, 'person_id': 'dev1', 'backup_person_id': None}
        dep1 = {'id': 200, 'source_project_id': 1, 'target_project_id': 2}
        appr1 = {'id': 300, 'project_id': 1, 'approver_id': 'admin', 'actor': 'admin'}
        event1 = {'id': 400, 'created_at': datetime(2026, 1, 2, tzinfo=timezone.utc),
                  'payload': {'project_id': 1, 'changes': {}, 'impact': {'items': [{'path': [1], 'level': 'confirmed', 'project_id': 1}]}}}

        with patch.object(projects_service, 'directory', return_value=[{'id': 'admin', 'name': 'Admin'}, {'id': 'dev1', 'name': 'Dev 1'}]), \
             patch.object(projects_service, 'analyze', return_value={'items': [], 'summary': {'confirmed': 0, 'risks': 0, 'affected_projects': 0}}):
            query_results = [
                [{'id': 1}],
                [dict(p1)],
                [dict(a1)],
                [dict(dep1)],
                [dict(w1)],
                [dict(appr1)],
                [{'id': 1, 'action': 'test'}],
                [event1],
            ]
            def fake_execute(sql, params=None):
                mock_cursor = MagicMock()
                if query_results:
                    mock_cursor.fetchall.return_value = query_results.pop(0)
                else:
                    mock_cursor.fetchall.return_value = []
                mock_cursor.fetchone.return_value = None
                return mock_cursor
            db.execute = fake_execute

            snap = projects_service.snapshot(db, admin_user)
            self.assertTrue(snap['can_manage'])
            self.assertEqual(len(snap['projects']), 1)
            self.assertEqual(snap['projects'][0]['created_at'], '2026-01-01T00:00:00+00:00')
            self.assertEqual(len(snap['recent_change_impacts']), 1)

    def test_impact_summary_and_event(self):
        items = [
            {'level': 'confirmed', 'project_id': 1},
            {'level': 'risk', 'project_id': 1},
            {'level': 'risk', 'project_id': 2},
        ]
        summary = projects_service.impact_summary(items)
        self.assertEqual(summary['confirmed'], 1)
        self.assertEqual(summary['risks'], 2)
        self.assertEqual(summary['affected_projects'], 2)

        db = DummyDb()
        projects_service.event(db, {'username': 'alice'}, 'action.test', {'foo': 'bar'})
        self.assertEqual(len(db.executed), 1)
        self.assertIn('INSERT INTO projects.events', db.executed[0][0])

    def test_safe_update(self):
        sql, params = projects_service._safe_update(
            'projects.projects',
            {'name': 'Updated', 'status': 'active'},
            'WHERE id=%s',
            (10,)
        )
        self.assertIn('UPDATE projects.projects SET name=%s,status=%s,WHERE id=%s', sql)
        self.assertEqual(params, ('Updated', 'active', 10))

        with self.assertRaises(ValueError):
            projects_service._safe_update('projects.projects', {'malicious_col': 'val'}, 'WHERE id=%s', (1,))

    def test_models_validation(self):
        with self.assertRaises(ValueError):
            projects_service.Project(name='', status='planned')
        with self.assertRaises(ValueError):
            projects_service.Project(name='Valid', start_date=date(2026, 5, 10), due_date=date(2026, 5, 1))
        p = projects_service.Project(name=' Valid Name ')
        self.assertEqual(p.name, 'Valid Name')

        with self.assertRaises(ValueError):
            projects_service.ProjectPatch(expected_revision=1, start_date=date(2026, 6, 1), due_date=date(2026, 5, 1))
        with self.assertRaises(ValueError):
            projects_service.ProjectPatch(expected_revision=1, name='   ')
        with self.assertRaises(ValueError):
            projects_service.ProjectPatch(expected_revision=1, description=None)
        patch_obj = projects_service.ProjectPatch(expected_revision=1, name='New Name')
        self.assertEqual(patch_obj.name, 'New Name')

        with self.assertRaises(ValueError):
            projects_service.Assignment(project_id=1, person_id='u1', responsibility='   ', role='contributor')
        with self.assertRaises(ValueError):
            projects_service.Assignment(project_id=1, person_id='u1', responsibility='Lead', backup_person_id='u1')
        a = projects_service.Assignment(project_id=1, person_id='u1', responsibility='Lead', backup_person_id='u2')
        self.assertEqual(a.responsibility, 'Lead')

        with self.assertRaises(ValueError):
            projects_service.WorkItem(project_id=1, kind='task', title='  ')
        with self.assertRaises(ValueError):
            projects_service.WorkItem(project_id=1, kind='task', title='T', status='invalid_status')
        w = projects_service.WorkItem(project_id=1, kind='task', title='Task 1')
        self.assertEqual(w.status, 'todo')
        m = projects_service.WorkItem(project_id=1, kind='milestone', title='M1', due_date=date(2026, 6, 1))
        self.assertEqual(m.status, 'todo')

        with self.assertRaises(ValueError):
            projects_service.WorkItemPatch(expected_revision=1, title='   ')
        with self.assertRaises(ValueError):
            projects_service.WorkItemPatch(expected_revision=1, start_date=date(2026, 7, 1), due_date=date(2026, 6, 1))
        wp = projects_service.WorkItemPatch(expected_revision=1, status='in_progress')
        self.assertEqual(wp.status, 'in_progress')

        with self.assertRaises(ValueError):
            projects_service.Change(kind='person_departure', person_id='u1', status='active')
        with self.assertRaises(ValueError):
            projects_service.Change(kind='project_change', project_id=None)
        with self.assertRaises(ValueError):
            projects_service.Change(kind='project_change', project_id=1, status='invalid')
        c1 = projects_service.Change(kind='person_departure', person_id='u1', status='leaving')
        self.assertEqual(c1.status, 'leaving')
        c2 = projects_service.Change(kind='project_change', project_id=1, status='active')
        self.assertEqual(c2.status, 'active')

    def test_validate_dates_and_requirements(self):
        projects_service.validate_dates({'start_date': '2026-01-01'}, {'due_date': '2026-02-01'})
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_dates({'start_date': '2026-03-01'}, {'due_date': '2026-02-01'})
        self.assertEqual(ctx.exception.status_code, 422)

        db = DummyDb(fetchone_val=None)
        with self.assertRaises(HTTPException) as ctx:
            projects_service.require_project(db, 999)
        self.assertEqual(ctx.exception.status_code, 404)

        with patch.object(projects_service, 'directory', return_value=[{'id': 'bob'}]):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.require_person(db, 'alice')
            self.assertEqual(ctx.exception.status_code, 422)
            projects_service.require_person(db, 'bob')

    def test_validate_work_rules(self):
        db = DummyDb(fetchall_val=[{'id': 2}])
        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {'kind': 'milestone', 'due_date': None, 'project_id': 1})
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {
                'kind': 'deliverable', 'status': 'accepted', 'project_id': 1,
                'acceptance_criteria': '', 'reviewer_id': 'u1', 'acceptance_evidence': 'evidence'
            })
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {'kind': 'task', 'project_id': 1, 'predecessor_ids': [2, 2]})
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            projects_service.validate_work(db, {'kind': 'task', 'project_id': 1, 'predecessor_ids': [-1]})
        self.assertEqual(ctx.exception.status_code, 422)

        db.fetchone_val = {'reachable': 1}
        with patch.object(projects_service, 'require_person'):
            with self.assertRaises(HTTPException) as ctx:
                projects_service.validate_work(db, {'kind': 'task', 'project_id': 1, 'predecessor_ids': [2]}, item_id=1)
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertIn('cycle', ctx.exception.detail)

    def test_crud_endpoints(self):
        user = {'username': 'admin', 'is_admin': True}
        db = DummyDb()

        db.fetchone_val = {'id': 1, 'name': 'P1', 'revision': 1}
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            body = projects_service.Project(name='P1')
            res = projects_service.create_project(body, user)
            self.assertEqual(res['id'], 1)

        db.fetchone_val = None
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            patch_body = projects_service.ProjectPatch(expected_revision=1, name='P1-New')
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_project(1, patch_body, user)
            self.assertEqual(ctx.exception.status_code, 404)

        orig = {'id': 1, 'name': 'P1', 'revision': 1, 'start_date': None, 'due_date': None}
        updated = {'id': 1, 'name': 'P1-New', 'revision': 2}
        db.fetchone_val = [orig, updated]
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'snapshot', return_value={'projects': [orig]}), \
             patch.object(projects_service, 'analyze', return_value={'items': []}):
            conn_mock.return_value.__enter__.return_value = db
            res = projects_service.update_project(1, patch_body, user)
            self.assertEqual(res['name'], 'P1-New')

        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'require_project'):
            conn_mock.return_value.__enter__.return_value = db
            dep_body = projects_service.Dependency(source_project_id=1, target_project_id=1)
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_dependency(dep_body, user)
            self.assertEqual(ctx.exception.status_code, 422)

        db.fetchone_val = None
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'require_project'):
            conn_mock.return_value.__enter__.return_value = db
            dep_body = projects_service.Dependency(source_project_id=1, target_project_id=2)
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_dependency(dep_body, user)
            self.assertEqual(ctx.exception.status_code, 409)

        db.fetchone_val = None
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            with self.assertRaises(HTTPException) as ctx:
                projects_service.delete_entity('assignments', 99, user)
            self.assertEqual(ctx.exception.status_code, 404)

        db.fetchone_val = {'id': 99}
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            del_res = projects_service.delete_entity('assignments', 99, user)
            self.assertTrue(del_res['ok'])

    def test_stage_approvals_and_work_items(self):
        user = {'username': 'admin', 'is_admin': True}
        db = DummyDb()

        db.fetchone_val = None
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            appr = projects_service.StageApproval(expected_revision=1, stage='initiation', approver_id='admin', decision='approved', evidence='Signed off')
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_stage_approval(1, appr, user)
            self.assertEqual(ctx.exception.status_code, 404)

        db.fetchone_val = {'id': 1, 'revision': 1, 'stage': 'delivery'}
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            with self.assertRaises(HTTPException) as ctx:
                projects_service.create_stage_approval(1, appr, user)
            self.assertEqual(ctx.exception.status_code, 422)

        db.fetchone_val = [
            {'id': 1, 'revision': 1, 'stage': 'initiation'},
            {'id': 10, 'project_id': 1, 'stage': 'initiation', 'created_at': datetime.now(timezone.utc)}
        ]
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'require_person'):
            conn_mock.return_value.__enter__.return_value = db
            res = projects_service.create_stage_approval(1, appr, user)
            self.assertEqual(res['id'], 10)

        dev_user = {'username': 'dev2', 'is_admin': False}
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'work_record', return_value={'id': 5, 'project_id': 1, 'owner_id': 'dev1', 'kind': 'task', 'revision': 1}):
            conn_mock.return_value.__enter__.return_value = db
            patch_item = projects_service.WorkItemPatch(expected_revision=1, status='done')
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(5, patch_item, dev_user)
            self.assertEqual(ctx.exception.status_code, 403)

        owner_user = {'username': 'dev1', 'is_admin': False}
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'work_record', return_value={'id': 5, 'project_id': 1, 'owner_id': 'dev1', 'kind': 'task', 'revision': 1}):
            conn_mock.return_value.__enter__.return_value = db
            patch_item = projects_service.WorkItemPatch(expected_revision=1, title='Illegal rename')
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(5, patch_item, owner_user)
            self.assertEqual(ctx.exception.status_code, 403)

    def test_delete_work_item_and_apply(self):
        user = {'username': 'admin', 'is_admin': True}
        db = DummyDb()

        # delete_work_item not found
        db.fetchone_val = None
        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = db
            with self.assertRaises(HTTPException) as ctx:
                projects_service.delete_work_item(10, user)
            self.assertEqual(ctx.exception.status_code, 404)

        # apply project_change
        p_orig = {'id': 1, 'name': 'P1', 'status': 'planned', 'revision': 1, 'start_date': None, 'due_date': None}
        db.fetchone_val = p_orig
        change = projects_service.Change(kind='project_change', project_id=1, status='active', expected_revision=1)
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'snapshot', return_value={'projects': [p_orig]}), \
             patch.object(projects_service, 'analyze', return_value={'items': []}):
            conn_mock.return_value.__enter__.return_value = db
            res = projects_service.apply(change, user)
            self.assertIn('impact', res)
            self.assertIn('portfolio', res)

    def test_context_and_agent_context(self):
        user = {'username': 'admin', 'is_admin': True}
        portfolio_mock = {
            'projects': [{'id': 1, 'name': 'P1'}],
            'stage_approvals': [{'project_id': 1, 'approver_id': 'admin', 'actor': 'admin'}],
            'assignments': [{'project_id': 1, 'person_id': 'admin', 'backup_person_id': None}],
            'work_items': [{'project_id': 1, 'owner_id': 'admin', 'reviewer_id': None}],
            'dependencies': [{'source_project_id': 1, 'target_project_id': 2}],
            'impact': {'items': [{'project_id': 1, 'level': 'confirmed'}], 'summary': {}},
            'recent_change_impacts': [{'project_id': 1, 'impact': {'items': [{'project_id': 1, 'level': 'confirmed'}]}}],
            'people': [{'id': 'admin', 'name': 'Admin'}],
            'events': []
        }
        with patch.object(projects_service, 'connection') as conn_mock, \
             patch.object(projects_service, 'snapshot', return_value=portfolio_mock):
            conn_mock.return_value.__enter__.return_value = DummyDb()
            res = projects_service.context(project_id=1, user=user)
            self.assertIn('portfolio', res)
            self.assertIn('instructions', res)
            self.assertEqual(len(res['portfolio']['projects']), 1)

            with self.assertRaises(HTTPException) as ctx:
                projects_service.context(project_id=999, user=user)
            self.assertEqual(ctx.exception.status_code, 404)

    def test_create_app_health_and_manifest(self):
        app = projects_service.create_app()
        health_route = next(r for r in app.routes if getattr(r, 'path', '') == '/health')
        ready_route = next(r for r in app.routes if getattr(r, 'path', '') == '/ready')
        manifest_route = next(r for r in app.routes if getattr(r, 'path', '') == '/plugins/manifest')

        self.assertEqual(health_route.endpoint(), {'ok': True})
        self.assertEqual(manifest_route.endpoint()['id'], 'projects')

        with patch.object(projects_service, 'connection') as conn_mock:
            conn_mock.return_value.__enter__.return_value = DummyDb()
            self.assertEqual(ready_route.endpoint(), {'ok': True})

        with patch.object(projects_service, 'connection', side_effect=Exception('DB Down')):
            with self.assertRaises(HTTPException) as ctx:
                ready_route.endpoint()
            self.assertEqual(ctx.exception.status_code, 503)

    def test_work_items_patch_owner_and_predecessors(self):
        user_owner = {'username': 'alice', 'is_admin': False}
        user_other = {'username': 'bob', 'is_admin': False}
        orig = {
            'id': 10, 'project_id': 1, 'kind': 'task', 'owner_id': 'alice',
            'status': 'todo', 'resolution': '', 'expected_revision': 1, 'revision': 1,
            'start_date': date(2026, 1, 1), 'due_date': date(2026, 2, 1),
            'predecessor_ids': []
        }

        # 1. Non-owner cannot update
        db = DummyDb(fetchone_val=[dict(orig)])
        with patch.object(projects_service, 'connection', return_value=db):
            body = projects_service.WorkItemPatch(status='in_progress', expected_revision=1)
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, body, user_other)
            self.assertEqual(ctx.exception.status_code, 403)

        # 2. Owner cannot update fields other than status and resolution
        db = DummyDb(fetchone_val=[dict(orig)])
        with patch.object(projects_service, 'connection', return_value=db):
            body = projects_service.WorkItemPatch(title='New Title', expected_revision=1)
            with self.assertRaises(HTTPException) as ctx:
                projects_service.update_work_item(10, body, user_owner)
            self.assertEqual(ctx.exception.status_code, 403)

        # 3. Owner successfully updates status and resolution
        db_success = DummyDb(fetchone_val=[
            dict(orig),           # select work item
            {'id': 10, **orig},   # work_record returning
        ])
        with patch.object(projects_service, 'connection', return_value=db_success), \
             patch.object(projects_service, 'validate_work'), \
             patch.object(projects_service, 'event') as mock_event:
            body = projects_service.WorkItemPatch(status='done', resolution='Completed task', expected_revision=1)
            res = projects_service.update_work_item(10, body, user_owner)
            self.assertIsNotNone(res)
            mock_event.assert_called_once()

        # 4. Admin updates predecessor_ids
        user_admin = {'username': 'admin', 'is_admin': True}
        db_admin = DummyDb(fetchone_val=[
            dict(orig),           # select work item
            {'id': 10, **orig},   # work_record returning
        ])
        with patch.object(projects_service, 'connection', return_value=db_admin), \
             patch.object(projects_service, 'validate_work'), \
             patch.object(projects_service, 'save_predecessors') as mock_pred, \
             patch.object(projects_service, 'event'):
            body_admin = projects_service.WorkItemPatch(predecessor_ids=[5], expected_revision=1)
            res_admin = projects_service.update_work_item(10, body_admin, user_admin)
            self.assertIsNotNone(res_admin)
            mock_pred.assert_called_once_with(db_admin, 10, [5])

    def test_agent_context_large_payload(self):
        async def run_context():
            mock_req = MagicMock()
            async def large_stream():
                yield b'a' * 1025
            mock_req.stream = large_stream
            with self.assertRaises(HTTPException) as ctx:
                await projects_service.agent_context(mock_req)
            self.assertEqual(ctx.exception.status_code, 413)

        asyncio.run(run_context())


class OfficeServiceDeepTests(unittest.TestCase):
    """Deep unit tests covering plugins/office/buddy_office/office.py."""

    def test_config_and_secrets(self):
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'short'}):
            with self.assertRaises(HTTPException) as ctx:
                office_service.secret()
            self.assertEqual(ctx.exception.status_code, 503)

        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32}):
            self.assertEqual(office_service.secret(), 'a' * 32)

        with patch.dict(os.environ, {'BOB_S3_BUCKET': '', 'BOB_S3_ENDPOINT': '', 'BOB_S3_ACCESS_KEY_ID': '', 'BOB_S3_SECRET_ACCESS_KEY': ''}):
            with self.assertRaises(HTTPException) as ctx:
                office_service.require_storage()
            self.assertEqual(ctx.exception.status_code, 503)

        with patch.dict(os.environ, {
            'BOB_S3_BUCKET': 'bucket', 'BOB_S3_ENDPOINT': 'http://s3',
            'BOB_S3_ACCESS_KEY_ID': 'key', 'BOB_S3_SECRET_ACCESS_KEY': 'secret'
        }):
            office_service.require_storage()

    def test_same_origin(self):
        req = MagicMock(spec=Request)
        req.headers = {'origin': 'http://attacker.com', 'host': 'safe.local'}
        with self.assertRaises(HTTPException) as ctx:
            office_service.same_origin(req)
        self.assertEqual(ctx.exception.status_code, 403)

        req.headers = {'origin': 'http://safe.local', 'host': 'safe.local'}
        office_service.same_origin(req)

    def test_file_lookup_permissions(self):
        db = DummyDb()
        fid = uuid4()
        db.fetchone_val = {'id': fid, 'username': 'alice', 'name': 'Doc1.docx'}
        res = office_service._file(db, fid, 'alice')
        self.assertEqual(res['access'], 'owner')
        self.assertTrue(res['is_owner'])

        db.fetchone_val = None
        with self.assertRaises(HTTPException) as ctx:
            office_service._file(db, fid, 'bob', require_owner=True)
        self.assertEqual(ctx.exception.status_code, 404)

        db.fetchone_val = [None, {'id': fid, 'username': 'alice', 'share_permission': 'read'}]
        with self.assertRaises(HTTPException) as ctx:
            office_service._file(db, fid, 'bob', require_write=True)
        self.assertEqual(ctx.exception.status_code, 403)

        db.fetchone_val = [None, {'id': fid, 'username': 'alice', 'share_permission': 'write'}]
        res = office_service._file(db, fid, 'bob', require_write=True)
        self.assertEqual(res['access'], 'write')
        self.assertFalse(res['is_owner'])

    def test_validate_content(self):
        with self.assertRaises(HTTPException) as ctx:
            office_service.validate_content(b'x' * (office_service.MAX_BYTES + 1), 'docx')
        self.assertEqual(ctx.exception.status_code, 413)

        with patch('buddy_office.office_html.validate_html') as v_html:
            office_service.validate_content(b'<html></html>', 'html')
            v_html.assert_called_once()

        with self.assertRaises(HTTPException) as ctx:
            office_service.validate_content(b'col1,col2\x00,col3', 'csv')
        self.assertEqual(ctx.exception.status_code, 422)

        office_service.validate_content(b'col1,col2,col3\r\n1,2,3', 'csv')

        with self.assertRaises(HTTPException) as ctx:
            office_service.validate_content(b'Not a pdf', 'pdf')
        self.assertEqual(ctx.exception.status_code, 422)

        with self.assertRaises(HTTPException) as ctx:
            office_service.validate_content(b'Not a zip', 'docx')
        self.assertEqual(ctx.exception.status_code, 422)

    def test_s3_put_and_read(self):
        s3_mock = MagicMock()
        raw = b'hello world'
        digest = hashlib.sha256(raw).hexdigest()

        with patch.object(office_service, 's3', return_value=s3_mock), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}):
            res_digest = office_service.put(raw, 'test-key', 'csv')
            self.assertEqual(res_digest, digest)
            s3_mock.put_object.assert_called_once()

        stream = io.BytesIO(raw)
        s3_mock.get_object.return_value = {'Body': stream, 'Metadata': {'sha256': 'wrong-hash'}}
        with patch.object(office_service, 's3', return_value=s3_mock), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}):
            with self.assertRaises(HTTPException) as ctx:
                office_service.read('test-key')
            self.assertEqual(ctx.exception.status_code, 502)

        stream = io.BytesIO(raw)
        s3_mock.get_object.return_value = {'Body': stream, 'Metadata': {'sha256': digest}}
        with patch.object(office_service, 's3', return_value=s3_mock), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}):
            self.assertEqual(office_service.read('test-key'), raw)

    def test_store_new_validation(self):
        with patch.object(office_service, 'require_storage'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.store_new('alice', '   ', b'content')
            self.assertEqual(ctx.exception.status_code, 422)

            with self.assertRaises(HTTPException) as ctx:
                office_service.store_new('alice', 'bad\x01name.docx', b'content')
            self.assertEqual(ctx.exception.status_code, 422)

            with self.assertRaises(HTTPException) as ctx:
                office_service.store_new('alice', 'file.exe', b'content')
            self.assertEqual(ctx.exception.status_code, 422)

    def test_output_url_security(self):
        with patch.dict(os.environ, {'OFFICE_INTERNAL_URL': 'http://onlyoffice', 'OFFICE_PUBLIC_URL': '/office-editor'}):
            with self.assertRaises(ValueError):
                office_service.output_url('ftp://onlyoffice/cache/files/doc.docx')

            with self.assertRaises(ValueError):
                office_service.output_url('http://user:pass@onlyoffice/cache/files/doc.docx')

            with self.assertRaises(ValueError):
                office_service.output_url('http://onlyoffice/cache/files/../etc/passwd')

            with self.assertRaises(ValueError):
                office_service.output_url('http://evil.com/cache/files/doc.docx')

            valid_url = 'http://onlyoffice/cache/files/doc123/output.docx'
            self.assertEqual(office_service.output_url(valid_url), valid_url)

    def test_handle_callback_states(self):
        db = DummyDb()
        sid = uuid4()
        fid = uuid4()

        db.fetchone_val = None
        with patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'ensure_schema'):
            res = office_service.handle_callback({'key': str(sid), 'status': 2, 'url': 'http://onlyoffice/cache/files/doc.docx'})
            self.assertEqual(res, {'error': 0})

        db.fetchone_val = {'id': sid, 'active': False}
        with patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'ensure_schema'):
            res = office_service.handle_callback({'key': str(sid), 'status': 2, 'url': 'http://onlyoffice/cache/files/doc.docx'})
            self.assertEqual(res, {'error': 0})

        db.fetchone_val = {'id': sid, 'active': True, 'file_id': fid}
        with patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'ensure_schema'):
            res = office_service.handle_callback({'key': str(sid), 'status': 3})
            self.assertEqual(res, {'error': 0})
            self.assertTrue(any('UPDATE office.bob_office_sessions SET last_error' in sql for sql, _ in db.executed))

    def test_editor_and_source_endpoints(self):
        user = {'username': 'alice', 'display_name': 'Alice'}
        fid = uuid4()
        sid = uuid4()
        now = datetime.now(timezone.utc)
        file_row = {
            'id': fid, 'username': 'alice', 'name': 'test.docx', 'extension': 'docx',
            'object_key': 'key1', 'access': 'owner', 'size': 1234, 'revision': 1,
            'save_sequence': 0, 'created_at': now, 'saved_at': now, 'folder_id': None
        }
        session_row = {'id': sid, 'file_id': fid, 'source_key': 'key1', 'active': True}
        db = DummyDb()
        db.fetchone_val = [file_row, session_row]

        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32, 'OFFICE_INTERNAL_URL': 'http://onlyoffice'}), \
             patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db):
            res = office_service.editor(fid, 'en', user, view_only=False)
            self.assertIn('config', res)
            self.assertIn('token', res['config'])
            self.assertEqual(res['config']['document']['key'], str(sid))

            with self.assertRaises(HTTPException) as ctx:
                office_service.editor(fid, 'fr', user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_force_save_and_shares(self):
        user = {'username': 'alice'}
        fid = uuid4()
        db = DummyDb()
        db.fetchone_val = [
            {'id': fid, 'username': 'alice', 'revision': 1},
            {'id': uuid4()}
        ]
        http_mock = MagicMock()
        http_mock.post.return_value.json.return_value = {'error': 0}

        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32, 'OFFICE_INTERNAL_URL': 'http://onlyoffice'}), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch('httpx.Client') as client_class:
            client_class.return_value.__enter__.return_value = http_mock
            res = office_service.force_save(fid, user)
            self.assertTrue(res['pending'])
            self.assertFalse(res['unchanged'])

        req = office_service.ShareRequest(username='alice', permission='read')
        with patch.object(office_service, 'ensure_schema'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.set_share(fid, req, user)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_html_content_endpoints(self):
        user = {'username': 'alice'}
        fid = uuid4()
        now = datetime.now(timezone.utc)
        file_row = {
            'id': fid, 'username': 'alice', 'name': 'slides.html', 'extension': 'html',
            'object_key': 'html-key', 'size': 100, 'revision': 1, 'save_sequence': 0,
            'created_at': now, 'saved_at': now, 'folder_id': None
        }
        db = DummyDb(fetchone_val=file_row)

        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'read', return_value=b'<html><body>deck</body></html>'), \
             patch('buddy_office.office_html.validate_html', return_value='<html><body>deck</body></html>'):
            res = office_service.html_content(fid, user)
            self.assertEqual(res['revision'], 1)
            self.assertIn('html', res)

        # Revision mismatch in save_html_content raises 409
        req = office_service.HTMLContent(html='<html><body>new</body></html>', revision=2)
        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'validate_content'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.save_html_content(fid, req, user)
            self.assertEqual(ctx.exception.status_code, 409)

    def test_create_all_kinds(self):
        user = {'username': 'alice'}
        with patch.object(office_service, 'store_new', return_value={'id': str(uuid4())}) as store_mock, \
             patch('buddy_office.office.blank_pptx', return_value=b'pptx'):
            for kind in ('word', 'excel', 'powerpoint', 'csv', 'pdf', 'form'):
                req = office_service.NewFile(name='test', kind=kind)
                res = office_service.create(req, user)
                self.assertIn('id', res)
            self.assertEqual(store_mock.call_count, 6)

    def test_download_and_source_endpoints(self):
        user = {'username': 'alice'}
        fid = uuid4()
        sid = uuid4()
        file_row = {'id': fid, 'object_key': 'key1', 'extension': 'csv', 'name': 'test.csv'}
        session_row = {'source_key': 'key1', 'extension': 'csv'}
        db = DummyDb(fetchone_val=file_row)

        with patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'read', return_value=b'col1,col2\r\n1,2'):
            res = office_service.download(fid, user)
            self.assertEqual(res.media_type, 'text/csv')
            self.assertIn('attachment', res.headers['Content-Disposition'])

        # source endpoint with valid jwt
        import jwt
        token = jwt.encode({'aud': 'office-source', 'sid': str(sid)}, 'a' * 32, algorithm='HS256')
        db.fetchone_val = session_row
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32}), \
             patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch.object(office_service, 'read', return_value=b'data'):
            res = office_service.source(sid, token)
            self.assertEqual(res.media_type, 'text/csv')

        # source with invalid token raises 403
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32}):
            with self.assertRaises(HTTPException) as ctx:
                office_service.source(sid, 'bad-token')
            self.assertEqual(ctx.exception.status_code, 403)

    def test_saved_content_and_convert_csv(self):
        # Oversized saved_content raises ValueError
        http_mock = MagicMock()
        response_mock = MagicMock()
        response_mock.iter_bytes.return_value = [b'x' * (office_service.MAX_BYTES + 10)]
        http_mock.stream.return_value.__enter__.return_value = response_mock

        with patch.object(office_service, 'output_url', return_value='http://onlyoffice/cache/files/doc.docx'), \
             patch('httpx.Client') as client_class:
            client_class.return_value.__enter__.return_value = http_mock
            with self.assertRaises(ValueError) as ctx:
                office_service.saved_content('http://onlyoffice/cache/files/doc.docx')
            self.assertIn('exceeds 50 MB', str(ctx.exception))

        # convert_csv error
        http_mock2 = MagicMock()
        http_mock2.post.return_value.json.return_value = {'error': 1}
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32, 'OFFICE_INTERNAL_URL': 'http://onlyoffice'}), \
             patch.object(office_service, 'output_url', return_value='http://onlyoffice/cache/files/doc.xlsx'), \
             patch('httpx.Client') as client_class:
            client_class.return_value.__enter__.return_value = http_mock2
            with self.assertRaises(ValueError) as ctx:
                office_service.convert_csv('http://onlyoffice/cache/files/doc.xlsx', b'a,b,c')
            self.assertIn('could not convert', str(ctx.exception))

    def test_rename_and_folders(self):
        user = {'username': 'alice'}
        fid = uuid4()
        folder_id = uuid4()
        now = datetime.now(timezone.utc)
        file_row = {
            'id': fid, 'username': 'alice', 'name': 'old.docx', 'extension': 'docx',
            'object_key': 'k', 'size': 10, 'revision': 1, 'save_sequence': 0,
            'created_at': now, 'saved_at': now, 'folder_id': None
        }
        db = DummyDb(fetchone_val=file_row)

        # rename_file with missing extension automatically appends it
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db):
            req = office_service.RenameFile(name='new_document')
            res = office_service.rename_file(fid, req, user)
            self.assertEqual(res['name'], 'old.docx') # from mock fetchone

        # rename_file invalid name
        with patch.object(office_service, 'ensure_schema'):
            with self.assertRaises(HTTPException) as ctx:
                office_service.rename_file(fid, office_service.RenameFile(name='   '), user)
            self.assertEqual(ctx.exception.status_code, 422)

        # folders endpoints
        with patch.object(office_service, 'ensure_schema'), \
             patch.object(office_service.job_queue, '_connect', return_value=db), \
             patch('buddy_office.office_folders.summary', return_value={'id': str(folder_id), 'name': 'Folder 1'}), \
             patch('buddy_office.office_folders.create', return_value={'id': str(folder_id)}), \
             patch('buddy_office.office_folders.update', return_value={'id': str(folder_id)}), \
             patch('buddy_office.office_folders.delete', return_value={'ok': True}):
            self.assertEqual(len(office_service.folders(user)['items']), 0)
            self.assertEqual(office_service.create_folder(office_service.NewFolder(name='F1'), user)['id'], str(folder_id))
            self.assertEqual(office_service.update_folder(folder_id, office_service.FolderChanges(name='F2'), user)['id'], str(folder_id))
            self.assertTrue(office_service.delete_folder(folder_id, user)['ok'])

    def test_status_endpoint(self):
        user = {'username': 'alice'}
        http_mock = MagicMock()
        http_mock.get.return_value.text = 'true'
        s3_mock = MagicMock()

        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': 'a' * 32, 'BOB_S3_BUCKET': 'b'}), \
             patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 's3', return_value=s3_mock), \
             patch('httpx.Client') as client_class:
            client_class.return_value.__enter__.return_value = http_mock
            res = office_service.status(user)
            self.assertTrue(res['ready'])

            # If editor returns false -> 503
            http_mock.get.return_value.text = 'false'
            with self.assertRaises(HTTPException) as ctx:
                office_service.status(user)
            self.assertEqual(ctx.exception.status_code, 503)

    def test_delete_file_and_s3_cleanup(self):
        fid = uuid4()
        user = {'username': 'alice'}
        row = {'id': str(fid), 'username': 'alice'}
        db = DummyDb(fetchone_val=[row])
        s3_mock = MagicMock()
        s3_mock.list_objects_v2.return_value = {'Contents': [{'Key': f'users/alice/office/{fid}/file.docx'}]}

        with patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch('app.job_queue._connect', return_value=db), \
             patch.object(office_service, 's3', return_value=s3_mock):
            res = office_service.delete_file(fid, user)
            self.assertTrue(res['deleted'])
            self.assertEqual(res['id'], str(fid))
            s3_mock.delete_object.assert_called_once_with(Bucket='test-bucket', Key=f'users/alice/office/{fid}/file.docx')

        # S3 error is logged as warning and delete still succeeds
        s3_mock.list_objects_v2.side_effect = Exception('S3 timeout')
        db2 = DummyDb(fetchone_val=[row])
        with patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(office_service, 'require_storage'), \
             patch.object(office_service, 'ensure_schema'), \
             patch('app.job_queue._connect', return_value=db2), \
             patch.object(office_service, 's3', return_value=s3_mock):
            res2 = office_service.delete_file(fid, user)
            self.assertTrue(res2['deleted'])

    def test_import_conversation_file(self):
        user = {'username': 'alice'}
        req = office_service.ImportConversationFile(session_id='legacy', path='doc.docx')

        # File not found
        with patch('app.sessions.storage_scope', return_value='scope1'), \
             patch('app.postgres_storage.validate_path'), \
             patch('app.postgres_storage.get_file', side_effect=FileNotFoundError()):
            with self.assertRaises(HTTPException) as ctx:
                office_service.import_conversation_file(req, user)
            self.assertEqual(ctx.exception.status_code, 404)

        # File empty
        with patch('app.sessions.storage_scope', return_value='scope1'), \
             patch('app.postgres_storage.validate_path'), \
             patch('app.postgres_storage.get_file', return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                office_service.import_conversation_file(req, user)
            self.assertEqual(ctx.exception.status_code, 404)

        # File found and stored
        with patch('app.sessions.storage_scope', return_value='scope1'), \
             patch('app.postgres_storage.validate_path'), \
             patch('app.postgres_storage.get_file', return_value={'content': b'content'}), \
             patch.object(office_service, 'store_new', return_value={'id': 'f1'}) as mock_store:
            res = office_service.import_conversation_file(req, user)
            self.assertEqual(res['id'], 'f1')
            mock_store.assert_called_once_with('alice', 'doc.docx', b'content', None)

    def test_office_chat_context(self):
        async def run_chat():
            fid = uuid4()
            req = office_service.ChatContextRequest(file_ids=[fid])
            user = {'username': 'alice'}
            with patch('buddy_office.office_chat.chat_context', return_value=('doc context text', ['ref1'])):
                res = await office_service.office_chat_context(req, user)
                self.assertEqual(res['context'], 'doc context text')
                self.assertEqual(res['references'], ['ref1'])

        asyncio.run(run_chat())


if __name__ == '__main__':
    unittest.main()
