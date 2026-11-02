"""Massive hermetic unit tests for Learning Service & Lessons, Community Call Audio, and Workspace Config.

Strictly adheres to the Zero Fake Data Policy. Hermetically mocks all external dependencies,
network sockets, S3/blob storage, Keycloak, and PostgreSQL databases.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, UploadFile, Request, WebSocketDisconnect
from pydantic import ValidationError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
import sys
if str(PROJECT_ROOT / 'plugins' / 'learning') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'learning'))
if str(PROJECT_ROOT / 'plugins' / 'people') not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / 'plugins' / 'people'))

import buddy_learning.service as learning_service
import buddy_learning.lessons as learning_lessons
import buddy_learning.store as learning_store
from buddy_learning.lesson_models import (
    LessonInput, Step, Progress, Check, LessonEditInput, LessonPublishInput, BuddyDraftRequest
)
import buddy_people.community_call_audio as call_audio
from app import workspace_config
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

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class MockAsyncConn:
    def __init__(self, notifies=None):
        self._notifies = notifies or []
        self.executed = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def execute(self, sql, params=None):
        self.executed.append((sql, params))

    async def notifies(self, timeout=5, stop_after=1):
        for n in self._notifies:
            yield n


class CommunityCallAudioDeepTests(unittest.TestCase):
    """Deep coverage for plugins/people/buddy_people/community_call_audio.py."""

    def test_audio_key_and_hello_validation(self):
        valid_x = 'A' * 43
        valid_y = 'B' * 43
        key = call_audio.PublicAudioKey(kty='EC', crv='P-256', x=valid_x, y=valid_y)
        self.assertEqual(key.kty, 'EC')

        with self.assertRaises(ValidationError):
            call_audio.PublicAudioKey(kty='EC', crv='P-256', x='short', y=valid_y)

        cid = uuid4()
        hello = call_audio.AudioHello(client_id=cid, public_key=key)
        self.assertEqual(hello.client_id, cid)

    def test_schema_and_transport(self):
        db = DummyDb()
        call_audio.schema(db)
        self.assertTrue(any('ALTER TABLE people_chat.bob_voice_calls' in sql for sql, _ in db.executed))

        with patch.dict(os.environ, {'PEOPLE_AUDIO_TRANSPORT': 'websocket'}):
            self.assertEqual(call_audio.transport(), 'websocket')
        with patch.dict(os.environ, {'PEOPLE_AUDIO_TRANSPORT': 'webrtc'}):
            self.assertEqual(call_audio.transport(), 'webrtc')
        with patch.dict(os.environ, {'PEOPLE_AUDIO_TRANSPORT': 'invalid'}):
            with self.assertRaises(ValueError):
                call_audio.transport()

    def test_authorize_cases(self):
        db = DummyDb()
        cid = uuid4()
        call_id = uuid4()

        unready_call = {
            'caller': 'alice', 'callee': 'bob', 'status': 'pending',
            'transport': 'websocket', 'caller_client': str(cid),
        }
        with patch('buddy_people.community_calls.read_call', return_value=unready_call):
            with self.assertRaises(HTTPException) as ctx:
                call_audio.authorize(db, 'alice', cid, call_id)
            self.assertEqual(ctx.exception.status_code, 409)

        wrong_tab_call = {
            'caller': 'alice', 'callee': 'bob', 'status': 'accepted',
            'transport': 'websocket', 'caller_client': str(uuid4()),
        }
        with patch('buddy_people.community_calls.read_call', return_value=wrong_tab_call):
            with self.assertRaises(HTTPException) as ctx:
                call_audio.authorize(db, 'alice', cid, call_id)
            self.assertEqual(ctx.exception.status_code, 403)

        ready_call = {
            'caller': 'alice', 'callee': 'bob', 'status': 'accepted',
            'transport': 'websocket', 'caller_client': str(cid),
        }
        with patch('buddy_people.community_calls.read_call', return_value=ready_call):
            row, role = call_audio.authorize(db, 'alice', cid, call_id)
            self.assertEqual(role, 'caller')

    def test_attach_peer_key_and_detach(self):
        cid = uuid4()
        call_id = uuid4()
        audio_id = uuid4()
        pk = {'kty': 'EC', 'crv': 'P-256', 'x': 'A'*43, 'y': 'B'*43}

        busy_call = {
            'caller': 'alice', 'callee': 'bob', 'status': 'accepted',
            'transport': 'websocket', 'caller_client': str(cid), 'caller_audio_id': uuid4(),
        }
        with patch('buddy_people.community_calls.read_call', return_value=busy_call), \
             patch.object(job_queue, '_connect', return_value=DummyDb()):
            with self.assertRaises(HTTPException) as ctx:
                call_audio.attach('alice', cid, call_id, audio_id, pk)
            self.assertEqual(ctx.exception.status_code, 409)

        free_call = {
            'caller': 'alice', 'callee': 'bob', 'status': 'accepted',
            'transport': 'websocket', 'caller_client': str(cid), 'caller_audio_id': None,
        }
        db_attach = DummyDb()
        with patch('buddy_people.community_calls.read_call', return_value=free_call), \
             patch.object(job_queue, '_connect', return_value=db_attach):
            role = call_audio.attach('alice', cid, call_id, audio_id, pk)
            self.assertEqual(role, 'caller')
            self.assertTrue(any('UPDATE people_chat.bob_voice_calls' in sql for sql, _ in db_attach.executed))

        call_with_peer = {
            'caller': 'alice', 'callee': 'bob', 'status': 'accepted',
            'transport': 'websocket', 'caller_client': str(cid), 'caller_audio_id': str(audio_id),
            'callee_audio_key': {'peer': 'key'},
        }
        with patch('buddy_people.community_calls.read_call', return_value=call_with_peer), \
             patch.object(job_queue, '_connect', return_value=DummyDb()):
            p_key = call_audio.peer_key('alice', cid, call_id, audio_id)
            self.assertEqual(p_key, {'peer': 'key'})

        db_detach = DummyDb(fetchone_val={
            'caller': 'alice', 'callee': 'bob', 'caller_client': str(cid),
            'caller_audio_id': str(audio_id), 'status': 'active',
        })
        with patch.object(job_queue, '_connect', return_value=db_detach), \
             patch('buddy_people.community_calls.end') as mock_end:
            call_audio.detach('alice', cid, call_id, audio_id)
            mock_end.assert_called_once()
            self.assertTrue(any('UPDATE people_chat.bob_voice_calls' in sql for sql, _ in db_detach.executed))

    def test_register_router_websocket_origin_check(self):
        router = APIRouter()
        call_audio.register(router, current_user=AsyncMock())
        routes = {route.path: route.endpoint for route in router.routes}
        self.assertIn('/calls/{call_id}/audio', routes)

        mock_ws = AsyncMock()
        mock_ws.headers = {'origin': 'https://attacker.com', 'host': 'buddy.example.com'}
        asyncio.run(routes['/calls/{call_id}/audio'](mock_ws, uuid4()))
        mock_ws.close.assert_called_once_with(code=1008)

    def test_audio_socket_loop_and_packet_relay(self):
        router = APIRouter()
        mock_user_dep = AsyncMock(return_value={'username': 'alice'})
        call_audio.register(router, current_user=mock_user_dep)
        handler = [route.endpoint for route in router.routes if route.path == '/calls/{call_id}/audio'][0]

        call_id = uuid4()
        cid = uuid4()
        audio_id = uuid4()
        hello_payload = json.dumps({
            'client_id': str(cid),
            'public_key': {'kty': 'EC', 'crv': 'P-256', 'x': 'A'*43, 'y': 'B'*43}
        })
        valid_packet = b'\x01' * call_audio.FRAME_BYTES

        mock_event_ready = SimpleNamespace(
            channel=call_audio.CHANNEL,
            payload=json.dumps({'kind': 'ready', 'call_id': str(call_id)})
        )
        mock_event_audio = SimpleNamespace(
            channel=call_audio.CHANNEL,
            payload=json.dumps({
                'kind': 'audio',
                'call_id': str(call_id),
                'sender': 'callee',
                'data': base64.b64encode(valid_packet).decode('ascii')
            })
        )

        mock_listener = MockAsyncConn(notifies=[mock_event_ready, mock_event_audio])
        mock_writer = MockAsyncConn()

        async def fake_connect(dsn, autocommit=True):
            if not mock_listener.executed:
                return mock_listener
            return mock_writer

        mock_ws = AsyncMock()
        mock_ws.headers = {'origin': 'https://buddy.local', 'host': 'buddy.local'}
        mock_ws.receive_text = AsyncMock(return_value=hello_payload)
        delivered = asyncio.Event()
        mock_ws.send_bytes.side_effect = lambda packet: delivered.set()
        async def receive_frame():
            await asyncio.wait_for(delivered.wait(), timeout=1)
            return {'type': 'websocket.disconnect'}
        mock_ws.receive = AsyncMock(side_effect=receive_frame)

        with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://test:test@localhost/test'}), \
             patch('psycopg.AsyncConnection.connect', side_effect=fake_connect), \
             patch.object(call_audio, 'attach', return_value='caller'), \
             patch.object(call_audio, 'peer_key', return_value={'kty': 'EC', 'crv': 'P-256', 'x': 'B'*43, 'y': 'A'*43}), \
             patch.object(call_audio, 'detach'):
            asyncio.run(handler(mock_ws, call_id))

        mock_ws.accept.assert_called_once()
        self.assertTrue(mock_ws.send_json.called)
        self.assertTrue(mock_ws.send_bytes.called)


class LearningLessonsDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/learning/buddy_learning/lessons.py."""

    def test_lesson_plain_excerpts_and_truncation(self):
        spec = {
            'description': 'Introduction to testing',
            'steps': [
                {
                    'title': 'Chapter 1',
                    'text': 'Core concepts',
                    'options': ['Option A', 'Option B'],
                    'feedback': 'Good explanation',
                    'board': {'cards': [{'title': 'Card 1', 'body': 'Details'}]},
                }
            ]
        }
        excerpts, truncated = learning_lessons.lesson_plain_excerpts(spec, max_chars=5000)
        self.assertFalse(truncated)
        self.assertEqual(len(excerpts), 2)
        self.assertEqual(excerpts[0]['section'], 'Introduction')

        short_excerpts, short_truncated = learning_lessons.lesson_plain_excerpts(spec, max_chars=15)
        self.assertTrue(short_truncated)

    def test_lookup_and_check_assets(self):
        db = DummyDb()
        user = {'username': 'alice'}
        fid = uuid4()
        lid = uuid4()

        db.fetchone_val = None
        with self.assertRaises(HTTPException) as ctx:
            learning_lessons.lookup(db, lid, user)
        self.assertEqual(ctx.exception.status_code, 404)

        row = {'id': lid, 'folder_id': fid, 'created_by': 'bob', 'status': 'published', 'version': 1}
        db.fetchone_val = row
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                learning_lessons.lookup(db, lid, user, edit=True)
            self.assertEqual(ctx.exception.status_code, 403)

        spec_bad_asset = LessonInput(
            title='Lesson',
            steps=[Step(id=str(uuid4()), title='S1', kind='image', asset_id=uuid4())]
        )
        db_asset = DummyDb(fetchone_val={'mime': 'video/mp4'})
        with self.assertRaises(HTTPException) as ctx:
            learning_lessons.check_assets(db_asset, fid, spec_bad_asset)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_public_spec_and_clean_lesson_dump(self):
        spec = {
            'title': 'Math',
            'steps': [{'id': '1', 'title': 'Q1', 'answer': 2, 'feedback': 'Hint', 'teacher_notes': 'Confidential'}],
            'translations': {
                'el': {
                    'title': 'Math GR',
                    'steps': [{'id': '1', 'title': 'Q1 GR', 'answer': 2, 'feedback': 'Hint GR'}],
                }
            }
        }
        pub = learning_lessons.public_spec(spec)
        self.assertNotIn('answer', pub['steps'][0])
        self.assertNotIn('feedback', pub['steps'][0])
        self.assertNotIn('teacher_notes', pub['steps'][0])
        self.assertNotIn('answer', pub['translations']['el']['steps'][0])

        inp = LessonInput(title='Title', steps=[Step(id=str(uuid4()), title='S1')])
        dumped = learning_lessons.clean_lesson_dump(inp)
        self.assertNotIn('translations', dumped)

    def test_lesson_lifecycle_endpoints(self):
        fid = uuid4()
        lid = uuid4()
        teacher_user = {'username': 'alice'}

        inp = LessonInput(title='New Lesson', steps=[Step(id=str(uuid4()), title='Step 1')])
        db_create = DummyDb(fetchone_val=[{'next_ord': 0}, {'id': str(lid)}])
        with patch.object(learning_store, 'folder'), \
             patch.object(job_queue, '_connect', return_value=db_create):
            created = learning_lessons.create(fid, inp, user=teacher_user)
            self.assertEqual(created['id'], str(lid))

        lesson_row = {
            'id': str(lid), 'folder_id': str(fid), 'title': 'New Lesson',
            'draft': {'title': 'New Lesson', 'steps': [{'id': 's1', 'title': 'Step 1'}]},
            'published': {'title': 'New Lesson Pub', 'steps': [{'id': 's1', 'title': 'Step 1'}]},
            'version': 1, 'status': 'published', 'created_by': 'alice',
        }
        db_info = DummyDb(fetchone_val=[lesson_row, {'step': 0, 'completed': False}])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(job_queue, '_connect', return_value=db_info):
            info_creator = learning_lessons.info(lid, user=teacher_user)
            self.assertTrue(info_creator['is_creator'])

        db_pub = DummyDb(fetchone_val=[lesson_row])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(job_queue, '_connect', return_value=db_pub):
            pub_res = learning_lessons.publish(lid, LessonPublishInput(), user=teacher_user)
            self.assertTrue(pub_res['published'])

        db_close = DummyDb(fetchone_val=[lesson_row])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(job_queue, '_connect', return_value=db_close):
            close_res = learning_lessons.close(lid, user=teacher_user)
            self.assertTrue(close_res['closed'])

        db_del = DummyDb(fetchone_val=[lesson_row])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(job_queue, '_connect', return_value=db_del):
            del_res = learning_lessons.delete_lesson(lid, user=teacher_user)
            self.assertTrue(del_res['deleted'])

    def test_progress_and_interactive_check(self):
        lid = uuid4()
        user = {'username': 'bob'}
        lesson_row = {
            'id': str(lid), 'folder_id': str(uuid4()), 'title': 'Quiz Lesson',
            'version': 1, 'status': 'published', 'created_by': 'alice',
            'published': {
                'steps': [
                    {'id': 'step_1', 'kind': 'question', 'options': ['Opt 1', 'Opt 2'], 'answer': 1, 'feedback': 'Correct!'}
                ]
            }
        }
        db_prog = DummyDb(fetchone_val=[lesson_row])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=False), \
             patch.object(job_queue, '_connect', return_value=db_prog), \
             patch('buddy_learning.course_completion.check_and_issue_for_folder') as mock_issue:
            res_p = learning_lessons.progress(lid, Progress(version=1, step=0, completed=True), user=user)
            self.assertTrue(res_p['saved'])
            mock_issue.assert_called_once()

        db_check = DummyDb(fetchone_val=[lesson_row])
        req_mock = MagicMock()
        req_mock.headers = {'x-learning-language': 'en'}
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=False), \
             patch.object(job_queue, '_connect', return_value=db_check):
            check_res = learning_lessons.check(
                lid, Check(version=1, step_id='step_1', answer=1),
                request=req_mock, user=user
            )
            self.assertTrue(check_res['correct'])
            self.assertEqual(check_res['feedback'], 'Correct!')

    def test_upload_bytes_limits(self):
        empty_file = AsyncMock()
        empty_file.read = AsyncMock(side_effect=[b''])
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(learning_lessons.upload_bytes(empty_file))
        self.assertEqual(ctx.exception.status_code, 422)

        huge_chunk = b'A' * (learning_lessons.MAX_UPLOAD + 1)
        large_file = AsyncMock()
        large_file.read = AsyncMock(side_effect=[huge_chunk, b''])
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(learning_lessons.upload_bytes(large_file))
        self.assertEqual(ctx.exception.status_code, 413)

        valid_file = AsyncMock()
        valid_file.read = AsyncMock(side_effect=[b'valid lesson data', b''])
        raw = asyncio.run(learning_lessons.upload_bytes(valid_file))
        self.assertEqual(raw, b'valid lesson data')

    def test_upload_asset_and_media_streaming(self):
        fid = uuid4()
        lid = uuid4()
        aid = uuid4()
        user = {'username': 'alice'}

        file_mock = AsyncMock()
        png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + b'\x00' * 50
        file_mock.read = AsyncMock(side_effect=[png_bytes, b''])
        file_mock.filename = 'diagram.png'

        mock_s3 = MagicMock()
        db_asset = DummyDb()
        with patch.object(learning_store, 'folder'), \
             patch.object(job_queue, '_connect', return_value=db_asset), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(learning_lessons, 's3', return_value=mock_s3):
            res = asyncio.run(learning_lessons.upload_asset(fid, file_mock, user=user))
            self.assertEqual(res['mime'], 'image/png')
            mock_s3.put_object.assert_called_once()

        # Media retrieval with HTTP Range support
        req_range = MagicMock()
        req_range.headers = {'range': 'bytes=0-10'}
        lesson_row = {
            'id': str(lid), 'folder_id': str(fid), 'created_by': 'alice',
            'draft': {'steps': [{'asset_id': str(aid)}]},
            'published': {'steps': [{'asset_id': str(aid)}]},
        }
        asset_row = {
            'id': str(aid), 'folder_id': str(fid), 'size': 100,
            'object_key': f'learning/lessons/{fid}/{aid}', 'mime': 'image/png'
        }
        db_media = DummyDb(fetchone_val=asset_row)
        mock_body = MagicMock()
        mock_body.read.return_value = b'12345678901'
        mock_s3.get_object.return_value = {'Body': mock_body}

        with patch.object(learning_lessons, 'lookup', return_value=(lesson_row, True)), \
             patch.object(job_queue, '_connect', return_value=db_media), \
             patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(learning_lessons, 's3', return_value=mock_s3):
            resp = learning_lessons.media(lid, aid, req_range, user=user)
            self.assertEqual(resp.status_code, 206)
            self.assertIn('Content-Range', resp.headers)

    def test_import_document_and_buddy_draft(self):
        fid = uuid4()
        user = {'username': 'alice'}

        doc_file = AsyncMock()
        doc_file.read = AsyncMock(side_effect=[b'raw document content', b''])
        doc_file.filename = 'lesson.docx'

        parsed_doc = {
            'title': 'Test Course',
            'chapters': [{'id': 'c1', 'title': 'Chapter 1'}]
        }
        with patch.object(learning_store, 'folder'), \
             patch.object(job_queue, '_connect', return_value=DummyDb()), \
             patch('buddy_learning.lessons.parse_document', return_value=parsed_doc), \
             patch('buddy_learning.lessons.render_chapter', return_value='<p>Lesson text here</p>'):
            res = asyncio.run(learning_lessons.import_document(fid, doc_file, user=user))
            self.assertEqual(res['title'], 'Test Course')
            self.assertEqual(len(res['steps']), 1)

        # buddy_draft with mock draft AI
        req = BuddyDraftRequest(message='Draft a math lesson', language='en')
        proposal = LessonInput(title='Math AI', steps=[Step(id=str(uuid4()), title='AI Step 1')])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(learning_lessons, '_is_real_db', return_value=True), \
             patch.object(job_queue, '_connect', return_value=DummyDb()), \
             patch('buddy_learning.lesson_ai.draft', new_callable=AsyncMock, return_value=(proposal, False)), \
             patch('buddy_learning.service._translate_json_payload', new_callable=AsyncMock, return_value={'title': 'Math Trans'}):
            draft_res = asyncio.run(learning_lessons.buddy_draft(fid, req, user=user))
            self.assertEqual(draft_res['draft']['title'], 'Math AI')
            self.assertIn('translations', draft_res['draft'])


class LearningServiceDeepCoverageTests(unittest.TestCase):
    """Deep coverage for plugins/learning/buddy_learning/service.py."""

    def test_enrich_folders_metadata(self):
        fid = uuid4()
        items = [{'id': fid, 'name': 'Physics 101', 'created_by': 'alice'}]
        meta_row = {
            'folder_id': str(fid), 'created_by': 'alice', 'description': 'Intro to physics',
            'translations': {'el': {'title': 'Φυσική'}}, 'approved_languages': ['el'],
            'teacher_username': 'alice', 'teacher_display_name': 'Prof. Alice',
            'lesson_count': 5, 'completed_lesson_count': 2, 'quiz_count': 1,
            'submitted_quiz_count': 1, 'book_count': 3, 'note_count': 4,
            'member_count': 10, 'has_certificate': True,
        }
        db = DummyDb(fetchall_val=[[meta_row]])
        user = {'username': 'alice'}
        with patch.object(learning_store, 'can_create', return_value=True), \
             patch('buddy_learning.classrooms.ensure_folder_classes'):
            enriched = learning_service._enrich_folders(db, items, user)
            self.assertEqual(len(enriched), 1)
            self.assertEqual(enriched[0]['lesson_count'], 5)
            self.assertTrue(enriched[0]['has_certificate'])
            self.assertTrue(enriched[0]['can_manage'])

    def test_rename_folder_validation_and_update(self):
        fid = uuid4()
        user = {'username': 'admin'}

        inp_move = learning_service.FolderInput(name='Renamed', parent_id=uuid4())
        with self.assertRaises(HTTPException) as ctx:
            learning_service.rename_folder(fid, inp_move, user=user)
        self.assertEqual(ctx.exception.status_code, 422)

        inp_valid = learning_service.FolderInput(name='New Name', description='Updated desc')
        db = DummyDb(fetchone_val={'id': str(fid), 'name': 'New Name', 'parent_id': None})
        with patch.object(learning_store, 'folder'), \
             patch.object(job_queue, '_connect', return_value=db), \
             patch.object(learning_service, '_enrich_folders', return_value=[{'id': fid, 'name': 'New Name'}]):
            res = learning_service.rename_folder(fid, inp_valid, user=user)
            self.assertEqual(res['name'], 'New Name')

    def test_me_and_users_and_groups_endpoints(self):
        user = {'username': 'alice', 'is_admin': True}
        db = DummyDb(fetchall_val=[
            [{'username': 'alice', 'display_name': 'Alice User'}],
            [{'path': '/Training/Engineers'}]
        ])
        with patch.object(job_queue, '_connect', return_value=db), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(learning_service, 'realm', return_value='test-realm'):
            me_res = learning_service.me(user=user)
            self.assertEqual(me_res['username'], 'alice')
            self.assertTrue(me_res['can_create_quizzes'])

            users_res = learning_service.users(user=user)
            self.assertEqual(len(users_res['items']), 1)

            groups_res = learning_service.groups(user=user)
            self.assertEqual(len(groups_res['items']), 1)

    def test_create_folder_and_members_management(self):
        fid = uuid4()
        user = {'username': 'admin', 'is_admin': True}
        inp = learning_service.FolderInput(
            name='Algorithms', description='Data structures and sorting',
            translations={'el': {'title': 'Αλγόριθμοι'}},
            approved_languages=['el']
        )
        db_create = DummyDb(fetchone_val={'id': str(fid), 'name': 'Algorithms', 'parent_id': None})
        with patch.object(job_queue, '_connect', return_value=db_create), \
             patch.object(learning_service, '_enrich_folders', return_value=[{'id': str(fid), 'name': 'Algorithms'}]):
            created = learning_service.create_folder(inp, user=user)
            self.assertEqual(created['name'], 'Algorithms')

        # Invalid Keycloak group path raises 422
        bad_members = learning_service.Members(usernames=['alice'], groups=['invalid-path-without-slash'])
        with self.assertRaises(HTTPException) as ctx:
            learning_service.set_members(fid, bad_members, user=user)
        self.assertEqual(ctx.exception.status_code, 422)

        # Valid set_members
        good_members = learning_service.Members(
            usernames=['alice', 'bob'], groups=['/Engineering/Dev'],
            teacher_username='alice'
        )
        db_mem = DummyDb(fetchone_val={'id': str(fid), 'teacher_username': 'alice'}, fetchall_val=[{'username': 'alice'}, {'username': 'bob'}])
        with patch.object(job_queue, '_connect', return_value=db_mem), \
             patch.object(learning_store, 'folder'), \
             patch.object(learning_service, 'realm', return_value='test-realm'), \
             patch('buddy_learning.classrooms.ensure_folder_classes'):
            set_res = learning_service.set_members(fid, good_members, user=user)
            self.assertEqual(len(set_res['items']), 2)

    def test_contents_and_object_bytes(self):
        fid = uuid4()
        user = {'username': 'alice'}
        db_contents = DummyDb(fetchall_val=[
            [{'id': str(uuid4()), 'title': 'Python Guide', 'author': 'Guido', 'extension': 'epub'}],
            [{'id': str(uuid4()), 'title': 'Midterm', 'is_creator': True, 'status': 'published', 'version': 1, 'submitted': False}],
            [{'id': str(uuid4()), 'title': 'Lesson 1', 'status': 'published', 'version': 1, 'is_creator': True, 'ordinal': 0}],
        ])
        with patch.object(learning_store, 'folder'), \
             patch.object(learning_store, 'can_create', return_value=True), \
             patch.object(learning_service, '_is_real_db', return_value=False), \
             patch.object(job_queue, '_connect', return_value=db_contents):
            cont = learning_service.contents(fid, user=user)
            self.assertEqual(len(cont['books']), 1)
            self.assertEqual(len(cont['quizzes']), 1)
            self.assertEqual(len(cont['lessons']), 1)

        # object_bytes
        mock_s3 = MagicMock()
        mock_body = MagicMock()
        mock_body.read.return_value = b'small ebook content'
        mock_s3.get_object.return_value = {'Body': mock_body}
        with patch.dict(os.environ, {'BOB_S3_BUCKET': 'test-bucket'}), \
             patch.object(learning_service, 's3', return_value=mock_s3):
            data = learning_service.object_bytes('key/book.epub')
            self.assertEqual(data, b'small ebook content')


class WorkspaceConfigDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/workspace_config.py."""

    def test_root_and_select_root(self):
        p = Path('/custom/workspace')
        workspace_config.select_root(p)
        self.assertEqual(workspace_config._root(), p)

    def test_skill_validation_and_crud(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace_config.select_root(root)

            with self.assertRaises(ValueError):
                workspace_config._validate_skill("INVALID_NAME_WITH_CAPS")
            with self.assertRaises(ValueError):
                workspace_config._validate_skill("valid-name", instructions="   ")

            created = workspace_config.create_skill(
                "python-reviewer",
                "Reviews Python backend code",
                "Review PEP 8 and hermetic unit testing."
            )
            canonical_name = created["name"]
            self.assertTrue(canonical_name.startswith("python-reviewer"))

            got = workspace_config.get_skill(canonical_name)
            self.assertEqual(got["name"], canonical_name)
            self.assertIn("PEP 8", got["instructions"])

            updated = workspace_config.update_skill(
                canonical_name,
                "Updated description",
                "New strict instructions."
            )
            self.assertEqual(updated["description"], "Updated description")

            skills = workspace_config.list_skills()
            self.assertTrue(any(s["name"] == canonical_name for s in skills))

            # Delete skill
            workspace_config.delete_skill(canonical_name)
            with self.assertRaises(KeyError):
                workspace_config.get_skill(canonical_name)

    def test_mode_management_and_validation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace_config.select_root(root)

            modes = workspace_config.list_modes()
            slugs = {m["slug"] for m in modes}
            self.assertIn("agent", slugs)
            self.assertIn("plan", slugs)

            with self.assertRaises(ValueError):
                workspace_config.create_mode(
                    "custom-mode", "Custom Mode", "Desc", "Role", "Instructions",
                    groups=["invalid_group"]
                )

            with self.assertRaises(FileExistsError):
                workspace_config.create_mode(
                    "agent", "Duplicate Agent", "Desc", "Role", "Instructions",
                    groups=["read"]
                )

            created_mode = workspace_config.create_mode(
                "qa-mode", "QA Mode", "Quality Assurance", "QA Engineer", "Verify coverage",
                groups=["read", "execute"]
            )
            self.assertEqual(created_mode["slug"], "qa-mode")

            all_modes = workspace_config.list_modes()
            self.assertTrue(any(m["slug"] == "qa-mode" for m in all_modes))

    def test_mcp_config_building_and_registry(self):
        cfg = workspace_config.build_mcp_config(
            'stdio', '', 'python3', ['-m', 'app.mcp_search'],
            {}, {}, {'BRAVE_API_KEY': 'secret123'}, '', '', ''
        )
        self.assertEqual(cfg['command'], 'python3')
        self.assertEqual(cfg['env']['BRAVE_API_KEY'], 'secret123')

        with patch.object(workspace_config, 'migrate_mcp_registry'), \
             patch('app.mcp_access.create', return_value={'name': 'my-mcp'}) as mock_create, \
             patch('app.mcp_access.delete', return_value=True) as mock_delete, \
             patch('app.mcp_access.update', return_value={'name': 'my-mcp'}) as mock_update:
            res_c = workspace_config.create_mcp(
                'my-mcp', 'stdio', '', 'python3', ['-m', 'app.mcp_search'],
                {}, {}, {'BRAVE_API_KEY': 'secret123'}, '', '', ''
            )
            self.assertEqual(res_c['name'], 'my-mcp')

            res_u = workspace_config.update_mcp(
                'my-mcp', transport='stdio', url='', command='python3',
                args=['-m', 'app.mcp_search'], parameters={}, headers={},
                env={'BRAVE_API_KEY': 'secret456'}, api_key='', api_key_name='', api_key_prefix=''
            )
            self.assertEqual(res_u['name'], 'my-mcp')

            res_d = workspace_config.delete_mcp('my-mcp')
            self.assertTrue(res_d)

    def test_build_mcp_config_transports_and_validation(self):
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config('ftp', '', '', [], {}, {}, {}, '', '', '')

        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config('stdio', '', '', [], {}, {}, {}, '', '', '')

        cfg_http = workspace_config.build_mcp_config(
            'http', 'https://api.example.com/mcp', '', [],
            {'version': 'v1'}, {'X-Custom': '1'}, {}, 'my-key', 'X-Api-Key', 'Bearer '
        )
        self.assertIn('https://api.example.com/mcp?version=v1', cfg_http['httpURL'])
        self.assertEqual(cfg_http['headers']['X-Api-Key'], 'Bearer my-key')

        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config('http', 'not-a-valid-url', '', [], {}, {}, {}, '', '', '')

        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config(
                'http', 'https://api.example.com', '', [], {}, {}, {}, 'key', 'Bad:Header\n', ''
            )

    def test_agent_management_and_credential_sanitization(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace_config.select_root(root)

            with self.assertRaises(ValueError):
                workspace_config.create_agent("catalog-test", {})

            agent_data = {
                "name": "Research Agent",
                "api_key": "SUPER_SECRET",
                "auth_token": "BEARER_TOKEN",
                "url": "https://api.example.com",
            }
            created = workspace_config.create_agent("researcher", agent_data)
            self.assertNotIn("api_key", created)
            self.assertNotIn("auth_token", created)
            self.assertEqual(created["url"], "https://api.example.com")

            # Duplicate agent raises FileExistsError
            with self.assertRaises(FileExistsError):
                workspace_config.create_agent("researcher", agent_data)

            # Get agent
            stored = workspace_config.get_agent("researcher")
            self.assertEqual(stored["api_key"], "SUPER_SECRET")

            # Update agent
            updated = workspace_config.update_agent("researcher", {"name": "Senior Researcher"})
            self.assertEqual(updated["name"], "Senior Researcher")

            # Delete agent
            workspace_config.delete_agent("researcher")
            self.assertIsNone(workspace_config.get_agent("researcher"))

            with self.assertRaises(KeyError):
                workspace_config.delete_agent("researcher")


if __name__ == '__main__':
    unittest.main()
