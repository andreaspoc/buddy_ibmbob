"""Malformed samples mirror real model replies captured while drafting from a document."""
import json
import unittest

from buddy_learning.model_json import repair_json_quotes


class RepairJsonQuotesTests(unittest.TestCase):
    def assert_repaired(self, broken, expected):
        with self.assertRaises(ValueError):
            json.loads(broken)
        self.assertEqual(json.loads(repair_json_quotes(broken)), expected)

    def test_valid_json_is_returned_unchanged(self):
        valid = '{"text": "Say \\"hi\\"", "n": 1, "items": ["a", "b"]}'
        self.assertIs(repair_json_quotes(valid), valid)

    def test_quote_followed_by_words(self):
        self.assert_repaired('{"text": "A colleague says: "I reuse passwords" often", "n": 1}',
                             {'text': 'A colleague says: "I reuse passwords" often', 'n': 1})

    def test_quote_followed_by_punctuation(self):
        self.assert_repaired('{"text": "Urgency ("Act now!") matters."}', {'text': 'Urgency ("Act now!") matters.'})

    def test_comma_inside_quoted_prose_does_not_end_the_string(self):
        self.assert_repaired('{"text": "He said "stop", then left", "n": 2}', {'text': 'He said "stop", then left', 'n': 2})

    def test_structure_after_a_string_is_preserved(self):
        self.assert_repaired('{"a": ["x "y" z", "w"], "b": {"c": "d "e" f"}}', {'a': ['x "y" z', 'w'], 'b': {'c': 'd "e" f'}})

    def test_existing_escapes_are_kept(self):
        self.assert_repaired('{"text": "line\\n "q" and \\"r\\" end"}', {'text': 'line\n "q" and "r" end'})

    def test_unrepairable_text_stays_invalid_for_the_caller(self):
        with self.assertRaises(ValueError):
            json.loads(repair_json_quotes('{"text": broken'))

    def test_truncated_reply_stays_invalid(self):
        with self.assertRaises(ValueError):
            json.loads(repair_json_quotes('{"text": "cut off'))


if __name__ == '__main__':
    unittest.main()
