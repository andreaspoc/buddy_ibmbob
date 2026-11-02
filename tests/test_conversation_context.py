import json
import unittest
from app.conversation_context import add_conversation_context


class ContextTests(unittest.TestCase):
    def test_empty_workspace_still_prohibits_other_project_files(self):
        result = add_conversation_context('An unrelated question', [], [], workspace='/tmp/personal')
        self.assertIn('[Conversation workspace boundary]', result)
        self.assertIn('/tmp/personal', result)
        self.assertIn('Do not search other projects or conversations', result)
        self.assertIn('unrelated questions do not require them', result)

    def history(self):
        return [
            {'type': 'request', 'prompt': '[Attached spreadsheet: sales.csv]\nAnalyze revenue by region'},
            {'type': 'delta', 'text': 'Old draft'},
            {'type': 'delta', 'text': 'North is highest', 'replace': True},
            {'type': 'done', 'session_id': 'old-task'},
            {'type': 'request', 'prompt': 'What about South?'},
        ]

    def test_resumed_followup_gets_current_file_manifest(self):
        result = add_conversation_context('What about South?', [], [{'path': 'sales.csv', 'size': 120}], workspace='/tmp/new-job')
        self.assertIn('sales.csv', result)
        self.assertIn('/tmp/new-job', result)
        self.assertIn('full rows', result)
        self.assertNotIn('Previous turns', result)

    def test_fresh_session_recovers_attachment_and_prior_question(self):
        result = add_conversation_context('What about South?', self.history(), [{'path': 'sales.csv', 'size': 120}], workspace='/tmp/new-job', include_history=True)
        self.assertIn('[Attached spreadsheet: sales.csv]', result)
        self.assertIn('Analyze revenue by region', result)
        self.assertIn('North is highest', result)
        self.assertNotIn('Old draft', result)
        self.assertEqual(result.count('What about South?'), 1)

    def test_missing_file_is_not_claimed_present(self):
        result = add_conversation_context('What about South?', self.history(), [], workspace='/tmp/new-job', include_history=True)
        self.assertNotIn('Current conversation spreadsheet files', result)
        self.assertIn('Previous turns', result)

    def test_note_destination_correction_keeps_prior_task(self):
        history = [{'type': 'request', 'prompt': 'Create a note about Docmost spaces'},
                   {'type': 'delta', 'text': 'Created a Docmost page in General'},
                   {'type': 'request', 'prompt': 'no I need note here'}]
        result = add_conversation_context('no I need note here', history, [],
                                          workspace='/tmp/current', include_history=True)
        self.assertIn('Create a note about Docmost spaces', result)
        self.assertIn('Created a Docmost page in General', result)
        self.assertIn('Resolve short follow-ups', result)
        self.assertIn('Do not replace the requested work', result)

    def test_manifest_excludes_hidden_settings_and_unrelated_files(self):
        result = add_conversation_context('Hello', [], [{'path': '.bob/secret.csv'}, {'path': 'presentation.html'}, {'path': 'reports/current.tsv', 'size': 20}], workspace='/tmp/new-job')
        self.assertNotIn('secret.csv', result)
        self.assertNotIn('presentation.html', result)
        self.assertIn('reports/current.tsv', result)
        self.assertIn('Unrelated questions', result)

    def test_older_assistant_output_is_compacted_and_newest_turns_are_retained(self):
        history = []
        for i in range(10):
            history.extend([{'type': 'request', 'prompt': f'Question {i}'},
                            {'type': 'delta', 'text': f'Answer {i}: ' + 'x' * 3000 + f' end {i}'}])
        history.append({'type': 'request', 'prompt': 'current'})
        result = add_conversation_context('current', history, [], workspace='/tmp/new-job', include_history=True)
        self.assertNotIn('Question 0', result)
        self.assertNotIn('Question 1', result)
        self.assertIn('Question 2', result)
        self.assertIn('middle omitted', result)
        self.assertIn('Answer 8: ' + 'x' * 3000 + ' end 8', result)
        self.assertIn('Answer 9: ' + 'x' * 3000 + ' end 9', result)
        self.assertLess(len(result), 17000)

    def test_history_stays_bounded_without_clipping_current_request_or_file_manifest(self):
        history = []
        for i in range(20):
            history.extend([{'type': 'request', 'prompt': str(i) + 'x' * 9000},
                            {'type': 'delta', 'text': 'y' * 20000}])
        history.append({'type': 'request', 'prompt': 'current'})
        request = 'Review ' + 'details ' * 500 + 'Do not publish anything.'
        result = add_conversation_context(request, history, [{'path': 'actual.csv'}],
                                          workspace='/tmp/current', include_history=True)
        self.assertTrue(result.startswith(request))
        self.assertIn('actual.csv', result)
        self.assertIn('"user": "19x', result)
        self.assertNotIn('"user": "0x', result)
        start = result.index('\n[{', result.index('[Previous turns from this conversation')) + 1
        turns, end = json.JSONDecoder().raw_decode(result[start:])
        self.assertTrue(turns)
        self.assertLessEqual(len(result[start:start + end]), 16000)


if __name__ == '__main__':
    unittest.main()
