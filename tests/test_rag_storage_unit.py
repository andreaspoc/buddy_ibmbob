"""Unit tests covering app/rag.py document management, access filters, and parsing."""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import io
import unittest
from unittest.mock import MagicMock, patch
import uuid
import zipfile

from app import rag


class RagStorageUnitTests(unittest.TestCase):
    def setUp(self):
        self.admin = {'username': 'alice', 'is_admin': True, 'employer': 'buddy'}
        self.member = {'username': 'bob', 'is_admin': False, 'employer': 'buddy'}
        self.doc_id = str(uuid.uuid4())

    def test_model_and_ollama_url(self):
        with patch.dict('os.environ', {'BOB_EMBEDDING_MODEL': 'custom-model', 'BOB_OLLAMA_URL': 'http://ollama:11434/'}):
            self.assertEqual(rag.model(), 'custom-model')
            self.assertEqual(rag.ollama_url(), 'http://ollama:11434')

    def test_access_filters(self):
        # Admin access filter
        with patch('app.auth.knowledge_access', return_value={'is_admin': True}):
            clause, params = rag.access_filter('alice', admin=True)
            self.assertEqual(clause, 'TRUE')
            self.assertEqual(params, ())

        # None profile
        with patch('app.auth.knowledge_access', return_value=None):
            clause2, params2 = rag.access_filter('bob')
            self.assertEqual(clause2, 'FALSE')
            self.assertEqual(params2, ())

        # Member profile
        with patch('app.auth.knowledge_access', return_value={'is_admin': False, 'groups': ['g1']}):
            clause3, params3 = rag.access_filter('bob')
            self.assertIn('knowledge_base', clause3)
            self.assertEqual(params3, (['g1'],))

    def test_require_admin_and_validate_classification(self):
        with patch('app.auth.knowledge_access', return_value={'is_admin': False}):
            with self.assertRaises(PermissionError):
                rag.require_admin('bob', False)
            with self.assertRaises(PermissionError):
                rag.require_admin('bob', True)

        with patch('app.auth.knowledge_access', return_value={'is_admin': True}):
            rag.require_admin('alice', True)

        # Classification validation
        with self.assertRaises(ValueError):
            rag.validate_classification('invalid', 'both')
        with self.assertRaises(ValueError):
            rag.validate_classification('company', 'invalid')
        with patch('app.auth.valid_audience', return_value=True):
            self.assertEqual(rag.validate_classification('company', 'g1'), ('company', 'g1'))
        with patch('app.auth.valid_audience', return_value=False), self.assertRaises(ValueError):
            rag.validate_classification('company', 'deleted-group')

    def test_validate_description(self):
        self.assertEqual(rag.validate_description('  Valid description  '), 'Valid description')
        with self.assertRaises(ValueError):
            rag.validate_description('x' * 2001)

    def test_public_document(self):
        now = datetime.now(timezone.utc)
        row = {
            'id': self.doc_id,
            'filename': 'doc.pdf',
            'description': 'desc',
            'status': 'ready',
            'error': None,
            'chunk_count': 5,
            'created_at': now,
            'username': 'alice',
            'content': b'12345',
            'review_due': date(2025, 1, 1),
            'reviewed_at': now,
        }
        pub = rag.public_document(row, 'alice', admin=True)
        self.assertEqual(pub['id'], self.doc_id)
        self.assertEqual(pub['size'], 5)
        self.assertTrue(pub['can_manage'])
        self.assertTrue(pub['review_overdue'])

    def test_add_document(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # Unsupported ext
        with patch.object(rag, 'require_admin'):
            with self.assertRaises(ValueError):
                rag.add_document('alice', 'shared', 'bad.exe', b'content', admin=True)

        # Empty content
        with patch.object(rag, 'require_admin'):
            with self.assertRaises(ValueError):
                rag.add_document('alice', 'shared', 'empty.txt', b'', admin=True)

        # Return prior document
        with patch.object(rag, 'require_admin'), patch.object(rag, 'ensure_schema'), patch('app.rag.job_queue._connect', mock_conn):
            row = {'id': self.doc_id, 'filename': 'doc.pdf', 'description': '', 'status': 'ready', 'error': None, 'chunk_count': 1, 'created_at': datetime.now(timezone.utc), 'username': 'alice', 'size': 10}
            db.execute.return_value.fetchone.return_value = row
            pub = rag.add_document('alice', 'shared', 'doc.pdf', b'sample content', admin=True)
            self.assertEqual(pub['id'], self.doc_id)

        # Library limit 200
        with patch.object(rag, 'require_admin'), patch.object(rag, 'ensure_schema'), patch('app.rag.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: None), # prior
                MagicMock(fetchone=lambda: {'n': 200}), # count >= 200
            ]
            with self.assertRaises(ValueError) as exc:
                rag.add_document('alice', 'shared', 'doc.pdf', b'sample content', admin=True)
            self.assertIn('200 documents', str(exc.exception))

        # Add success
        with patch.object(rag, 'require_admin'), patch.object(rag, 'ensure_schema'), patch('app.rag.job_queue._connect', mock_conn), \
             patch('app.blob_storage.store', return_value={'content': b'blob', 'object_key': 'k', 'object_bucket': 'b', 'size': 14}):
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: None), # prior
                MagicMock(fetchone=lambda: {'n': 10}), # count
                MagicMock(fetchone=lambda: row), # insert
                MagicMock(), # audit
            ]
            pub2 = rag.add_document('alice', 'shared', 'doc.pdf', b'sample content', admin=True)
            self.assertEqual(pub2['id'], self.doc_id)

    def test_update_description_and_classification(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        row = {'id': self.doc_id, 'filename': 'doc.pdf', 'description': 'Updated', 'status': 'ready', 'error': None, 'chunk_count': 1, 'created_at': datetime.now(timezone.utc), 'username': 'alice', 'size': 10}

        # update_description not found
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value=None), patch('app.rag.job_queue._connect', mock_conn):
            res = rag.update_description('alice', 'shared', self.doc_id, 'New desc', admin=True)
            self.assertIsNone(res)

        # update_description success
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value={'id': self.doc_id, 'description': 'Old'}), patch('app.rag.job_queue._connect', mock_conn):
            db.execute.return_value.fetchone.return_value = row
            res2 = rag.update_description('alice', 'shared', self.doc_id, 'Updated', admin=True)
            self.assertEqual(res2['description'], 'Updated')

        # update_classification duplicate
        with patch.object(rag, 'require_admin'), patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value={'id': self.doc_id, 'sha256': 'sha'}), patch('app.rag.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: (1,)), # exists
            ]
            with self.assertRaises(ValueError):
                rag.update_classification('alice', 'shared', self.doc_id, 'company', 'both', admin=True)

    def test_remove_and_retry_document(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # remove not found
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value=None), patch('app.rag.job_queue._connect', mock_conn):
            self.assertFalse(rag.remove_document('alice', 'shared', self.doc_id, admin=True))

        # remove success
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value={'id': self.doc_id}), patch('app.rag.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(), # lock
                MagicMock(fetchone=lambda: (1,)), # delete
                MagicMock(), # audit
            ]
            self.assertTrue(rag.remove_document('alice', 'shared', self.doc_id, admin=True))

        # retry not found
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value=None), patch('app.rag.job_queue._connect', mock_conn):
            self.assertFalse(rag.retry_document('alice', 'shared', self.doc_id, admin=True))

        # retry success
        with patch.object(rag, 'ensure_schema'), patch.object(rag, '_manage_document', return_value={'id': self.doc_id, 'status': 'failed'}), patch('app.rag.job_queue._connect', mock_conn):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: (1,)), # update status
                MagicMock(), # audit
            ]
            self.assertTrue(rag.retry_document('alice', 'shared', self.doc_id, admin=True))

    def test_delete_scope(self):
        self.assertIsNone(rag.delete_scope('alice', 'shared'))

    def test_extract_csv_and_tsv(self):
        csv_data = b"Name,Age,Role\nAlice,30,Engineer\nBob,35,Manager"
        sec = rag.extract('data.csv', csv_data)
        self.assertEqual(len(sec), 2)
        self.assertIn('Alice', sec[0][1])

        tsv_data = b"Name\tScore\nCharlie\t100"
        sec2 = rag.extract('data.tsv', tsv_data)
        self.assertEqual(len(sec2), 1)
        self.assertIn('Charlie', sec2[0][1])


if __name__ == '__main__':
    unittest.main()
