"""Artifact review ownership, revision, and selection boundaries."""
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from pydantic import ValidationError
from app import artifact_comments as review

@contextmanager
def connection(db):
    yield db

class ArtifactCommentTests(TestCase):
    def test_missing_session_prevents_file_access(self):
        with patch.object(review.sessions, 'storage_scope', side_effect=FileNotFoundError), patch.object(review.storage, 'get_file') as file, self.assertRaises(HTTPException) as error:
            review.artifact('other', 'a'*32, 'report.html')
        self.assertEqual(error.exception.status_code, 404)
        file.assert_not_called()

    def test_file_lookup_uses_authenticated_owner_and_session_scope(self):
        with patch.object(review.sessions, 'storage_scope', return_value='project:owned'), patch.object(review.storage, 'get_file', return_value={'sha256':'saved'}) as file:
            self.assertEqual(review.artifact('staff', 'a'*32, 'report.html')['sha256'], 'saved')
        file.assert_called_once_with('staff', 'project:owned', 'report.html')

    def test_blank_review_is_rejected(self):
        for anchor, comment in [(' ', 'Feedback'), ('Slide 1', '\n')]:
            with self.assertRaises(ValidationError):
                review.Comment(session_id='a'*32, path='report.html', anchor=anchor, comment=comment)

    def test_revision_marker_detects_file_changes(self):
        row = {'artifact_sha256':'old', 'created_at':'date', 'updated_at':'date'}
        self.assertTrue(review.serialize(row, 'new')['outdated'])
        self.assertFalse(review.serialize(row, 'old')['outdated'])

    def test_foreign_or_resolved_selection_rejected(self):
        db = MagicMock(); db.execute.return_value.fetchall.return_value = []
        body = review.Selection(session_id='a'*32, path='report.html', ids=[9])
        with patch.object(review, 'ensure_schema'), patch.object(review, 'artifact', return_value={'sha256':'current'}), patch.object(review.job_queue, '_connect', lambda: connection(db)), self.assertRaises(HTTPException) as error:
            review.revision_request(body, {'username':'staff'})
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(db.execute.call_args.args[1], ('staff', 'a'*32, 'report.html', [9]))
        self.assertIn("status='open'", db.execute.call_args.args[0])

    def test_revision_prompt_uses_saved_comments(self):
        db = MagicMock(); db.execute.return_value.fetchall.return_value = [{'id':9,'anchor':'Slide 3','comment':'Explain actual totals','artifact_sha256':'old'}]
        body = review.Selection(session_id='a'*32, path='report.html', ids=[9])
        with patch.object(review, 'ensure_schema'), patch.object(review, 'artifact', return_value={'sha256':'current'}), patch.object(review.job_queue, '_connect', lambda: connection(db)):
            result = review.revision_request(body, {'username':'staff'})
        self.assertIn('Explain actual totals', result['prompt'])
        self.assertIn('"earlier_revision": true', result['prompt'])
        self.assertEqual(result['comment_ids'], [9])

    def test_status_change_does_not_expose_other_users_comment(self):
        db = MagicMock(); db.execute.return_value.fetchone.return_value = None
        with patch.object(review, 'ensure_schema'), patch.object(review.job_queue, '_connect', lambda: connection(db)), patch.object(review, 'artifact') as file, self.assertRaises(HTTPException) as error:
            review.update_comment(9, review.Status(status='resolved'), {'username':'other'})
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(db.execute.call_args.args[1], ('other', 9))
        file.assert_not_called()

if __name__ == '__main__':
    import unittest
    unittest.main()
