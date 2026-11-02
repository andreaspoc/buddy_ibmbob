"""Office upload, token, ownership and callback boundaries; no external services."""
import asyncio
import io
import json
import os
from unittest import TestCase, main
from unittest.mock import MagicMock, patch
from uuid import uuid4
from contextlib import contextmanager
import jwt
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request
from app import office

SECRET = 'office-unit-test-secret-not-production-' * 2

@contextmanager
def connection(db):
    yield db

class OfficeTests(TestCase):
    def test_format_validation_rejects_disguised_uploads(self):
        for extension in ('docx', 'xlsx', 'pptx'):
            with self.assertRaises(HTTPException): office.validate_content(b'not an office file', extension)
        office.validate_content(office.blank_docx(), 'docx')
        office.validate_content(office.blank_pptx(), 'pptx')
        with self.assertRaises(HTTPException): office.validate_content(b'\0\0binary', 'csv')

    @staticmethod
    def pdf_bytes(encrypted=False):
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_blank_page(width=595, height=842)
        if encrypted:
            writer.encrypt('test-password')
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    def test_pdf_validation(self):
        office.validate_content(self.pdf_bytes(), 'pdf')
        for raw in (b'not a PDF', b'%PDF-1.7\ninvalid', self.pdf_bytes(encrypted=True)):
            with self.assertRaises(HTTPException) as failure:
                office.validate_content(raw, 'pdf')
            self.assertEqual(failure.exception.status_code, 422)

    def test_create_pdf_produces_valid_blank_document(self):
        from pypdf import PdfReader
        with patch.object(office, 'store_new', return_value={'id': 'new'}) as store:
            office.create(office.NewFile(name='Report', kind='pdf'), {'username': 'alice'})
        username, name, raw = store.call_args.args
        self.assertEqual((username, name), ('alice', 'Report.pdf'))
        self.assertEqual(len(PdfReader(io.BytesIO(raw)).pages), 1)
        office.validate_content(raw, 'pdf')

    def test_create_form_uses_native_pdf_and_preserves_folder(self):
        from pypdf import PdfReader
        folder = uuid4()
        with patch.object(office, 'store_new', return_value={'id': 'new'}) as store:
            office.create(office.NewFile(name='Application', kind='form', folder_id=folder), {'username': 'alice'})
        username, name, raw, destination = store.call_args.args
        self.assertEqual((username, name, destination), ('alice', 'Application.pdf', folder))
        self.assertEqual(len(PdfReader(io.BytesIO(raw)).pages), 1)
        office.validate_content(raw, 'pdf')

    def test_pdf_editor_preserves_access_and_uses_native_pdf_type(self):
        fid, sid = uuid4(), uuid4()
        for access in ('owner', 'read', 'write'):
            row = {'id': fid, 'username': 'alice', 'name': 'Report.pdf', 'extension': 'pdf',
                   'object_key': 'private.pdf', 'size': 100, 'revision': 1, 'save_sequence': 0,
                   'created_at': 'now', 'saved_at': 'now', 'access': access, 'is_owner': access == 'owner'}
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = {'id': sid}
            with patch.dict(os.environ, {'OFFICE_JWT_SECRET': SECRET}), patch.object(office, 'require_storage'), \
                 patch.object(office, 'ensure_schema'), patch.object(office, '_file', return_value=row), \
                 patch.object(office.job_queue, '_connect', lambda: connection(db)):
                result = office.editor(fid, 'en', {'username': 'alice'})
            config = result['config']
            self.assertEqual(config['documentType'], 'pdf')
            self.assertEqual(config['document']['fileType'], 'pdf')
            self.assertEqual(config['document']['permissions']['edit'], access != 'read')
            self.assertTrue(config['editorConfig']['plugins']['autostart'])
            self.assertEqual(jwt.decode(config['token'], SECRET, algorithms=['HS256'])['documentType'], 'pdf')

    def test_popup_preview_is_signed_read_only_even_for_owner(self):
        fid, sid = uuid4(), uuid4()
        row = {'id': fid, 'username': 'alice', 'name': 'Chat.docx', 'extension': 'docx',
               'object_key': 'private.docx', 'size': 100, 'revision': 1, 'save_sequence': 0,
               'created_at': 'now', 'saved_at': 'now', 'access': 'owner', 'is_owner': True}
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {'id': sid}
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': SECRET}), patch.object(office, 'require_storage'), \
             patch.object(office, 'ensure_schema'), patch.object(office, '_file', return_value=row), \
             patch.object(office.job_queue, '_connect', lambda: connection(db)):
            result = office.editor(fid, 'en', {'username': 'alice'}, view_only=True)
        signed = jwt.decode(result['config']['token'], SECRET, algorithms=['HS256'])
        self.assertEqual(signed['editorConfig']['mode'], 'view')
        for permission in ('edit', 'comment', 'review'):
            self.assertFalse(signed['document']['permissions'][permission])
        self.assertFalse(signed['editorConfig']['customization']['autosave'])

    def test_pdf_callback_persists_pdf_and_save_receipt(self):
        sid, fid = uuid4(), uuid4()
        db = MagicMock()
        db.execute.return_value.fetchone.side_effect = [{'id': sid, 'file_id': fid, 'active': True},
            {'id': fid, 'username': 'alice', 'extension': 'pdf', 'sha256': 'old', 'object_key': 'old'}]
        with patch.object(office, 'ensure_schema'), patch.object(office.job_queue, '_connect', lambda: connection(db)), \
             patch.object(office, 'saved_content', return_value=self.pdf_bytes()), patch.object(office, 'put') as upload:
            result = office.handle_callback({'key': str(sid), 'status': 6, 'filetype': 'pdf',
                'url': 'http://onlyoffice/cache/files/test', 'userdata': 'pdf-receipt'})
        self.assertEqual(result, {'error': 0})
        self.assertEqual(upload.call_args.args[2], 'pdf')
        receipt = next(call for call in db.execute.call_args_list if 'last_receipt=%s' in call.args[0])
        self.assertEqual(receipt.args[1][1], 'pdf-receipt')

    def test_file_lookup_is_bound_to_authenticated_owner(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = None
        file_id = uuid4()
        with self.assertRaises(HTTPException) as failure: office._file(db, file_id, 'alice')
        self.assertEqual(failure.exception.status_code, 404)
        self.assertEqual(db.execute.call_args_list[0].args[1], (str(file_id), 'alice'))

    def test_shared_access_and_owner_only_guards(self):
        db = MagicMock()
        file_id = uuid4()
        # Non-owner with read permission
        db.execute.return_value.fetchone.side_effect = [
            None,
            {'id': file_id, 'username': 'owner_user', 'name': 'Report.docx', 'extension': 'docx', 'share_permission': 'read'}
        ]
        read_row = office._file(db, file_id, 'bob')
        self.assertEqual(read_row['access'], 'read')
        self.assertFalse(read_row['is_owner'])
        # Non-owner with read permission rejected when require_write=True
        db.execute.return_value.fetchone.side_effect = [
            None,
            {'id': file_id, 'username': 'owner_user', 'name': 'Report.docx', 'extension': 'docx', 'share_permission': 'read'}
        ]
        with self.assertRaises(HTTPException) as exc:
            office._file(db, file_id, 'bob', require_write=True)
        self.assertEqual(exc.exception.status_code, 403)
        # Non-owner with write permission allowed when require_write=True
        db.execute.return_value.fetchone.side_effect = [
            None,
            {'id': file_id, 'username': 'owner_user', 'name': 'Report.docx', 'extension': 'docx', 'share_permission': 'write'}
        ]
        write_row = office._file(db, file_id, 'bob', require_write=True)
        self.assertEqual(write_row['access'], 'write')
        # Non-owner rejected when require_owner=True (e.g. delete or modifying shares)
        db.execute.return_value.fetchone.side_effect = [None]
        with self.assertRaises(HTTPException) as exc_own:
            office._file(db, file_id, 'bob', require_owner=True)
        self.assertEqual(exc_own.exception.status_code, 404)

    def test_output_url_rejects_ssrf_and_redirect_targets(self):
        with patch.dict(os.environ, {'OFFICE_INTERNAL_URL': 'http://onlyoffice', 'PUBLIC_BASE_URL': 'https://buddy.example', 'OFFICE_PUBLIC_URL': '/office-editor'}):
            for url in ('http://169.254.169.254/cache/files/a', 'http://onlyoffice.evil/cache/files/a',
                        'http://onlyoffice/cache/files/../secret', 'http://onlyoffice/cache/files/%2e%2e/secret',
                        'http://onlyoffice/admin', 'http://user@onlyoffice/cache/files/a', 'file:///cache/files/a'):
                with self.assertRaises(ValueError, msg=url): office.output_url(url)
            self.assertEqual(office.output_url('https://buddy.example/office-editor/cache/files/a?token=x'), 'http://onlyoffice/cache/files/a?token=x')

    def test_source_token_is_scoped_to_session_and_audience(self):
        sid = uuid4()
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET': SECRET}):
            for token in (jwt.encode({'aud': 'office-source', 'sid': str(uuid4())}, SECRET, algorithm='HS256'),
                          jwt.encode({'aud': 'other', 'sid': str(sid)}, SECRET, algorithm='HS256')):
                with self.assertRaises(HTTPException): office.source(sid, token)

    def callback_request(self, body, token):
        raw = json.dumps(body).encode()
        async def receive(): return {'type':'http.request','body':raw,'more_body':False}
        return Request({'type':'http','method':'POST','path':'/api/office/callback','headers':[(b'authorization', ('Bearer '+token).encode())]}, receive)

    def test_callback_rejects_unsigned_or_modified_save(self):
        payload = {'key': str(uuid4()), 'status': 6, 'url': 'http://onlyoffice/cache/files/a'}
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET':SECRET}), patch.object(office,'handle_callback') as handler:
            token = jwt.encode({'payload':payload}, SECRET, algorithm='HS256')
            for body, signature in ((payload, 'bad'), ({**payload,'url':'http://evil/cache/files/a'},token)):
                with self.assertRaises(HTTPException): asyncio.run(office.callback(self.callback_request(body,signature)))
            handler.assert_not_called()

    def test_editor_config_token_cannot_be_reused_as_save_callback(self):
        with patch.dict(os.environ, {'OFFICE_JWT_SECRET':SECRET}):
            token = jwt.encode({'document':{'key':str(uuid4())}}, SECRET, algorithm='HS256')
            with self.assertRaises(HTTPException): asyncio.run(office.callback(self.callback_request({'status':6},token)))

    def test_failed_office_suite_upload_never_updates_file_pointer(self):
        sid, fid = uuid4(), uuid4()
        session = {'id':sid,'file_id':fid,'active':True}
        row = {'id':fid,'username':'alice','extension':'docx','sha256':'old','object_key':'users/alice/office/old.docx'}
        db=MagicMock()
        db.execute.return_value.fetchone.side_effect=[session,row]
        with patch.object(office,'ensure_schema'), patch.object(office.job_queue,'_connect',lambda:connection(db)), \
             patch.object(office,'saved_content',return_value=office.blank_docx()), patch.object(office,'put',side_effect=OSError('offline')) as upload, self.assertLogs(office.log,level='ERROR'):
            result=office.handle_callback({'key':str(sid),'status':6,'url':'http://onlyoffice/cache/files/a','filetype':'docx'})
        self.assertEqual(result,{'error':1})
        upload.assert_called_once()
        statements=[call.args[0] for call in db.execute.call_args_list]
        self.assertFalse(any('UPDATE office.bob_office_files' in sql for sql in statements))
        self.assertTrue(any('last_error=' in sql for sql in statements))

    def test_saved_callback_commits_pointer_and_correlated_receipt(self):
        sid, fid = uuid4(), uuid4()
        db=MagicMock()
        db.execute.return_value.fetchone.side_effect=[{'id':sid,'file_id':fid,'active':True},
            {'id':fid,'username':'alice','extension':'docx','sha256':'old','object_key':'old'}]
        with patch.object(office,'ensure_schema'),patch.object(office.job_queue,'_connect',lambda:connection(db)), \
             patch.object(office,'saved_content',return_value=office.blank_docx()),patch.object(office,'put',return_value='digest') as upload:
            result=office.handle_callback({'key':str(sid),'status':6,'url':'http://onlyoffice/cache/files/a','userdata':'save-receipt'})
        self.assertEqual(result,{'error':0}); upload.assert_called_once()
        statements=[call.args[0] for call in db.execute.call_args_list]
        self.assertTrue(any('object_key=%s' in sql for sql in statements))
        receipt=next(call for call in db.execute.call_args_list if 'last_receipt=%s' in call.args[0])
        self.assertEqual(receipt.args[1][1],'save-receipt')

    def test_retried_final_callback_cannot_overwrite_new_session(self):
        db=MagicMock(); db.execute.return_value.fetchone.return_value={'active':False}
        with patch.object(office,'ensure_schema'),patch.object(office.job_queue,'_connect',lambda:connection(db)),patch.object(office,'put') as upload:
            result=office.handle_callback({'key':str(uuid4()),'status':2})
        self.assertEqual(result,{'error':0}); upload.assert_not_called()

    def test_rename_file_preserves_extension_and_updates_db(self):
        fid = uuid4()
        row = {'id': fid, 'username': 'alice', 'name': 'Doc.docx', 'extension': 'docx',
               'object_key': 'key', 'size': 100, 'revision': 1, 'save_sequence': 0,
               'created_at': 'now', 'saved_at': 'now', 'access': 'owner', 'is_owner': True}
        updated_row = {**row, 'name': 'Renamed Doc.docx'}
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = updated_row
        with patch.object(office, 'ensure_schema'), patch.object(office, '_file', return_value=row), \
             patch.object(office.job_queue, '_connect', lambda: connection(db)):
            # Case 1: Name without extension gets extension appended
            result = office.rename_file(fid, office.RenameFile(name='Renamed Doc'), {'username': 'alice'})
            self.assertEqual(result['name'], 'Renamed Doc.docx')
            db.execute.assert_called_with(
                '''UPDATE office.bob_office_files SET name=%s WHERE id=%s AND username=%s RETURNING *''',
                ('Renamed Doc.docx', str(fid), 'alice')
            )

            # Case 2: Name with existing extension retains it cleanly
            result2 = office.rename_file(fid, office.RenameFile(name='Renamed Doc.docx'), {'username': 'alice'})
            self.assertEqual(result2['name'], 'Renamed Doc.docx')

    def test_rename_file_rejects_empty_or_invalid_names(self):
        fid = uuid4()
        with patch.object(office, 'ensure_schema'):
            for bad_name in ('', '   ', 'bad\nname', 'bad\tname', 'bad\x00name'):
                with self.subTest(name=bad_name):
                    try:
                        req = office.RenameFile(name=bad_name)
                    except ValidationError:
                        continue
                    with self.assertRaises(HTTPException) as exc:
                        office.rename_file(fid, req, {'username': 'alice'})
                    self.assertEqual(exc.exception.status_code, 422)

    def test_rename_file_requires_owner(self):
        fid = uuid4()
        db = MagicMock()
        with patch.object(office, 'ensure_schema'), patch.object(office.job_queue, '_connect', lambda: connection(db)), \
             patch.object(office, '_file', side_effect=HTTPException(404, 'Office file not found')):
            with self.assertRaises(HTTPException) as exc:
                office.rename_file(fid, office.RenameFile(name='New Name'), {'username': 'bob'})
            self.assertEqual(exc.exception.status_code, 404)

if __name__=='__main__': main()
