import unittest
from app.search_text import searchable_text, MAX_SEARCH_BYTES
from app.unified_search import excerpt, literal_pattern


class SearchTextTests(unittest.TestCase):
    def test_secrets_binary_and_hidden_files_excluded(self):
        for path in ('.env', '.bob/secrets.json', '.git/config', 'node_modules/package/readme.md', 'photo.png'):
            self.assertEqual(searchable_text(path, b'sensitive'), '')
        self.assertEqual(searchable_text('bad.txt', b'abc\x00secret'), '')

    def test_html_scripts_removed_and_text_bounded(self):
        self.assertEqual(searchable_text('report.html', b'<script>privateScript()</script><h1>Revenue</h1>').strip(), 'Revenue')
        self.assertEqual(len(searchable_text('report.md', b'a' * (MAX_SEARCH_BYTES + 100))), MAX_SEARCH_BYTES)

    def test_unicode_excerpt_and_literal_wildcards(self):
        self.assertIn('κόσμος', excerpt('x ' * 300 + 'κόσμος', 'κόσμος'))
        self.assertEqual(literal_pattern('10%_done\\'), '%10\\%\\_done\\\\%')


if __name__ == '__main__':
    unittest.main()
