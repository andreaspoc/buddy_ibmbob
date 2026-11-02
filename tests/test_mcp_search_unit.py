"""Search and page extraction behavior with a mocked HTTP client."""
import io
import json
import unittest
from unittest.mock import MagicMock, patch
from app import mcp_search


class MCPSearchTests(unittest.TestCase):
    def setUp(self):
        mcp_search._SEARCH_CACHE.clear()
        mcp_search._PAGE_CACHE.clear()
        self.addCleanup(mcp_search._SEARCH_CACHE.clear)
        self.addCleanup(mcp_search._PAGE_CACHE.clear)

    def test_missing_key_empty_query_and_rate_limit(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertIn('BRAVE_API_KEY is not set', mcp_search.brave_web_search('anything'))
        client = MagicMock()
        client.get.return_value.status_code = 429
        with patch.dict('os.environ', {'BRAVE_API_KEY': 'test'}), patch.object(mcp_search, '_get_client', return_value=client):
            self.assertIn('Empty search query', mcp_search.brave_web_search('  '))
            self.assertIn('rate limit', mcp_search.brave_web_search('query'))

    def test_freshness_fallback_and_cache(self):
        empty = MagicMock(status_code=200)
        empty.json.return_value = {'web': {'results': []}}
        result = MagicMock(status_code=200)
        result.json.return_value = {'web': {'results': [{'title': 'Source', 'url': 'https://example.org', 'description': 'Useful evidence'}]}}
        client = MagicMock()
        client.get.side_effect = [empty, result]
        with patch.dict('os.environ', {'BRAVE_API_KEY': 'test'}), patch.object(mcp_search, '_get_client', return_value=client):
            first = mcp_search.brave_web_search('topic', count=2, freshness='pw')
            second = mcp_search.brave_web_search('topic', count=2, freshness='pw')
        self.assertIn('Useful evidence', first)
        self.assertEqual(first, second)
        self.assertEqual(client.get.call_count, 2)
        self.assertIn('freshness', client.get.call_args_list[0].kwargs['params'])
        self.assertNotIn('freshness', client.get.call_args_list[1].kwargs['params'])

    def test_fetch_rejects_invalid_scheme_and_truncates_cached_json(self):
        self.assertIn('Invalid URL scheme', mcp_search.fetch_web_page('file:///etc/passwd'))
        response = MagicMock()
        response.headers = {'content-type': 'application/json'}
        response.content = b'x' * 1000
        response.text = 'x' * 1000
        client = MagicMock()
        client.get.return_value = response
        with patch.object(mcp_search, '_get_client', return_value=client):
            result = mcp_search.fetch_web_page('https://example.org/data', max_chars=500)
            self.assertEqual(result, mcp_search.fetch_web_page('https://example.org/data', max_chars=500))
        self.assertIn('Content truncated at 500 characters', result)
        client.get.assert_called_once()

    def test_html_extraction_omits_active_content_and_consent_banners(self):
        page = '''<!doctype html><html><head><style>private style</style></head><body>
        <nav>navigation</nav><h1>Title &amp; summary</h1>
        <div class="cookie-banner"><p>accept cookies</p><span>nested banner</span></div>
        <article><p>Visible text<br>second line</p><ul><li>First</li><li>Second</li></ul></article>
        <script>steal credentials</script><footer>footer content</footer></body></html>'''
        text = mcp_search._strip_html(page)
        for expected in ('Title & summary', 'Visible text', 'second line', 'First', 'Second'):
            self.assertIn(expected, text)
        for excluded in ('navigation', 'accept cookies', 'nested banner', 'steal credentials', 'footer content', 'private style'):
            self.assertNotIn(excluded, text)

    def test_fetch_http_failure_and_empty_response_are_reported(self):
        response = MagicMock()
        response.raise_for_status.side_effect = RuntimeError('fixture network failure')
        client = MagicMock()
        client.get.return_value = response
        with patch.object(mcp_search, '_get_client', return_value=client):
            self.assertIn('Error fetching webpage', mcp_search.fetch_web_page('https://example.org/fail'))
            response.raise_for_status.side_effect = None
            response.headers = {'content-type': 'text/html'}
            response.content = b'<script>hidden</script>'
            response.text = response.content.decode()
            self.assertIn('empty or non-extractable', mcp_search.fetch_web_page('https://example.org/empty'))

    def test_stdio_server_handles_protocol_and_tool_errors(self):
        requests = [
            {'id': 1, 'method': 'initialize'}, {'method': 'notifications/initialized'},
            {'id': 2, 'method': 'tools/list'}, {'id': 3, 'method': 'ping'},
            {'id': 4, 'method': 'tools/call', 'params': {'name': 'missing'}},
            {'id': 5, 'method': 'tools/call', 'params': {'name': 'brave_web_search', 'arguments': {'query': 'q'}}},
            {'id': 6, 'method': 'tools/call', 'params': {'name': 'fetch_web_page', 'arguments': {'url': 'https://example.org'}}},
            {'id': 7, 'method': 'unknown'}, {'method': 'unknown'},
        ]
        source = io.StringIO('invalid json\n\n' + '\n'.join(json.dumps(item) for item in requests))
        output = io.StringIO()
        with patch.object(mcp_search.sys, 'stdin', source), patch.object(mcp_search.sys, 'stdout', output), \
             patch.object(mcp_search, 'brave_web_search', return_value='result'), \
             patch.object(mcp_search, 'fetch_web_page', side_effect=ValueError('fixture')):
            mcp_search.run_mcp_stdio_server()
        replies = {item['id']: item for item in map(json.loads, output.getvalue().splitlines())}
        self.assertEqual(set(replies), {1, 2, 3, 4, 5, 6, 7})
        self.assertIn('tools', replies[2]['result'])
        self.assertEqual(replies[4]['error']['code'], -32601)
        self.assertEqual(replies[5]['result']['content'][0]['text'], 'result')
        self.assertTrue(replies[6]['result']['isError'])
        self.assertEqual(replies[7]['error']['code'], -32601)

    def test_cli_dispatches_search_and_fetch(self):
        with patch.object(mcp_search.sys, 'argv', ['mcp_search', '--search', 'topic', '--count', '2']), \
             patch.object(mcp_search, 'brave_web_search', return_value='found') as search, patch.object(mcp_search.sys, 'stdout', new_callable=io.StringIO) as out:
            mcp_search.main()
        search.assert_called_once_with('topic', count=2, freshness=None)
        self.assertEqual(out.getvalue(), 'found\n')
        with patch.object(mcp_search.sys, 'argv', ['mcp_search', '--fetch', 'https://example.org']), \
             patch.object(mcp_search, 'fetch_web_page', return_value='page') as fetch, patch.object(mcp_search.sys, 'stdout', new_callable=io.StringIO):
            mcp_search.main()
        fetch.assert_called_once_with('https://example.org')


if __name__ == '__main__':
    unittest.main()
