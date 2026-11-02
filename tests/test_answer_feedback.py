"""Verify feedback binds to saved answers and enforces source and review boundaries."""
import asyncio
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from app import answer_feedback as feedback


@contextmanager
def connection(db):
    yield db


class AnswerFeedbackTests(TestCase):
    def saved(self, events):
        db = MagicMock()
        first = MagicMock(); first.fetchone.return_value = {'id': 81}
        second = MagicMock(); second.fetchall.return_value = [{'event': item} for item in events]
        db.execute.side_effect = [first, second]
        with patch.object(feedback.sessions, 'get_session'), patch.object(feedback.job_queue, '_connect', lambda: connection(db)):
            return feedback.saved_answer('staff', 'a'*32, 0)

    def test_answer_reconstructed_from_persisted_deltas(self):
        self.assertEqual(self.saved([{'type':'delta','text':'draft'}, {'type':'delta','text':'Final','replace':True}, {'type':'delta','text':' answer'}, {'type':'done'}]), (81, 'Final answer'))

    def test_incomplete_and_error_only_answers_rejected(self):
        for terminal in ('error', 'status'):
            with self.assertRaises(HTTPException) as error:
                self.saved([{'type':'delta','text':'partial'}, {'type':terminal}])
            self.assertEqual(error.exception.status_code, 409)

    def test_cross_user_session_not_found(self):
        with patch.object(feedback.sessions, 'get_session', side_effect=FileNotFoundError), self.assertRaises(HTTPException) as error:
            feedback.saved_answer('other', 'a'*32, 0)
        self.assertEqual(error.exception.status_code, 404)

    def test_arbitrary_source_rejected_before_insert(self):
        body = feedback.Feedback(session_id='a'*32, answer_index=0, category='outdated_policy', source_document_id='11111111-1111-1111-1111-111111111111')
        with patch.object(feedback, 'ensure_schema'), patch.object(feedback, 'saved_answer', return_value=(81, 'Real answer')), patch.object(feedback, 'answer_sources', return_value=[]), patch.object(feedback.job_queue, '_connect') as connect, self.assertRaises(HTTPException) as error:
            feedback.submit_feedback(body, {'username':'staff'})
        self.assertEqual(error.exception.status_code, 403)
        connect.assert_not_called()

    def test_current_acl_filters_cited_sources(self):
        doc = '11111111-1111-1111-1111-111111111111'
        db = MagicMock(); db.execute.return_value.fetchall.return_value = []
        with patch.object(feedback.rag, 'ensure_schema'), patch.object(feedback.rag, 'access_filter', return_value=('audience=%s', ('buddy',))), patch.object(feedback.job_queue, '_connect', lambda: connection(db)):
            self.assertEqual(feedback.answer_sources('staff', f'[Policy](/knowledge/{doc}/file)'), [])
        self.assertIn('audience=%s', db.execute.call_args.args[0])
        self.assertEqual(db.execute.call_args.args[1], ([doc], 'buddy'))

    def test_regular_user_cannot_review_inbox(self):
        with self.assertRaises(HTTPException) as error:
            asyncio.run(feedback.administrator({'username':'staff','is_admin':False}))
        self.assertEqual(error.exception.status_code, 403)

    def test_snapshot_comes_from_storage(self):
        body = feedback.Feedback(session_id='a'*32, answer_index=0, category='incorrect_answer', comment=' Needs review ')
        db = MagicMock(); db.execute.return_value.fetchone.return_value = {'id':7,'status':'open'}
        with patch.object(feedback, 'ensure_schema'), patch.object(feedback, 'saved_answer', return_value=(81, 'Actual saved answer')), patch.object(feedback.job_queue, '_connect', lambda: connection(db)):
            self.assertEqual(feedback.submit_feedback(body, {'username':'staff'}), {'id':7,'status':'open'})
        values = db.execute.call_args.args[1]
        self.assertEqual(values[2], 81)
        self.assertEqual(values[4], 'Actual saved answer')
        self.assertEqual(values[6], 'Needs review')

    def test_quality_uses_period_for_all_aggregates_and_serializes_dates(self):
        from datetime import date
        from uuid import UUID
        db = MagicMock()
        totals = {'reports': 3, 'open': 1, 'reviewed': 1, 'resolved': 1, 'reporters': 2}
        results = [MagicMock() for _ in range(4)]
        results[0].fetchone.return_value = totals
        results[1].fetchall.return_value = [{'category': 'incorrect_answer', 'reports': 3}]
        results[2].fetchall.return_value = [{'source_document_id': UUID(int=1), 'source_filename': 'policy.pdf', 'reports': 3, 'unresolved': 2}]
        results[3].fetchall.return_value = [{'day': date(2026, 10, 14), 'reports': 3, 'resolved': 1}]
        db.execute.side_effect = results
        with patch.object(feedback, 'ensure_schema'), patch.object(feedback.job_queue, '_connect', lambda: connection(db)):
            result = feedback.answer_quality(days=7, user={'username': 'admin'})
        self.assertEqual(result['totals'], totals)
        self.assertEqual(result['sources'][0]['source_document_id'], str(UUID(int=1)))
        self.assertEqual(result['trend'][0]['day'], '2026-10-14')
        for call in db.execute.call_args_list:
            self.assertEqual(call.args[1], (7,))
            self.assertIn('created_at >= now()', call.args[0])

    def test_quality_endpoint_requires_administrator(self):
        route = next(route for route in feedback.router.routes if route.path == '/admin/feedback/quality')
        self.assertTrue(any(dependency.call is feedback.administrator for dependency in route.dependant.dependencies))

if __name__ == '__main__':
    import unittest
    unittest.main()
