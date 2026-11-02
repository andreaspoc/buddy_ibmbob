"""Valid protocol and long-input regressions for deterministic text scanners."""
import ast
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

from app.clarification import follow_up_suggestions
from app.quiz import quizzes_in_history
from app.quiz_review import _private_reading_topic, _reading_candidates, _review_block


def helpers(path, names):
    tree = ast.parse(Path(path).read_text())
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    namespace = {'re': re}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, 'exec'), namespace)
    return namespace


class TextParserBoundaryTests(unittest.TestCase):
    def test_followups_preserve_generic_inline_and_outer_examples(self):
        payload = json.dumps({'options': ['First action', 'Second action']})
        self.assertEqual(follow_up_suggestions('```json\n' + payload + '\n```'), ['First action', 'Second action'])
        self.assertEqual(follow_up_suggestions('```' + payload + '```'), ['First action', 'Second action'])
        self.assertEqual(follow_up_suggestions('````markdown\n```json\n' + payload + '\n```\n````'), [])

    def test_quiz_fences_accept_valid_lengths_and_reject_wrong_closers(self):
        payload = {'title': 'Synthetic quiz', 'questions': [{'id': 'q1', 'type': 'single', 'question': 'Fixture?',
            'options': ['One', 'Two'], 'answer': [0], 'explanation': 'Fixture answer'}]}
        for fence in ('```', '~~~~', '`' * 10000):
            text = '  ' + fence + 'bobquiz\n' + json.dumps(payload) + '\n  ' + fence
            result = list(quizzes_in_history([{'type': 'delta', 'text': text}]))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0][1], payload)
        self.assertEqual(list(quizzes_in_history([{'type': 'delta', 'text': '```bobquiz\n' + json.dumps(payload) + '\n~~~'}])), [])

    def test_review_block_tracks_followups_and_exact_closer(self):
        text = 'Prose\n```BOBQUIZRESULT\n{"questions":[]}\n```\nFollowups'
        body, end = _review_block(text)
        self.assertEqual(json.loads(body), {'questions': []})
        self.assertEqual(text[end:], '\nFollowups')
        self.assertIsNone(_review_block('```bobquizresult\n{}\n~~~~'))

    def test_search_links_and_private_topic_detection(self):
        self.assertEqual(list(_reading_candidates('1. **[Synthetic source](https://example.org/a)**\nDescription')),
                         [('Synthetic source', 'https://example.org/a')])
        self.assertEqual(list(_reading_candidates('**[not a source](javascript:alert(1))**')), [])
        for text in ('**[title](https://example.org/a](https://example.org/b)**',
                     '**[title)**text](https://example.org/a)**',
                     '**[title](invalid) text](https://example.org/a)**'):
            expected = re.findall(r'\*\*\[([^\n]+?)\]\((https?://[^\s)]+)\)\*\*', text)
            self.assertEqual(list(_reading_candidates(text)), expected)
        for topic in ('person@example.org', 'use 123456 for this', 'https://example.org', 'document.pdf'):
            self.assertTrue(_private_reading_topic(topic), topic)
        for topic in ('authentication concepts', '@mention', 'suffix@'):
            self.assertFalse(_private_reading_topic(topic), topic)

    def test_html_extraction_hides_nested_chrome_and_keeps_visible_text(self):
        strip_html = helpers('app/mcp_search.py', {'_strip_html'})['_strip_html']
        source = '<h1>Title</h1><script>ignore()</script><div class="cookie-banner"><div>Hidden</div>Still hidden</div><p>Hello <b>world</b> &amp; more.</p><ul><li>Item</li></ul>'
        self.assertEqual(strip_html(source), 'Title\nHello world & more.\n- Item')
        self.assertNotIn('hidden', strip_html('<nav><div>hidden</div></nav><p>Visible</p>'))
        self.assertEqual(strip_html('One<!-- comment -->two'), 'One two')
        self.assertNotIn('secret', strip_html('<script>secret'))

    def test_presentation_counts_and_explicit_reminder_commands(self):
        from tests.test_presentation_routing import intent
        for prompt in ('create 12 slides', 'create 12 - slides', 'create slides: 12', 'create number of slides = 12'):
            self.assertEqual(intent(prompt)['slide_count'], 12)
        reminder = helpers('app/toolbar_reminders.py', {'explicit_reminder_title'})['explicit_reminder_title']
        for prompt, title in [('remind me to call Maria', 'Call Maria'), ('Bob, please make a reminder to call Maria', 'Call Maria'),
                              ('create a reminder: Review report', 'Review report'), ('create reminder   Review report', 'Review report')]:
            self.assertEqual(reminder({'prompt': prompt}), title)
        for prompt in ('remind me about this', 'create reminder\nCall Maria', 'create reminder\nCall Maria\nOther'):
            self.assertIsNone(reminder({'prompt': prompt}))

    def test_long_near_misses_finish_within_subprocess_budget(self):
        program = '''
from tests.test_text_parser_boundaries import helpers
from app.clarification import follow_up_suggestions
from app.quiz import quizzes_in_history
from app.quiz_review import _reading_candidates, _private_reading_topic, _review_block
assert follow_up_suggestions('```json\\n' + ' ' * 200000) == []
assert list(quizzes_in_history([{'type':'delta','text':'`' * 200000 + '!'}])) == []
assert list(_reading_candidates('**[' + 'x' * 200000)) == []
assert not _private_reading_topic('x' * 200000)
assert _review_block('```bobquizresult\\n' + ' ' * 200000) is None
strip_html = helpers('app/mcp_search.py', {'_strip_html'})['_strip_html']
assert 'visible' in strip_html('<div ' + 'cookie' * 40000 + '>hidden</div><p>visible</p>')
from tests.test_presentation_routing import intent
assert intent('create 12 ' + ' ' * 200000 + 'reports')['slide_count'] is None
reminder = helpers('app/toolbar_reminders.py', {'explicit_reminder_title'})['explicit_reminder_title']
assert reminder({'prompt':'create reminder' + ' ' * 200000 + '\\nOther'}) is None
'''
        subprocess.run([sys.executable, '-c', program], check=True, timeout=5)
