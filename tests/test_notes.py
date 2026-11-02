"""Verify saved-note ownership, validation and pagination boundaries."""
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from pydantic import ValidationError
from app import notes


@contextmanager
def connection(db):
    yield db


class NoteTests(TestCase):
    def test_update_uses_fixed_columns_and_binds_values(self):
        db = MagicMock()
        payload = "title='injected' WHERE true --"
        notes.apply_changes(db, 7, 'alice', {'body': payload, 'title': 'safe'})
        query, params = db.execute.call_args.args
        self.assertNotIn(payload, query)
        self.assertIn('title=CASE WHEN %s THEN %s ELSE title END', query)
        self.assertEqual(params, (True, 'safe', True, payload, False, None, False, None,
                                  False, None, False, None, False, None, 'alice', 7))
        db.reset_mock()
        with self.assertRaises(ValueError):
            notes.apply_changes(db, 7, 'alice', {payload: 'value'})
        db.execute.assert_not_called()

    def row(self, identifier=1):
        return dict(id=identifier, username='alice', title='Title', body='Body', color='butter', collection='',
                    source_session_id=None, source_message_id=None, source_note_index=None,
                    created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))

    def test_validation_rejects_blank_and_unknown_colors(self):
        for values in ({'title': ' ', 'body': 'text'}, {'title': 'title', 'body': ' '},
                       {'title': 'title', 'body': 'text', 'color': 'javascript'}):
            with self.assertRaises(ValidationError):
                notes.NoteCreate(**values)

    def test_source_conversation_requires_ownership(self):
        with patch.object(notes.sessions, 'get_session', side_effect=FileNotFoundError), patch.object(notes, 'ensure_schema') as schema:
            with self.assertRaises(HTTPException) as error:
                notes.create_note(notes.NoteCreate(title='Title', body='Body', source_session_id='a'*32), {'username':'bob'})
            self.assertEqual(error.exception.status_code, 404)
            schema.assert_not_called()

    def test_create_uses_authenticated_owner_and_strips_content(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = self.row()
        with patch.object(notes, 'ensure_schema'), patch.object(notes, 'default_collection', return_value='2026-10-18'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.create_note(notes.NoteCreate(title=' Title ', body=' Body '), {'username':'alice'})
        self.assertEqual(db.execute.call_args.args[1][:8], ('alice', 'Title', 'Body', 'butter', None, None, '2026-10-18', None))
        self.assertEqual(db.execute.call_args.args[1][8].obj, [])
        self.assertFalse(db.execute.call_args.args[1][9])
        self.assertNotIn('username', result)
        self.assertIsInstance(result['created_at'], str)

    def test_paginated_list_is_scoped_and_does_not_drop_cursor(self):
        db = MagicMock(); db.execute.return_value.fetchall.return_value = [self.row(9), self.row(8), self.row(7)]
        with patch.object(notes, 'ensure_schema'), patch.object(notes, 'default_collection', return_value='2026-10-18'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.list_notes(limit=2, before_id=10, user={'username':'alice'})
        self.assertEqual([row['id'] for row in result['items']], [9, 8])
        self.assertEqual(result['next_before_id'], 8)
        self.assertEqual(result['default_collection'], '2026-10-18')
        self.assertEqual(db.execute.call_args.args[1], ('alice', 10, 3))
        self.assertIn('username=%s', db.execute.call_args.args[0])

    def test_update_and_delete_hide_other_users_notes(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = None
        with patch.object(notes, 'ensure_schema'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            for operation in (lambda: notes.update_note(1, notes.NoteContent(title='New', body='Content'), {'username':'bob'}),
                              lambda: notes.delete_note(1, {'username':'bob'})):
                with self.assertRaises(HTTPException) as error:
                    operation()
                self.assertEqual(error.exception.status_code, 404)
                self.assertIn('WHERE username=%s AND id=%s', db.execute.call_args.args[0])
                self.assertEqual(db.execute.call_args.args[1][-2:], ('bob', 1))

    def test_all_routes_require_authentication(self):
        from app.note_details import router as details
        for route in [route for route in notes.router.routes if hasattr(route, 'dependant')] + list(details.routes):
            self.assertTrue(any(dependency.call is notes.current_user for dependency in route.dependant.dependencies))

    def test_source_linked_retry_returns_existing_note_under_transaction_lock(self):
        db = MagicMock()
        existing = self.row(42)
        db.execute.return_value.fetchone.return_value = existing
        body = notes.NoteCreate(title='Title', body='Body', source_session_id='a'*32, source_message_id='answer-1')
        with patch.object(notes, 'ensure_schema'), patch.object(notes.sessions, 'get_session'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.create_note(body, {'username':'alice'})
        self.assertEqual(result['id'], 42)
        self.assertEqual(db.execute.call_count, 2)
        self.assertIn('pg_advisory_xact_lock', db.execute.call_args_list[0].args[0])
        self.assertEqual(db.execute.call_args_list[1].args[1], ('alice', 'a'*32, 'answer-1', 'Title', 'Body', 'butter'))

    def test_source_linked_changed_content_is_inserted(self):
        db = MagicMock()
        db.execute.return_value.fetchone.side_effect = [None, self.row(43)]
        body = notes.NoteCreate(title='Title', body='Changed', source_session_id='a'*32, source_message_id='answer-1')
        with patch.object(notes, 'ensure_schema'), patch.object(notes.sessions, 'get_session'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.create_note(body, {'username':'alice'})
        self.assertEqual(result['id'], 43)
        self.assertIn('INSERT INTO bob_notes', db.execute.call_args.args[0])

    def test_collection_update_and_omitted_collection_preserved(self):
        db = MagicMock(); row = self.row(); updated = {**row, 'collection':'Research'}
        db.execute.return_value.fetchone.side_effect = [row, updated, updated]
        with patch.object(notes, 'ensure_schema'), patch.object(notes, 'save_version'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.update_note(1, notes.NoteContent(title='Title', body='Body', collection=' Research '), {'username':'alice'})
            self.assertEqual(result['collection'], 'Research')
            self.assertEqual(db.execute.call_args.args[1][6:8], (True, 'Research'))
            result = notes.update_note(1, notes.NoteContent(title='Title', body='Body'), {'username':'alice'})
            self.assertEqual(result['collection'], 'Research')
            self.assertTrue(db.execute.call_args.args[0].startswith('SELECT'))
        with self.assertRaises(ValidationError):
            notes.NoteContent(title='Title', body='Body', collection='a'*81)

    def test_edited_saved_draft_deduplicates_by_immutable_index(self):
        db = MagicMock(); row = self.row(9)
        row.update(title='Edited title', source_note_index=2)
        db.execute.return_value.fetchone.return_value = row
        body = notes.NoteCreate(title='Original', body='Original body', source_session_id='a'*32,
                                source_message_id='answer-1', source_note_index=2)
        with patch.object(notes, 'ensure_schema'), patch.object(notes.sessions, 'get_session'), patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            result = notes.create_note(body, {'username':'alice'})
        self.assertEqual(result['id'], 9)
        self.assertEqual(result['title'], 'Edited title')
        self.assertEqual(result['source_note_index'], 2)
        self.assertEqual(db.execute.call_args.args[1], ('alice', 'a'*32, 'answer-1', 2))
        self.assertEqual(db.execute.call_count, 2)
        for index in (-1, 12):
            with self.assertRaises(ValidationError):
                notes.NoteCreate(title='Title', body='Body', source_note_index=index)

    def test_date_collection_uses_configured_timezone_and_falls_back_to_utc(self):
        instant = datetime(2026, 10, 18, 23, 30, tzinfo=timezone.utc)
        with patch.object(notes, 'datetime') as clock:
            clock.now.side_effect = lambda zone: instant.astimezone(zone)
            with patch.dict(notes.os.environ, {'DEFAULT_TIMEZONE':'Europe/London'}):
                self.assertEqual(notes.default_collection(), '2026-10-19')
            with patch.dict(notes.os.environ, {'DEFAULT_TIMEZONE':'invalid/timezone'}):
                self.assertEqual(notes.default_collection(), '2026-10-18')
            with patch.dict(notes.os.environ, {'DEFAULT_TIMEZONE':''}):
                self.assertEqual(notes.default_collection(), '2026-10-18')

    def test_create_preserves_explicit_inbox_or_named_collection(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = self.row()
        with patch.object(notes, 'ensure_schema'), patch.object(notes, 'default_collection') as default, patch.object(notes.job_queue, '_connect', lambda: connection(db)):
            for collection in ('', 'Research'):
                notes.create_note(notes.NoteCreate(title='Title', body='Body', collection=collection), {'username':'alice'})
                self.assertEqual(db.execute.call_args.args[1][6], collection)
            default.assert_not_called()

    def test_tags_sources_and_partial_metadata_validation(self):
        patch_body = notes.NotePatch(tags=[' #Research ', 'research', 'Planning'], favorite=True)
        self.assertEqual(patch_body.tags, ['Research', 'Planning'])
        self.assertEqual(patch_body.model_fields_set, {'tags', 'favorite'})
        for values in ({'tags':['']}, {'tags':['a'*41]}, {'tags':['a']*21}, {'sources':[{'title':'Source', 'url':'javascript:alert(1)'}]}, {'favorite':None}):
            with self.assertRaises(ValidationError):
                notes.NotePatch(**values)


if __name__ == '__main__':
    import unittest
    unittest.main()
