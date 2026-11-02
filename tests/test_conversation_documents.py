"""Bounds and original-file safety for conversation document preparation."""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import unittest
from unittest.mock import MagicMock, patch

from app import conversation_documents as documents


class ConversationDocumentTests(unittest.TestCase):
    def test_markdown_utf8_and_null_cleanup(self):
        text = documents.prepare_text('guide.md', b'\xef\xbb\xbf# Guide\n\nHello\x00')
        self.assertIn('# Guide', text)
        self.assertIn('Hello', text)
        self.assertNotIn('\x00', text)
        self.assertNotIn('\ufeff', text)

    def test_invalid_utf8_rejected(self):
        with self.assertRaises(UnicodeError):
            documents.prepare_text('guide.md', b'\xff\xfe')

    def test_empty_document_rejected(self):
        with self.assertRaises(ValueError):
            documents.prepare_text('guide.md', b'   ')

    def test_extracted_text_limit_includes_location_headers(self):
        with patch.object(documents.rag, 'extract', return_value=[('page 1', 'x' * 1_000_000)]):
            with self.assertRaises(ValueError):
                documents.prepare_text('guide.pdf', b'pdf')

    def test_byte_limit_before_converter(self):
        with patch.object(documents.rag, 'extract') as extract:
            with self.assertRaises(ValueError):
                documents.prepare_text('guide.pdf', b'x' * (documents.MAX_BYTES + 1))
            extract.assert_not_called()

    def test_stale_original_never_reaches_converter(self):
        row = dict(username='alice', scope='session:one', path='guide.md', sha256=hashlib.sha256(b'old').hexdigest())
        with patch.object(documents.storage, 'get_file', return_value={'content': b'new'}), \
             patch.object(documents, 'fail') as fail, \
             patch.object(documents, 'prepare_text') as extract:
            asyncio.run(documents.process(row))
            fail.assert_called_once()
            extract.assert_not_called()

    def test_supported_extensions(self):
        for ext in ('.pdf', '.docx', '.md', '.txt', '.PDF', '.TXT'):
            self.assertTrue(documents.supported(f'test{ext}'))
        for ext in ('.exe', '.py', '.sh', '.html', '.json'):
            self.assertFalse(documents.supported(f'test{ext}'))

    def test_public_fields(self):
        row = {'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'doc.md', 'error': None, 'secret': 'hidden'}
        pub = documents.public(row)
        self.assertEqual(pub, {'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'doc.md', 'error': None})
        self.assertNotIn('secret', pub)

    def test_ensure_schema(self):
        db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = db
        with patch.object(documents.storage, 'ensure_schema'), patch.object(documents.job_queue, '_connect', connect):
            documents._schema_ready = False
            documents.ensure_schema()
            self.assertTrue(documents._schema_ready)
            self.assertGreater(db.execute.call_count, 0)

    def test_enqueue_validations_and_success(self):
        content = b'sample content'
        digest = hashlib.sha256(content).hexdigest()
        with patch.object(documents, 'ensure_schema'), patch.object(documents.storage, 'validate_path'):
            with self.assertRaises(ValueError):
                documents.enqueue('alice', 'session:1', 'bad.exe', 's1')

            with patch.object(documents.storage, 'get_file', return_value=None):
                with self.assertRaises(FileNotFoundError):
                    documents.enqueue('alice', 'session:1', 'doc.pdf', 's1')

            with patch.object(documents.storage, 'get_file', return_value={'content': b'x' * (documents.MAX_BYTES + 1)}):
                with self.assertRaises(ValueError):
                    documents.enqueue('alice', 'session:1', 'doc.pdf', 's1')

            mock_db = MagicMock()
            @contextmanager
            def mock_mutation(u, s, sid):
                yield mock_db

            with patch.object(documents.storage, 'get_file', return_value={'content': content}), \
                 patch.object(documents.storage, 'mutation', side_effect=mock_mutation):
                mock_db.execute.return_value.fetchone.return_value = {'sha256': 'wrong'}
                with self.assertRaises(ValueError):
                    documents.enqueue('alice', 'session:1', 'doc.pdf', 's1')

                def db_side_effect(sql, *args):
                    cur = MagicMock()
                    if 'SELECT sha256' in sql:
                        cur.fetchone.return_value = {'sha256': digest}
                    elif 'SELECT prepared_path' in sql:
                        cur.fetchone.return_value = {'prepared_path': 'document-text/old.md'}
                    elif 'INSERT INTO bob_conversation_documents' in sql:
                        cur.fetchone.return_value = {'path': 'doc.pdf', 'status': 'queued', 'prepared_path': None, 'error': None}
                    else:
                        cur.fetchone.return_value = None
                    return cur

                mock_db.execute.side_effect = db_side_effect
                res = documents.enqueue('alice', 'session:1', 'doc.pdf', 's1')
                self.assertEqual(res['status'], 'queued')
                self.assertEqual(res['path'], 'doc.pdf')

    def test_remove_and_cleanup(self):
        mock_db = MagicMock()
        @contextmanager
        def mock_mutation(u, s, sid):
            yield mock_db

        mock_db.execute.return_value.fetchone.return_value = {'prepared_path': 'document-text/prev.md'}
        with patch.object(documents, 'ensure_schema'), \
             patch.object(documents.storage, 'validate_path'), \
             patch.object(documents.storage, 'mutation', side_effect=mock_mutation):
            documents.remove('alice', 'session:1', 'doc.pdf', 's1')
            self.assertEqual(mock_db.execute.call_count, 2)

    def test_status(self):
        mock_db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = mock_db
        with patch.object(documents, 'ensure_schema'), \
             patch.object(documents.storage, 'validate_path'), \
             patch.object(documents.job_queue, '_connect', connect):

            mock_db.execute.side_effect = [MagicMock(fetchone=lambda: None), MagicMock(fetchone=lambda: None)]
            with self.assertRaises(FileNotFoundError):
                documents.status('alice', 'session:1', 'doc.pdf')

            # sha mismatch
            mock_db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'sha256': 'new_sha'}),
                MagicMock(fetchone=lambda: {'sha256': 'old_sha', 'status': 'queued', 'prepared_path': None, 'error': None}),
            ]
            res = documents.status('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res['status'], 'unprepared')

            # ready but missing prepared file
            mock_db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'sha256': 'good'}),
                MagicMock(fetchone=lambda: {'sha256': 'good', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}),
                MagicMock(fetchone=lambda: None),
            ]
            res2 = documents.status('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res2['status'], 'unprepared')

            # ready and matching
            mock_db.execute.side_effect = [
                MagicMock(fetchone=lambda: {'sha256': 'good'}),
                MagicMock(fetchone=lambda: {'path': 'doc.pdf', 'sha256': 'good', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}),
                MagicMock(fetchone=lambda: {'1': 1}),
            ]
            res3 = documents.status('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res3['status'], 'ready')

    def test_get_preview(self):
        with patch.object(documents, 'status', return_value={'path': 'doc.pdf', 'status': 'unprepared', 'prepared_path': None, 'error': None}):
            res = documents.get_preview('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res['text'], '')
            self.assertFalse(res['truncated'])

        with patch.object(documents, 'status', return_value={'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}), \
             patch.object(documents.storage, 'get_file', return_value={'content': b'Hello preview'}):
            res = documents.get_preview('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res['text'], 'Hello preview')
            self.assertFalse(res['truncated'])

        long_text = 'A' * (documents.PREVIEW_CHARS + 50)
        with patch.object(documents, 'status', return_value={'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}), \
             patch.object(documents.storage, 'get_file', return_value={'content': long_text.encode('utf-8')}):
            res = documents.get_preview('alice', 'session:1', 'doc.pdf')
            self.assertEqual(len(res['text']), documents.PREVIEW_CHARS)
            self.assertTrue(res['truncated'])

        with patch.object(documents, 'status', return_value={'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}), \
             patch.object(documents.storage, 'get_file', return_value=None):
            res = documents.get_preview('alice', 'session:1', 'doc.pdf')
            self.assertEqual(res['status'], 'unprepared')

    def test_context_manifest(self):
        mock_db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = mock_db
        with patch.object(documents, 'ensure_schema'), patch.object(documents.job_queue, '_connect', connect):
            mock_db.execute.return_value.fetchall.return_value = []
            self.assertEqual(documents.context_manifest('alice', 'session:1'), '')

            mock_db.execute.return_value.fetchall.return_value = [{'path': 'doc.pdf'}]
            with patch.object(documents, 'status', return_value={'path': 'doc.pdf', 'status': 'ready', 'prepared_path': 'prep.md', 'error': None}):
                manifest = documents.context_manifest('alice', 'session:1')
                self.assertIn('Conversation document attachments', manifest)
                self.assertIn('doc.pdf', manifest)

    def test_claim_and_renew_and_fail(self):
        mock_db = MagicMock()
        connect = MagicMock()
        connect.return_value.__enter__.return_value = mock_db
        with patch.object(documents, 'ensure_schema'), patch.object(documents.job_queue, '_connect', connect):
            mock_db.execute.return_value.fetchone.return_value = None
            self.assertIsNone(documents.claim())

            mock_db.execute.return_value.fetchone.return_value = {'username': 'alice', 'scope': 's', 'path': 'd.pdf'}
            claimed = documents.claim()
            self.assertIsNotNone(claimed)
            self.assertIn('worker_token', claimed)

            mock_db.execute.return_value.fetchone.return_value = {'path': 'd.pdf'}
            self.assertTrue(documents.renew(claimed))

            documents.fail(claimed, 'Some error occurred')
            self.assertGreater(mock_db.execute.call_count, 1)

    def test_save(self):
        mock_db = MagicMock()
        @contextmanager
        def mock_mutation(u, s, sid):
            yield mock_db

        row = {'username': 'alice', 'scope': 'session:1', 'path': 'doc.pdf', 'sha256': 'abc', 'session_id': 's1', 'worker_token': 't1'}
        with patch.object(documents.storage, 'mutation', side_effect=mock_mutation), \
             patch.object(documents.storage, '_upsert'):
            mock_db.execute.return_value.fetchone.return_value = None
            self.assertFalse(documents.save(row, 'extracted text'))

            mock_db.execute.return_value.fetchone.return_value = {'path': 'doc.pdf'}
            self.assertTrue(documents.save(row, 'extracted text'))

    def test_process_success_and_error(self):
        content = b'# Title\n\nBody content'
        digest = hashlib.sha256(content).hexdigest()
        row = {'username': 'alice', 'scope': 'session:1', 'path': 'doc.md', 'sha256': digest, 'session_id': 's1', 'worker_token': 't1'}

        with patch.object(documents.storage, 'get_file', return_value={'content': content}), \
             patch.object(documents, 'save', return_value=True):
            asyncio.run(documents.process(row))

        with patch.object(documents.storage, 'get_file', return_value={'content': content}), \
             patch.object(documents, 'prepare_text', side_effect=ValueError('Invalid syntax')), \
             patch.object(documents, 'fail') as mock_fail:
            asyncio.run(documents.process(row))
            mock_fail.assert_called_once_with(row, 'Invalid syntax')


if __name__ == '__main__':
    unittest.main()
