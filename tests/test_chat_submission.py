"""Tests for retry fingerprints and submission results."""
import unittest

from app.chat_submission import SubmissionResult, fingerprint


class ChatSubmissionTests(unittest.TestCase):
    def test_fingerprint_ignores_retry_identifiers_and_key_order(self):
        original = {'prompt': 'Καλημέρα', 'options': {'b': 2, 'a': 1}}
        retry = {'options': {'a': 1, 'b': 2}, 'prompt': 'Καλημέρα',
                 'correlation_id': 'new', 'user_message_id': 'u',
                 'assistant_message_id': 'a', 'idempotency_key': 'key'}
        self.assertEqual(fingerprint(original), fingerprint(retry))
        self.assertNotEqual(fingerprint(original), fingerprint({**original, 'prompt': 'Hello'}))
        self.assertEqual(len(fingerprint(original)), 64)

    def test_submission_result_preserves_string_identity_and_metadata(self):
        payload = {'status': 'queued'}
        result = SubmissionResult(42, payload, reused=True)
        self.assertEqual(result, '42')
        self.assertIs(result.payload, payload)
        self.assertTrue(result.reused)
        self.assertFalse(SubmissionResult('job', {}).reused)


if __name__ == '__main__':
    unittest.main()
