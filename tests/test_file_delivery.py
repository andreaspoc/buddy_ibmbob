from unittest import TestCase
from app.file_delivery import file_headers


class FileDeliveryTests(TestCase):
    def test_active_documents_download_without_same_origin_execution(self):
        for filename, mime in [('deck.html', 'text/html'), ('UPPER.HTML', 'text/html'), ('x.xml', 'application/xml')]:
            headers = file_headers(filename, mime)
            self.assertTrue(headers['Content-Disposition'].startswith('attachment;'))
            self.assertIn('sandbox;', headers['Content-Security-Policy'])
            self.assertNotIn('allow-scripts', headers['Content-Security-Policy'])
            self.assertNotIn('allow-same-origin', headers['Content-Security-Policy'])

    def test_svg_images_remain_inline_but_scripts_and_document_privileges_are_blocked(self):
        headers = file_headers('chart.svg', 'image/svg+xml')
        self.assertNotIn('Content-Disposition', headers)
        self.assertIn("script-src 'none'", headers['Content-Security-Policy'])
        self.assertIn('sandbox;', headers['Content-Security-Policy'])

    def test_passive_images_and_pdf_keep_existing_inline_behavior(self):
        for filename, mime in [('screenshot.png', 'image/png'), ('report.pdf', 'application/pdf')]:
            headers = file_headers(filename, mime)
            self.assertNotIn('Content-Disposition', headers)
            self.assertNotIn('Content-Security-Policy', headers)
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')

    def test_filename_header_is_encoded(self):
        headers = file_headers('folder/Greek α\nname.html', 'text/html')
        self.assertNotIn('\n', headers['Content-Disposition'])
        self.assertIn('%0A', headers['Content-Disposition'])

    def test_actual_file_route_preserves_bytes_and_applies_isolation_policy(self):
        import ast
        import asyncio
        import mimetypes
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        tree = ast.parse(Path('app/main.py').read_text())
        route = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'get_session_file')
        route.decorator_list = []; route.args.defaults = []; route.returns = None
        for arg in route.args.args: arg.annotation = None
        content = b'<script>untrusted source bytes</script>'
        stored = AsyncMock(return_value={'content': content})
        namespace = {'_stored_file': stored, '_file_scope': lambda user, session: 'scope:' + session,
                     'mimetypes': mimetypes, 'file_headers': file_headers,
                     'Response': lambda body, **kwargs: SimpleNamespace(body=body, **kwargs)}
        exec(compile(ast.Module(body=[route], type_ignores=[]), 'app/main.py', 'exec'), namespace)
        response = asyncio.run(namespace['get_session_file']('session-1', 'deck.html', {'username': 'alice'}))
        self.assertEqual(response.body, content)
        self.assertIn('Content-Disposition', response.headers)
        self.assertIn('sandbox;', response.headers['Content-Security-Policy'])
        stored.assert_awaited_once_with('alice', 'scope:session-1', 'deck.html')
