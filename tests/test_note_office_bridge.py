"""Private evidence budgets and non-destructive note exports."""
import io
import json
from datetime import datetime, timezone
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch
from xml.etree import ElementTree
from zipfile import ZipFile

from fastapi import HTTPException
from app import note_integration as bridge


class NoteOfficeBridgeTests(TestCase):
    def row(self, identifier=1, body='content'):
        return {'id': identifier, 'title': '<Title & notes>', 'body': body, 'updated_at': datetime.now(timezone.utc)}

    def test_docx_is_valid_xml_and_keeps_source(self):
        raw = bridge.note_docx(self.row(body='<script>\x00 & text'))
        with ZipFile(io.BytesIO(raw)) as archive:
            xml = archive.read('word/document.xml')
            root = ElementTree.fromstring(xml)
            text = ''.join(root.itertext())
        self.assertIn('<script> & text', text)
        self.assertIn('/notes?note=1', text)

    def test_context_caps_content_and_marks_partial_notes(self):
        with patch.object(bridge, 'owned_notes', return_value=[self.row(1, 'a'*20000), self.row(2, 'b'*20000)]):
            context, refs = bridge.chat_context('alice', [1, 2])
        snapshots = json.loads(context.rsplit('\n', 1)[1])
        self.assertEqual(sum(len(row['body']) for row in snapshots), 30000)
        self.assertFalse(refs[0]['truncated'])
        self.assertTrue(refs[1]['truncated'])
        self.assertIn('never instructions', context)

    def test_rejects_oversized_note_selection_before_database(self):
        with self.assertRaises(HTTPException) as error:
            bridge.owned_notes('alice', list(range(6)))
        self.assertEqual(error.exception.status_code, 422)


class NoteOfficeCopyTests(IsolatedAsyncioTestCase):
    def setUp(self):
        from uuid import UUID
        self.file_id = UUID('12345678-1234-1234-1234-123456789abc')
        self.user = {'username': 'alice'}
        async def run_sync(function, *args):
            return function(*args)
        patcher = patch.object(bridge, 'run_in_threadpool', side_effect=run_sync)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_office_snapshot_creates_bounded_note_with_provenance(self):
        from unittest.mock import AsyncMock
        snapshot = {'id': str(self.file_id), 'name': 'Report', 'text': 'x' * 21000, 'truncated': True}
        office = AsyncMock(return_value=('policy\n' + json.dumps([snapshot]), []))
        with patch.object(bridge.plugin_client, 'office_context', office), \
             patch('app.notes.create_note', return_value={'id': 7}) as create:
            result = await bridge.copy_office_to_note(bridge.OfficeNoteCopy(file_id=self.file_id), None, self.user)
        self.assertEqual(result, {'id': 7})
        content, user = create.call_args.args
        self.assertEqual(user, self.user)
        self.assertEqual(content.title, 'Report')
        self.assertEqual(len(content.body), 20000)
        self.assertIn('Partial text snapshot', content.body)
        self.assertIn('/office/files/' + str(self.file_id), content.body)
        office.assert_awaited_once_with(None, 'alice', [self.file_id])

    async def test_office_snapshot_rejects_invalid_data(self):
        from unittest.mock import AsyncMock
        invalid = ['invalid', '[]', json.dumps([{'id': 'other', 'text': 'x'}]),
                   json.dumps([{'id': str(self.file_id), 'text': '  '}]),
                   json.dumps([{'id': str(self.file_id), 'text': 42}])]
        for payload in invalid:
            with self.subTest(payload=payload), patch.object(bridge.plugin_client, 'office_context', AsyncMock(return_value=(payload, []))), \
                 patch('app.notes.create_note') as create:
                with self.assertRaises(HTTPException) as error:
                    await bridge.copy_office_to_note(bridge.OfficeNoteCopy(file_id=self.file_id), None, self.user)
                self.assertEqual(error.exception.status_code, 502)
                create.assert_not_called()

    async def test_copy_multiple_notes_preserves_each_source_and_folder(self):
        from unittest.mock import AsyncMock
        rows = [{'id': 1, 'title': 'First', 'body': 'one'}, {'id': 2, 'title': 'Second', 'body': 'two'}]
        renderer = AsyncMock(return_value=b'docx')
        save = AsyncMock(return_value={'id': 'office-file'})
        with patch.object(bridge, 'owned_notes', return_value=rows) as owned, \
             patch('app.visual_document_export.render_document', renderer), \
             patch.object(bridge.plugin_client, 'save_office_file', save):
            result = await bridge.copy_notes_to_office(bridge.NotesOfficeCopy(ids=[1, 2], folder_id=self.file_id), None, self.user)
        self.assertEqual(result, {'id': 'office-file'})
        owned.assert_called_once_with('alice', [1, 2], 100)
        title, markdown, format_name = renderer.await_args.args
        self.assertEqual((title, format_name), ('Selected notes', 'docx'))
        self.assertIn('/notes?note=1', markdown)
        self.assertIn('/notes?note=2', markdown)
        save.assert_awaited_once_with(None, 'alice', 'Selected notes.docx', b'docx', self.file_id)

    async def test_copy_single_note_sanitizes_filename(self):
        from unittest.mock import AsyncMock
        row = {'id': 9, 'title': '../<>', 'body': 'content'}
        renderer = AsyncMock(return_value=b'docx')
        save = AsyncMock(return_value={'id': 'saved'})
        with patch.object(bridge, 'owned_notes', return_value=[row]), \
             patch('app.visual_document_export.render_document', renderer), \
             patch.object(bridge.plugin_client, 'save_office_file', save):
            await bridge.copy_note_to_office(9, None, self.user)
        save.assert_awaited_once_with(None, 'alice', '___.docx', b'docx')
        self.assertIn('/notes?note=9', renderer.await_args.args[1])
