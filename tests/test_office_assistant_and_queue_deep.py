"""Comprehensive hermetic unit tests for Office Assistant, Job Queue, and Community Collaboration.

Strictly adheres to the Zero Fake Data Policy. Hermetically mocks all external dependencies,
network sockets, S3/blob storage, Keycloak, and PostgreSQL databases.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager, ExitStack
import csv
from datetime import date, datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4
import zipfile

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError
from psycopg.errors import UniqueViolation

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT / 'plugins' / 'office') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'office'))
if str(PROJECT_ROOT / 'plugins' / 'people') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'people'))

import buddy_office.office as office_service
import buddy_office.office_assistant as assistant
import buddy_people.community_collaboration as collaboration
from app import job_queue


class DummyDb:
    """Mock database connection and cursor for hermetic tests."""
    def __init__(self, fetchone_val=None, fetchall_val=None, rowcount=1):
        self.fetchone_val = fetchone_val
        self.fetchall_val = fetchall_val if fetchall_val is not None else []
        self.executed = []
        self.rowcount = rowcount
        self.info = SimpleNamespace(transaction_status=0)

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

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class OfficeAssistantDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/office/buddy_office/office_assistant.py."""

    def test_compute_spreadsheet_analytics_fast_path(self):
        w0 = assistant.WorkbookSheet(name='Summary', rows=2, columns=2, values=[['Region', 'Sales'], ['North', 100]], truncated=False)
        ctx = assistant.Context(kind='cell', workbook=[w0])
        fid = uuid4()
        res = assistant.compute_spreadsheet_analytics(fid, 'alice', prompt='sales summary', context=ctx)
        self.assertIsNotNone(res)
        self.assertEqual(res['file_extension'], 'cell')
        self.assertEqual(res['source'], 'current_editor')

    def test_compute_spreadsheet_analytics_non_spreadsheet(self):
        fid = uuid4()
        db = DummyDb(fetchone_val={'extension': 'docx', 'object_key': 'k', 'sha256': 'sha'})
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db), \
             patch.object(assistant.office, '_file', return_value={'extension': 'docx'}):
            res = assistant.compute_spreadsheet_analytics(fid, 'alice')
            self.assertIsNone(res)

    def test_compute_spreadsheet_analytics_caches(self):
        fid = uuid4()
        sha = 'abc123sha'
        file_row = {'extension': 'csv', 'object_key': 'key', 'sha256': sha, 'name': 'data.csv'}
        # In-memory cache hit
        assistant._analytics_cache[sha] = {'file_extension': 'csv', 'cached': True}
        db = DummyDb(fetchone_val=file_row)
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db), \
             patch.object(assistant.office, '_file', return_value=file_row):
            res = assistant.compute_spreadsheet_analytics(fid, 'alice')
            self.assertEqual(res['file_extension'], 'csv')

        # DB cache hit
        assistant._analytics_cache.pop(sha, None)
        db_cache = DummyDb(fetchone_val={'analytics': {'file_extension': 'csv', 'from_db': True}})
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db_cache), \
             patch.object(assistant.office, '_file', return_value=file_row), \
             patch.object(assistant, '_ensure_analytics_cache_schema'):
            res_db = assistant.compute_spreadsheet_analytics(fid, 'alice')
            self.assertEqual(res_db['file_extension'], 'csv')

    def test_compute_spreadsheet_analytics_csv_and_xlsx_parse(self):
        fid = uuid4()
        sha = 'fresh_csv_sha'
        file_row = {'extension': 'csv', 'object_key': 'key', 'sha256': sha, 'name': 'metrics.csv'}
        assistant._analytics_cache.pop(sha, None)
        csv_bytes = b'Region,Sales\nNorth,100\nSouth,200\nEast,150\n'

        db = DummyDb(fetchone_val=None)
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db), \
             patch.object(assistant.office, '_file', return_value=file_row), \
             patch.object(assistant, '_ensure_analytics_cache_schema'), \
             patch.object(assistant.office, 'read', return_value=csv_bytes):
            res = assistant.compute_spreadsheet_analytics(fid, 'alice', prompt='sales by region')
            self.assertIsNotNone(res)
            self.assertEqual(res['file_extension'], 'csv')

        # XLSX branch
        sha_xlsx = 'fresh_xlsx_sha'
        xlsx_file_row = {'extension': 'xlsx', 'object_key': 'key_xlsx', 'sha256': sha_xlsx, 'name': 'wb.xlsx'}
        assistant._analytics_cache.pop(sha_xlsx, None)
        mock_wb = MagicMock()
        mock_wb.sheetnames = ['Sheet1']
        mock_ws = MagicMock()
        mock_ws.iter_rows.side_effect = lambda *a, **k: iter([('Product', 'Cost'), ('Widget', 50)])
        mock_wb.__getitem__.return_value = mock_ws
        mock_wb.close = MagicMock()

        db_xlsx = DummyDb(fetchone_val=None)
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db_xlsx), \
             patch.object(assistant.office, '_file', return_value=xlsx_file_row), \
             patch.object(assistant, '_ensure_analytics_cache_schema'), \
             patch.object(assistant.office, 'read', return_value=b'dummy_xlsx'), \
             patch('openpyxl.load_workbook', return_value=mock_wb):
            res_xlsx = assistant.compute_spreadsheet_analytics(fid, 'alice', prompt='cost')
            self.assertIsNotNone(res_xlsx)
            self.assertEqual(res_xlsx['file_extension'], 'xlsx')

    def test_convert_csv_to_xlsx_file(self):
        fid = uuid4()
        # Non-csv raises 422
        db_non_csv = DummyDb(fetchone_val={'extension': 'docx'})
        with patch.object(assistant.office, 'require_storage'), \
             patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db_non_csv), \
             patch.object(assistant.office, '_file', return_value={'extension': 'docx'}):
            with self.assertRaises(HTTPException) as ctx:
                assistant.convert_csv_to_xlsx_file(fid, 'alice')
            self.assertEqual(ctx.exception.status_code, 422)

        # Success CSV conversion with numeric parsing
        file_row = {'extension': 'csv', 'name': 'budget.csv', 'object_key': 'key'}
        csv_bytes = b'Category,Amount\nTravel,1200\nMeals,35.50\nEmpty,\n'
        db_csv = DummyDb(fetchone_val=file_row)
        with patch.object(assistant.office, 'require_storage'), \
             patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect', return_value=db_csv), \
             patch.object(assistant.office, '_file', return_value=file_row), \
             patch.object(assistant.office, 'read', return_value=csv_bytes), \
             patch.object(assistant.office, 'store_new', return_value={'id': 'new_xlsx_id'}) as mock_store:
            res = assistant.convert_csv_to_xlsx_file(fid, 'alice')
            self.assertEqual(res, {'id': 'new_xlsx_id'})
            self.assertEqual(mock_store.call_args[0][0], 'alice')
            self.assertEqual(mock_store.call_args[0][1], 'budget.xlsx')

    def test_parse_plan_limits_and_kinds(self):
        # Size limit
        with self.assertRaises(ValueError):
            assistant.parse_plan('x' * 250001, 'docx')

        # Markdown extraction and kind validation
        raw_markdown = '```json\n{"version": 1, "kind": "word", "reply": "ok", "actions": []}\n```'
        plan = assistant.parse_plan(raw_markdown, 'docx')
        self.assertEqual(plan.kind, 'word')

        # Kind mismatch
        with self.assertRaises(ValueError):
            assistant.parse_plan('{"version": 1, "kind": "cell", "reply": "ok", "actions": []}', 'docx')

    def test_validate_context_plan_rules(self):
        # Plan kind != context kind
        plan = assistant.Plan(version=1, kind='word', reply='ok', actions=[])
        ctx = assistant.Context(kind='cell')
        with self.assertRaises(ValueError):
            assistant.validate_context_plan(plan, ctx)

        # Edit chart not found in context
        chart_action = assistant.EditChart(type='edit_chart', chart_index=1, sheet='Sheet1', title='New Title')
        plan_chart = assistant.Plan(version=1, kind='cell', reply='ok', actions=[chart_action])
        ctx_cell = assistant.Context(kind='cell', charts=[])
        with self.assertRaises(ValueError):
            assistant.validate_context_plan(plan_chart, ctx_cell)

        # Slide object missing
        slide_action = assistant.ReplaceSlideText(type='replace_slide_text', slide_index=1, shape_index=1, old_text='Old', text='New')
        plan_slide = assistant.Plan(version=1, kind='slide', reply='ok', actions=[slide_action])
        ctx_slide = assistant.Context(kind='slide', slide_shapes=[])
        with self.assertRaises(ValueError):
            assistant.validate_context_plan(plan_slide, ctx_slide)

        # HTML text node missing or edited twice
        html_action = assistant.HtmlUpdateText(type='html_update_text', index=5, old_text='Before', text='After')
        plan_html = assistant.Plan(version=1, kind='html', reply='ok', actions=[html_action])
        ctx_html = assistant.Context(kind='html', html_nodes=[])
        with self.assertRaises(ValueError):
            assistant.validate_context_plan(plan_html, ctx_html)

        # Duplicate sheet name on add_sheet
        add_sheet_action = assistant.AddSheet(type='add_sheet', name='Sheet1')
        plan_sheet = assistant.Plan(version=1, kind='cell', reply='ok', actions=[add_sheet_action])
        ctx_sheet = assistant.Context(kind='cell', sheet='Sheet1', workbook=[assistant.WorkbookSheet(name='Sheet1', rows=1, columns=1)])
        with self.assertRaises(ValueError):
            assistant.validate_context_plan(plan_sheet, ctx_sheet)

    def test_validate_selection_scope(self):
        # Selection mode cell edit without selected range
        cell_action = assistant.SetCells(type='set_cells', range='A1', values=[[1]])
        plan_cell = assistant.Plan(version=1, kind='cell', reply='ok', actions=[cell_action])
        req_no_range = SimpleNamespace(context_mode='selection', context=assistant.Context(kind='cell', range=None))
        with self.assertRaises(ValueError):
            assistant.validate_selection_scope(plan_cell, req_no_range)

        # Cell action outside selection range
        req_bounded = SimpleNamespace(context_mode='selection', context=assistant.Context(kind='cell', sheet='Data', range='B2:C3'))
        action_outside = assistant.SetCells(type='set_cells', sheet='Data', range='A1:B2', values=[[1, 2], [3, 4]])
        plan_outside = assistant.Plan(version=1, kind='cell', reply='ok', actions=[action_outside])
        with self.assertRaises(ValueError):
            assistant.validate_selection_scope(plan_outside, req_bounded)

        # Valid selection range
        action_inside = assistant.SetCells(type='set_cells', sheet='Data', range='B2:C2', values=[[1, 2]])
        plan_inside = assistant.Plan(version=1, kind='cell', reply='ok', actions=[action_inside])
        assistant.validate_selection_scope(plan_inside, req_bounded)

    def test_partial_reply_token_parsing(self):
        self.assertEqual(assistant.partial_reply('no reply token'), '')
        self.assertEqual(assistant.partial_reply('{"reply": "Hello world"'), 'Hello world')
        self.assertEqual(assistant.partial_reply('{"reply": "Escaped \\"quote\\" here'), 'Escaped "quote" here')
        self.assertEqual(assistant.partial_reply('{"reply": "Split \\u'), 'Split ')

    def test_plan_schema_for_all_kinds(self):
        for ext in ('docx', 'pptx', 'pdf', 'xlsx', 'html'):
            schema = assistant.plan_schema_for(ext)
            self.assertIn('properties', schema)
            self.assertIn('actions', schema['properties'])

    def test_assistant_error_and_validation_summary(self):
        code, msg = assistant.assistant_error(RuntimeError('Agent isolation unavailable'))
        self.assertEqual(code, 'isolation_unavailable')

        code, msg = assistant.assistant_error(assistant.InvalidPlan('bad plan'))
        self.assertEqual(code, 'invalid_plan')

        code, msg = assistant.assistant_error(TimeoutError('slow'))
        self.assertEqual(code, 'timeout')

        code, msg = assistant.assistant_error(Exception('generic'))
        self.assertEqual(code, 'connection_error')

        # validation summary
        self.assertEqual(assistant.validation_summary(ValueError('Some syntax error')), 'Some syntax error')
        self.assertEqual(assistant.validation_summary(TypeError('bad')), 'Invalid JSON, unsupported action, wrong document kind, or exceeded editing limits.')

    def test_event_helper(self):
        ev = assistant.event('delta', text='chunk')
        parsed = json.loads(ev)
        self.assertEqual(parsed['type'], 'delta')
        self.assertEqual(parsed['text'], 'chunk')

    def test_owned_extension(self):
        fid = uuid4()
        with patch.object(assistant.office, 'ensure_schema'), \
             patch.object(assistant.office.job_queue, '_connect'), \
             patch.object(assistant.office, '_file', return_value={'extension': 'docx'}):
            ext = assistant.owned_extension(fid, 'alice')
            self.assertEqual(ext, 'docx')

    def test_action_models_validation(self):
        # SortRange validation
        with self.assertRaises(ValidationError):
            assistant.SortRange(type='sort_range', range='A1:B10', keys=[assistant.SortKey(column=5)])  # col 5 > 2
        valid_sort = assistant.SortRange(type='sort_range', range='A1:B10', keys=[assistant.SortKey(column=1)])
        self.assertEqual(valid_sort.range, 'A1:B10')

        # FilterRange validation
        with self.assertRaises(ValidationError):
            assistant.FilterRange(type='filter_range', range='A1:B10', field=5)  # field 5 > 2
        with self.assertRaises(ValidationError):
            assistant.FilterRange(type='filter_range', range='A1:B10', criteria='xyz')  # criteria without field
        valid_filter = assistant.FilterRange(type='filter_range', range='A1:B10', field=1, criteria='test')
        self.assertEqual(valid_filter.field, 1)

        # SetValidation
        with self.assertRaises(ValidationError):
            assistant.SetValidation(type='set_validation', range='A1:B10', rule='whole', operator='between', formula1='1', formula2='')
        valid_val = assistant.SetValidation(type='set_validation', range='A1:B10', rule='whole', operator='between', formula1='1', formula2='10')
        self.assertEqual(valid_val.rule, 'whole')

        # ConditionalFormat
        with self.assertRaises(ValidationError):
            assistant.ConditionalFormat(type='conditional_format', range='A1:B10', operator='between', formula1='1', formula2='', fill='#ff0000')
        valid_cf = assistant.ConditionalFormat(type='conditional_format', range='A1:B10', operator='greater', formula1='1', fill='#ff0000')
        self.assertEqual(valid_cf.fill, '#ff0000')

        # RangeDimensions
        with self.assertRaises(ValidationError):
            assistant.RangeDimensions(type='range_dimensions', range='A1:B10')  # neither height nor width
        valid_rd = assistant.RangeDimensions(type='range_dimensions', range='A1:B10', row_height=20)
        self.assertEqual(valid_rd.row_height, 20)

        # SheetOptions
        with self.assertRaises(ValidationError):
            assistant.SheetOptions(type='sheet_options')  # no options chosen
        valid_so = assistant.SheetOptions(type='sheet_options', gridlines=True)
        self.assertTrue(valid_so.gridlines)

        # SlideOperation
        with self.assertRaises(ValidationError):
            assistant.SlideOperation(type='slide_operation', slide_index=1, operation='move')  # needs position
        valid_so2 = assistant.SlideOperation(type='slide_operation', slide_index=1, operation='move', position=3)
        self.assertEqual(valid_so2.position, 3)

        # AddSlideTable
        with self.assertRaises(ValidationError):
            assistant.AddSlideTable(type='add_slide_table', slide_index=1, rows=[['a', 'b'], ['c']])  # not rectangular
        valid_table = assistant.AddSlideTable(type='add_slide_table', slide_index=1, rows=[['a', 'b'], ['c', 'd']])
        self.assertEqual(len(valid_table.rows), 2)

        # NativeChartData
        with self.assertRaises(ValidationError):
            assistant.NativeChartData(categories=['A'], series_names=['S1'], data=[[1.0, 2.0]])  # mismatch
        valid_chart_data = assistant.NativeChartData(categories=['A', 'B'], series_names=['S1'], data=[[1.0, 2.0]])
        self.assertEqual(len(valid_chart_data.categories), 2)

        # SlideObject
        with self.assertRaises(ValidationError):
            assistant.SlideObject(type='slide_object', slide_index=1, shape_index=1, operation='move', x=10)  # y missing
        with self.assertRaises(ValidationError):
            assistant.SlideObject(type='slide_object', slide_index=1, shape_index=1, operation='resize', width=10)  # height missing
        valid_obj = assistant.SlideObject(type='slide_object', slide_index=1, shape_index=1, operation='delete')
        self.assertEqual(valid_obj.operation, 'delete')

        # EditChart
        with self.assertRaises(ValidationError):
            assistant.EditChart(type='edit_chart', chart_index=1)  # no changes
        with self.assertRaises(ValidationError):
            assistant.EditChart(type='edit_chart', chart_index=1, width=100)  # height missing
        valid_edit_chart = assistant.EditChart(type='edit_chart', chart_index=1, title='Test')
        self.assertEqual(valid_edit_chart.title, 'Test')

        # Plan constraints
        with self.assertRaises(ValidationError):
            assistant.Plan(version=1, kind='word', reply='   ', actions=[])
        with self.assertRaises(ValidationError):
            consultation = assistant.AppConsultation(agent='notes', task='check', query='q')
            assistant.Plan(version=1, kind='word', reply='ok', actions=[assistant.SetHeader(type='set_header', text='H')], consultations=[consultation])


class JobQueueDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/job_queue.py."""

    def test_session_guard(self):
        db = DummyDb(fetchone_val={'1': 1})
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db):
            with self.assertRaises(ValueError) as ctx:
                with job_queue.session_guard('alice', 'legacy'):
                    pass
            self.assertIn('Conversation is being deleted', str(ctx.exception))

    def test_find_submission_idempotency_hash_mismatch(self):
        db = DummyDb(fetchone_val={'request_hash': 'hash1', 'id': uuid4(), 'payload': {}})
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db):
            with self.assertRaises(ValueError) as ctx:
                job_queue.find_submission('alice', 'legacy', 'idem-1', 'different_hash')
            self.assertIn('Idempotency key was already used', str(ctx.exception))

    def test_enqueue_unique_violation_and_deleted_message_check(self):
        # Initial insert raises UniqueViolation
        db1 = DummyDb()
        db1.execute = MagicMock(side_effect=[db1, UniqueViolation('duplicate active job')])
        db2 = DummyDb(fetchone_val=[
            {'record': {'history_revision': 1}},  # edited_history
            {'1': 1},  # message was deleted
        ])

        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', side_effect=[db1, db2]), \
             patch('app.postgres_storage._lock'):
            with self.assertRaises(ValueError) as ctx:
                job_queue.enqueue('alice', 'legacy', 'ws_key', {'user_message_id': 'm1'})
            self.assertIn('This message was deleted', str(ctx.exception))

    def test_begin_and_complete_deletion(self):
        # Active job prevents deletion
        db_active = DummyDb(fetchone_val=[{'status': 'deleting'}, {'1': 1}])
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_active):
            with self.assertRaises(ValueError) as ctx:
                job_queue.begin_deletion('alice', 'legacy', 'ws_key')
            self.assertIn('A job is active in this conversation', str(ctx.exception))

        # Successful deletion begin and complete
        db_del = DummyDb(fetchone_val=None)
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_del):
            status = job_queue.begin_deletion('alice', 'legacy', 'ws_key', project_id='proj1')
            self.assertEqual(status, 'deleting')

            job_queue.complete_deletion('alice', 'legacy')
            self.assertTrue(any('UPDATE bob_deleted_conversations' in sql for sql, _ in db_del.executed))

    def test_deletion_status_and_helpers(self):
        rows = [{'workspace_id': 's1', 'status': 'deleted', 'project_id': 'p1'}]
        db = DummyDb(fetchall_val=[rows, rows],
                     fetchone_val={'status': 'deleting', 'project_id': 'p1'})
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db):
            self.assertEqual(job_queue.deletion_status('alice', 's1'), 'deleting')
            self.assertEqual(job_queue.deleted_session_ids('alice'), {'s1'})
            self.assertIn('s1', job_queue.deletion_states('alice'))

    def test_requeue_expired_retried_and_dead_letter(self):
        jid1 = uuid4()
        jid2 = uuid4()
        expired_jobs = [
            {'id': jid1, 'username': 'alice', 'attempts': 0, 'max_attempts': 2, 'payload': {}, 'workspace_id': 's1'},
            {'id': jid2, 'username': 'bob', 'attempts': 1, 'max_attempts': 1, 'payload': {'cancel_requested': True}, 'workspace_id': 's2'},
        ]
        db = DummyDb(fetchall_val=[expired_jobs])
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db), \
             patch('app.delivery.persist_delivery'):
            job_queue.requeue_expired()
            # jid1 was requeued
            self.assertTrue(any("UPDATE bob_jobs SET status='queued'" in sql for sql, _ in db.executed))
            # jid2 reached max_attempts or was cancelled, marked failed
            self.assertTrue(any("UPDATE bob_jobs SET status='failed'" in sql for sql, _ in db.executed))

    def test_claim_and_heartbeat(self):
        jid = uuid4()
        token = str(uuid4())
        job_row = {'id': jid, 'username': 'alice', 'workspace_id': 's1', 'payload': {}, 'attempts': 0}
        db = DummyDb(fetchone_val=job_row)
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db), \
             patch('app.delivery.persist_delivery'):
            claimed = job_queue.claim(token)
            self.assertIsNotNone(claimed)
            self.assertEqual(claimed['status'], 'running')

            # Heartbeat renewal
            db_hb = DummyDb(rowcount=1)
            with patch.object(job_queue, '_connect', return_value=db_hb):
                self.assertTrue(job_queue.heartbeat(str(jid), token))

    def test_append_event_and_request_cancel(self):
        jid = uuid4()
        token = str(uuid4())
        # Append event to non-running job returns False
        db_no = DummyDb(fetchone_val=None)
        with patch.object(job_queue, '_connect', return_value=db_no):
            self.assertFalse(job_queue.append_event(str(jid), token, {'type': 'delta'}))

        # Append event success
        db_yes = DummyDb(fetchone_val={'payload': {}, 'workspace_id': 's1'})
        with patch.object(job_queue, '_connect', return_value=db_yes):
            self.assertTrue(job_queue.append_event(str(jid), token, {'type': 'delta', 'text': 'hi'}))

        # Cancel queued job
        db_cancel = DummyDb(fetchone_val={'id': jid, 'status': 'queued', 'payload': {}, 'workspace_id': 's1'})
        with patch.object(job_queue, '_connect', return_value=db_cancel), \
             patch('app.delivery.persist_delivery'):
            res = job_queue.request_cancel(str(jid), 'alice')
            self.assertEqual(res['status'], 'failed')

    def test_approvals_lifecycle(self):
        jid = uuid4()
        token = str(uuid4())
        appr_id = str(uuid4())

        # Create approval
        db_appr = DummyDb(fetchone_val={'1': 1})
        with patch.object(job_queue, '_connect', return_value=db_appr):
            job_queue.create_approval(str(jid), token, {'approval_id': appr_id, 'scope': 'action'})
            self.assertTrue(any('INSERT INTO bob_job_approvals' in sql for sql, _ in db_appr.executed))

        # Assert execution active stopped
        db_stopped = DummyDb(fetchone_val=None)
        with patch.object(job_queue, '_connect', return_value=db_stopped):
            with self.assertRaises(PermissionError):
                job_queue.assert_execution_active(str(jid), token, 'alice')

        # Decide approval
        appr_row = {
            'id': appr_id, 'job_id': jid, 'status': 'running',
            'decision': None, 'event': {'scope': 'action'},
        }
        db_decide = DummyDb(fetchone_val=appr_row)
        with patch.object(job_queue, '_connect', return_value=db_decide):
            decided = job_queue.decide_approval(str(jid), 'alice', appr_id, 'approve')
            self.assertEqual(decided['status'], 'approved')

        # Consume execution approval
        valid_appr_row = {
            'decision': 'approve', 'valid': True,
            'event': {'actor': 'alice', 'action_digest': 'dig1', 'scope': 'action', 'consumed': False},
        }
        db_consume = DummyDb(fetchone_val=[{'id': jid}, valid_appr_row])
        with patch.object(job_queue, '_connect', return_value=db_consume):
            consumed = job_queue.consume_execution_approval(str(jid), token, appr_id, 'alice', 'dig1')
            self.assertEqual(consumed, 'approve')

    def test_update_approval_policy_and_auto_resolve(self):
        jid = uuid4()
        token = str(uuid4())
        appr_id = str(uuid4())

        job_row = {
            'id': jid, 'workspace_id': 's1', 'status': 'running',
            'payload': {'approval_policy': {'mode': 'auto', 'actions': []}},
        }
        db_policy = DummyDb(fetchone_val=job_row, fetchall_val=[[]])
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_policy), \
             patch('app.approval_policy.policy_state', return_value={'mutable': True, 'revision': 1}):
            res = job_queue.update_approval_policy(str(jid), 'alice', {'mode': 'auto'})
            self.assertEqual(res['revision'], 2)

        # Auto resolve approval
        appr_pending = {'decision': None, 'event': {'tool': {'name': 'read_file'}, 'scope': 'action'}}
        db_resolve = DummyDb(fetchone_val=[job_row, appr_pending])
        with patch.object(job_queue, '_connect', return_value=db_resolve), \
             patch('app.approval_policy.review_required', return_value=False):
            resolved = job_queue.auto_resolve_approval(str(jid), token, appr_id)
            self.assertEqual(resolved, 'approve')

        # Interrupt approval
        db_int = DummyDb(fetchone_val={'1': 1})
        with patch.object(job_queue, '_connect', return_value=db_int):
            job_queue.interrupt_approval(str(jid), token, appr_id)
            self.assertTrue(any("decision='reject'" in sql for sql, _ in db_int.executed))

    def test_additional_job_queue_helpers(self):
        db = DummyDb(fetchall_val=[[{'task_id': 't1'}]], fetchone_val={'id': uuid4(), 'status': 'queued'})
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db):
            done_tasks = job_queue.session_done_task_ids('alice', 'legacy')
            self.assertEqual(done_tasks, {'t1'})

            job = job_queue.get_job('jid1')
            self.assertEqual(job['status'], 'queued')

            job_user = job_queue.get_job('jid1', 'alice')
            self.assertEqual(job_user['status'], 'queued')

            job_queue.delete_session_jobs('alice', 'legacy')
            self.assertTrue(any('DELETE FROM bob_jobs' in sql for sql, _ in db.executed))

        db2 = DummyDb(fetchall_val=[[{'workspace_id': 's1', 'prompt': 'p1'}, {'workspace_id': 's2', 'prompt': 'p2'}]])
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db2):
            unique_prompts = job_queue.session_unique_bob_prompts('alice', 's1')
            self.assertEqual(unique_prompts, {'p1'})

        db3 = DummyDb(fetchone_val={'1': 1})
        with patch.object(job_queue, 'ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db3):
            self.assertTrue(job_queue.has_active_workspace('ws_key'))

        db4 = DummyDb(fetchall_val=[[{'id': 1, 'event': {'type': 'delta'}}]], fetchone_val={'status': 'running'})
        with patch.object(job_queue, '_connect', return_value=db4):
            rows, status = job_queue.events_after('jid1', 0)
            self.assertEqual(len(rows), 1)
            self.assertEqual(status, 'running')

    def test_job_stream_and_finish(self):
        jid = uuid4()
        token = str(uuid4())
        stream = job_queue.JobStreamRecorder(durable=True, job_id=jid, worker_token=token,
                                     username='alice', workspace_id='legacy',
                                     correlation={'turn_id': 'turn1'})
        stream._conn = AsyncMock()
        stream._conn.closed = False

        db = DummyDb(fetchone_val={'id': 1, 'username': 'alice', 'workspace_id': 'legacy', 'payload': {}})
        with patch.object(job_queue, '_connect', return_value=db), \
             patch('app.postgres_storage.ensure_schema'), \
             patch('app.delivery.persist_delivery'):
            async def run():
                ok1 = await stream.record_event({'type': 'delta', 'text': 'Hello '})
                ok2 = await stream.record_event({'type': 'delta', 'text': 'world!'})
                ok3 = await stream.record_event({'type': 'tool', 'name': 'bash', 'output': 'out'})
                ok4 = await stream.record_event({'type': 'delivery_state', 'state': 'saving'})
                self.assertTrue(ok1)
                self.assertTrue(ok2)
                self.assertTrue(ok3)
                self.assertTrue(ok4)
                await stream.finish({'type': 'done'})
            asyncio.run(run())

        # finish function
        db_fin = DummyDb(fetchone_val={'username': 'alice', 'workspace_id': 'legacy', 'payload': {}})
        with patch('app.postgres_storage.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_fin), \
             patch('app.delivery.persist_delivery'):
            res = job_queue.finish(str(jid), token, {'type': 'done'})
            self.assertTrue(res)


class CommunityCollaborationDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/people/buddy_people/community_collaboration.py."""

    def test_schema_execution(self):
        db = DummyDb(fetchone_val={'name': None})
        collaboration.schema(db)
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS people_chat.bob_chat_message_seen' in sql for sql, _ in db.executed))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS people_chat.bob_chat_dependencies' in sql for sql, _ in db.executed))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS people_chat.bob_chat_reactions' in sql for sql, _ in db.executed))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS people_chat.bob_chat_tasks' in sql for sql, _ in db.executed))

    def test_purge_message(self):
        db = DummyDb()
        # Message not found
        db.fetchone_val = None
        with self.assertRaises(HTTPException) as ctx:
            collaboration.purge_message(db, 1, 10, 'alice')
        self.assertEqual(ctx.exception.status_code, 404)

        # Success purge with cascade
        db.fetchone_val = {'id': 10}
        db.fetchall_val = [[{'id': 10, 'room_id': 1}, {'id': 11, 'room_id': 1}]]
        with patch('buddy_people.community.changed') as mock_changed:
            res = collaboration.purge_message(db, 1, 10, 'alice')
            self.assertEqual(res, {'deleted': 10})
            mock_changed.assert_called_once_with(db, 1)

    def test_message_in_room_and_enrich(self):
        db = DummyDb()
        # Missing message raises 404
        db.fetchone_val = None
        with self.assertRaises(HTTPException) as ctx:
            collaboration.message_in_room(db, 1, 999)
        self.assertEqual(ctx.exception.status_code, 404)

        # Enrich messages with reactions and tasks
        rows = [{'id': 1, 'body': 'Hi'}]
        db.fetchall_val = [
            [{'message_id': 1, 'emoji': '👍', 'count': 2, 'mine': True}],
            [{'id': 10, 'message_id': 1, 'title': 'Follow up'}],
        ]
        enriched = collaboration.enrich(db, rows, 'alice')
        self.assertEqual(len(enriched[0]['reactions']), 1)
        self.assertEqual(enriched[0]['reactions'][0]['emoji'], '👍')
        self.assertEqual(len(enriched[0]['tasks']), 1)

    def test_quiet_settings_model_validation(self):
        # Invalid timezone raises ValueError
        with self.assertRaises(ValidationError):
            collaboration.QuietSettings(timezone='Invalid/Timezone')

        # Same start and end with quiet_enabled raises ValueError
        with self.assertRaises(ValidationError):
            collaboration.QuietSettings(quiet_enabled=True, start='22:00', end='22:00', timezone='UTC')

        # Valid settings
        valid = collaboration.QuietSettings(quiet_enabled=True, start='22:00', end='08:00', timezone='America/New_York')
        self.assertEqual(valid.timezone, 'America/New_York')

    def test_notifications_paused_logic(self):
        db = DummyDb()
        # Disabled
        db.fetchone_val = {'quiet_enabled': False}
        self.assertFalse(collaboration.notifications_paused(db, 'alice'))

        # Start < end (e.g. 01:00 to 05:00)
        db.fetchone_val = {'quiet_enabled': True, 'start': '01:00', 'end': '05:00', 'timezone': 'UTC'}
        now_inside = datetime(2026, 1, 1, 3, 0, tzinfo=timezone.utc)
        self.assertTrue(collaboration.notifications_paused(db, 'alice', now=now_inside))
        now_outside = datetime(2026, 1, 1, 7, 0, tzinfo=timezone.utc)
        self.assertFalse(collaboration.notifications_paused(db, 'alice', now=now_outside))

        # Start >= end (overnight, e.g. 22:00 to 08:00)
        db.fetchone_val = {'quiet_enabled': True, 'start': '22:00', 'end': '08:00', 'timezone': 'UTC'}
        now_late = datetime(2026, 1, 1, 23, 0, tzinfo=timezone.utc)
        self.assertTrue(collaboration.notifications_paused(db, 'alice', now=now_late))
        now_early = datetime(2026, 1, 1, 6, 0, tzinfo=timezone.utc)
        self.assertTrue(collaboration.notifications_paused(db, 'alice', now=now_early))
        now_day = datetime(2026, 1, 1, 14, 0, tzinfo=timezone.utc)
        self.assertFalse(collaboration.notifications_paused(db, 'alice', now=now_day))

    def test_router_endpoints(self):
        router = APIRouter()
        collaboration.register(router, current_user=lambda: {'username': 'alice'}, same_origin=lambda: True)

        # Extract registered route callables from router
        routes = {route.name: route.endpoint for route in router.routes}

        # /notification-settings GET and PUT
        db_settings = DummyDb(fetchone_val={'quiet_enabled': True, 'start': '22:00', 'end': '08:00', 'timezone': 'UTC'})
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_settings), \
             patch('buddy_people.community.changed'):
            get_res = routes['notification_settings'](user={'username': 'alice'})
            self.assertTrue(get_res['quiet_enabled'])

            put_body = collaboration.QuietSettings(quiet_enabled=False)
            put_res = routes['set_notification_settings'](body=put_body, user={'username': 'alice'})
            self.assertFalse(put_res['quiet_enabled'])

        # /rooms/{room_id}/share note
        share_note = collaboration.Share(kind='note', note_id=1, title='Note Title')
        db_note = DummyDb(fetchone_val=[{'title': 'Note 1', 'body': 'Text', 'community_message_id': None}, {'id': 50}])
        with patch('buddy_people.community.ensure_schema'), \
             patch('app.notes.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_note), \
             patch('buddy_people.community.member'), \
             patch('buddy_people.community_away.enqueue'), \
             patch('buddy_people.community.changed'):
            shared_res = routes['share'](room_id=1, body=share_note, user={'username': 'alice'})
            self.assertEqual(shared_res['id'], 50)

        # /rooms/{room_id}/members
        member_body = collaboration.Membership(usernames=['bob'])
        room_row = {'creator': 'alice', 'kind': 'channel', 'visibility': 'public'}
        db_members = DummyDb(fetchone_val=room_row, fetchall_val=[[{'username': 'bob'}, {'username': 'alice'}]])
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_members), \
             patch('buddy_people.community.member'), \
             patch('buddy_people.community.changed'):
            mem_res = routes['membership'](room_id=1, body=member_body, user={'username': 'alice'})
            self.assertTrue(mem_res['updated'])

        # /rooms/{room_id}/messages/{message_id}/reactions
        react_body = collaboration.Reaction(emoji='👍')
        db_react = DummyDb(fetchone_val={'message_id': 10})  # deleted
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_react), \
             patch('buddy_people.community.member'), \
             patch.object(collaboration, 'message_in_room'), \
             patch('buddy_people.community.changed'):
            react_res = routes['react'](room_id=1, message_id=10, body=react_body, user={'username': 'alice'})
            self.assertFalse(react_res['active'])

        # /rooms/{room_id}/messages/{message_id}/pin
        pin_body = collaboration.Pin(pinned=True)
        db_pin = DummyDb()
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_pin), \
             patch('buddy_people.community.member'), \
             patch.object(collaboration, 'message_in_room'), \
             patch('buddy_people.community.changed'):
            pin_res = routes['pin'](room_id=1, message_id=10, body=pin_body, user={'username': 'alice'})
            self.assertTrue(pin_res['pinned'])

        # /rooms/{room_id}/messages/{message_id}/tasks
        task_body = collaboration.Task(title='New Task', assignee='bob')
        task_row = {'id': 1, 'title': 'New Task', 'assignee': 'bob'}
        db_task = DummyDb(fetchone_val=[{'1': 1}, task_row])
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_task), \
             patch('buddy_people.community.member'), \
             patch.object(collaboration, 'message_in_room'), \
             patch('buddy_people.community.changed'):
            t_res = routes['create_task'](room_id=1, message_id=10, body=task_body, user={'username': 'alice'})
            self.assertEqual(t_res['id'], 1)

        # /rooms/{room_id}/tasks/{task_id} update status
        update_body = collaboration.TaskStatus(status='done')
        db_t_update = DummyDb(fetchone_val={'id': 1, 'status': 'done'})
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_t_update), \
             patch('buddy_people.community.member'), \
             patch('buddy_people.community.changed'):
            tu_res = routes['update_task'](room_id=1, task_id=1, body=update_body, user={'username': 'alice'})
            self.assertEqual(tu_res['status'], 'done')

        # /rooms/{room_id}/messages/{message_id}/save-note
        save_body = collaboration.SaveNote(title='Note from Chat')
        db_note_save = DummyDb(fetchone_val=[{'body': 'Message content'}, {'id': 7, 'title': 'Note from Chat'}])
        with patch('buddy_people.community.ensure_schema'), \
             patch('app.notes.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_note_save), \
             patch('buddy_people.community.member'), \
             patch.object(collaboration, 'message_in_room', return_value={'body': 'Message content'}), \
             patch('app.notes.default_collection', return_value='Inbox'), \
             patch('app.notes.save_version'), \
             patch('app.notes.serialize', return_value={'id': 7, 'title': 'Note from Chat'}):
            sn_res = routes['save_note'](room_id=1, message_id=10, body=save_body, user={'username': 'alice'})
            self.assertEqual(sn_res['id'], 7)

        # /rooms/{room_id}/notifications GET and PUT
        db_pref = DummyDb(fetchone_val={'mode': 'mentions'})
        with patch('buddy_people.community.ensure_schema'), \
             patch.object(job_queue, '_connect', return_value=db_pref), \
             patch('buddy_people.community.member'), \
             patch('buddy_people.community.changed'):
            pref_get = routes['preferences'](room_id=1, user={'username': 'alice'})
            self.assertEqual(pref_get['mode'], 'mentions')

            pref_put = routes['set_preferences'](room_id=1, body=collaboration.Preferences(mode='all'), user={'username': 'alice'})
            self.assertEqual(pref_put['mode'], 'all')


if __name__ == '__main__':
    unittest.main()
