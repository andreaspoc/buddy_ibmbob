import unittest
from fastapi import HTTPException
from app.conversation_branching import selected_history

class BranchHistoryTests(unittest.TestCase):
    def test_branch_stops_at_selected_completed_turn_and_drops_native_ids(self):
        history = [{'type': 'request', 'prompt': 'first'}, {'type': 'start'},
                   {'type': 'delta', 'text': 'answer'}, {'type': 'done', 'session_id': 'native', 'job_id': 'old'},
                   {'type': 'request', 'prompt': 'later'}, {'type': 'delta', 'text': 'other'}, {'type': 'done'}]
        result = selected_history(history, 0)
        self.assertEqual([e['type'] for e in result], ['request', 'delta', 'done'])
        self.assertEqual(result[-1], {'type': 'done'})
        self.assertNotIn('later', str(result))

    def test_unfinished_turn_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            selected_history([{'type': 'request'}, {'type': 'delta', 'text': 'partial'}], 0)
        self.assertEqual(raised.exception.status_code, 409)

    def test_missing_turn_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            selected_history([], 3)
        self.assertEqual(raised.exception.status_code, 422)

if __name__ == '__main__':
    unittest.main()
