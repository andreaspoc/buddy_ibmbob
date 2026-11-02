"""Regression coverage for text scanning on long synthetic near misses."""
import json
import subprocess
import sys
import unittest

from app.branding import normalize_identity
from app.redaction import redact
from app.team_runs import review_verdict


class IdentityNormalizationTests(unittest.TestCase):
    def test_identity_phrases_and_surrounding_text(self):
        cases = {
            'Buddy (Powered by IBM Bob)': 'Buddy',
            'Buddy, powered by **IBM Bob**.': 'Buddy.',
            'Buddy\n\tPOWERED BY IBM Bob\nNext': 'Buddy\nNext',
            'Keep other branding and whitespace  ': 'Keep other branding and whitespace  ',
            'A (Powered by IBM Bob) B, powered by IBM Bob C': 'A B C',
            'A, \t powered by\nIBM Bob': 'A',
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(normalize_identity(source), expected)


class CredentialScanningTests(unittest.TestCase):
    def test_preserves_masking_in_nested_assignments_and_shell_flags(self):
        cases = {
            'command=password=hidden': 'command=password=[redacted]',
            '--api-key="hidden"': '--api-key="[redacted]"',
            '{"custom_token_value": "hidden"}': '{"custom_token_value": "[redacted]"}',
            'X-Authorization: hidden': 'X-Authorization: [redacted]',
            'nonsensitive=value': 'nonsensitive=value',
            'prefix api_key=one&password=two': 'prefix api_key=[redacted]&password=[redacted]',
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(redact(source), expected)

    def test_url_credentials_with_colons_and_invalid_near_misses(self):
        for credentials in ('user:pass', 'user:pa:ss', ':user:pass', 'user::'):
            with self.subTest(credentials=credentials):
                self.assertEqual(redact('https://' + credentials + '@host/path'),
                                 'https://[redacted]@host/path')
        for source in ('https://user:@host', 'https://:pass@host',
                       'https://userpass@host', 'https://host/path:user@host'):
            with self.subTest(source=source):
                self.assertEqual(redact(source), source)


class ReviewFenceTests(unittest.TestCase):
    def test_valid_fence_forms_keep_json_and_schema_validation(self):
        verdict = {'complete': True, 'feedback': 'Verified'}
        payload = json.dumps(verdict)
        for header in ('```', '```json', '```JSON\t'):
            self.assertEqual(review_verdict(header + '\n\n' + payload + '\n```'), verdict)
        self.assertEqual(review_verdict(payload), verdict)

    def test_rejects_prose_other_languages_and_incomplete_fences(self):
        payload = '{"complete":true,"feedback":"Verified"}'
        for source in ('prefix ' + payload, '```python\n' + payload + '\n```',
                       '```json\n' + payload, '``` json\n' + payload + '\n```',
                       '```json\n' + payload + '\n```\nsuffix'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                review_verdict(source)


class AdversarialScanningTests(unittest.TestCase):
    def test_long_near_misses_finish_in_bounded_subprocess(self):
        # A subprocess timeout catches accidental quadratic scans without leaving
        # a stuck regex worker in the test runner. These are synthetic strings.
        program = '''
from app.branding import normalize_identity
from app.redaction import redact
from app.team_runs import review_verdict
whitespace = ' ' * 200000
assert normalize_identity('Buddy' + whitespace + '!') == 'Buddy' + whitespace + '!'
assert normalize_identity('Buddy' + whitespace + 'powered by IBM Bob') == 'Buddy'
plain = 'x' * 200000
assert redact(plain) == plain
assert redact(plain + 'token=hidden') == plain + 'token=[redacted]'
url = 'https://' + ':' * 100000 + 'host'
assert redact(url) == url
assert review_verdict('```json\\n' + whitespace + '\\n{"complete":true,"feedback":"ok"}\\n```')['complete']
try:
    review_verdict('```json\\n' + '\\n' * 100000 + 'invalid\\n```')
except ValueError:
    pass
else:
    raise AssertionError('Malformed verdict accepted')
'''
        subprocess.run([sys.executable, '-c', program], check=True, timeout=5)
