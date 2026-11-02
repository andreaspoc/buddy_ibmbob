import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from starlette.requests import Request
from app import research, research_pdf


class SaveResearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_failure_never_renders(self):
        with patch.object(research, 'detail', side_effect=HTTPException(404)), patch.object(research, 'render_pdf', new_callable=AsyncMock) as render:
            with self.assertRaises(HTTPException) as error:
                await research.save_to_office('other', Request({'type': 'http', 'headers': []}), research.ResearchPDFSpec(html='<p>Hi</p>'), {'username': 'alice'})
            self.assertEqual(error.exception.status_code, 404)
            render.assert_not_called()

    async def test_pending_never_renders(self):
        with patch.object(research, 'detail', return_value={'status': 'running', 'report': 'Partial'}), patch.object(research, 'render_pdf', new_callable=AsyncMock) as render:
            with self.assertRaises(HTTPException) as error:
                await research.save_to_office('mine', Request({'type': 'http', 'headers': []}), research.ResearchPDFSpec(html='Report'), {'username': 'alice'})
            self.assertEqual(error.exception.status_code, 409)
            render.assert_not_called()

    async def test_saves_using_owner_and_server_title(self):
        with patch.object(research, 'detail', return_value={'status': 'completed', 'report': 'Report', 'title': '../Report/Title'}), patch.object(research, 'render_pdf', new_callable=AsyncMock, return_value=b'%PDF'), patch('app.plugin_client.save_office_file', new_callable=AsyncMock, return_value={'id': 'file'}) as store:
            result = await research.save_to_office('mine', Request({'type': 'http', 'headers': []}), research.ResearchPDFSpec(html='Rendered report'), {'username': 'alice'})
            self.assertEqual(result, {'id': 'file'})
            store.assert_awaited_once_with(unittest.mock.ANY, 'alice', 'Report Title.pdf', b'%PDF')

    async def test_html_save_skips_pdf_renderer_and_preserves_html(self):
        html = '<!doctype html><html><body><h1>Report</h1></body></html>'
        with patch.object(research, 'detail', return_value={'status': 'completed', 'report': 'Report', 'title': 'Report'}), patch.object(research, 'render_pdf', new_callable=AsyncMock) as render, patch('app.plugin_client.save_office_file', new_callable=AsyncMock, return_value={'id': 'html-file'}) as store:
            result = await research.save_to_office('mine', Request({'type': 'http', 'headers': []}), research.ResearchPDFSpec(html=html, format='html'), {'username': 'alice'})
            self.assertEqual(result['id'], 'html-file')
            render.assert_not_called()
            store.assert_awaited_once_with(unittest.mock.ANY, 'alice', 'Report.html', html.encode('utf-8'))

    async def test_storage_failure_is_propagated(self):
        with patch.object(research, 'detail', return_value={'status': 'completed', 'report': 'Report', 'title': 'Title'}), patch.object(research, 'render_pdf', new_callable=AsyncMock, return_value=b'%PDF'), patch('app.plugin_client.save_office_file', new_callable=AsyncMock, side_effect=HTTPException(503, 'Storage unavailable')):
            with self.assertRaises(HTTPException) as error:
                await research.save_to_office('mine', Request({'type': 'http', 'headers': []}), research.ResearchPDFSpec(html='Report'), {'username': 'alice'})
            self.assertEqual(error.exception.status_code, 503)

    async def test_busy_renderer_is_bounded(self):
        with patch.object(research_pdf, '_render_slots', asyncio.Semaphore(0)), patch.object(research_pdf, '_render', new_callable=AsyncMock) as render:
            with self.assertRaises(HTTPException) as error:
                await research_pdf.render_pdf('Hi')
            self.assertEqual(error.exception.status_code, 503)
            render.assert_not_called()

    async def test_body_limit_header_and_stream(self):
        async def receive():
            return {'type': 'http.request', 'body': b'x' * 11}
        with patch.object(research_pdf, 'MAX_BODY_BYTES', 10):
            for headers in ([], [(b'content-length', b'11')]):
                request = Request({'type': 'http', 'headers': headers}, receive)
                with self.assertRaises(HTTPException) as error:
                    await research_pdf.bounded_payload(request)
                self.assertEqual(error.exception.status_code, 413)

    async def test_renderer_disables_active_content_and_network(self):
        page = AsyncMock()
        page.set_default_timeout = MagicMock()
        page.pdf.return_value = b'%PDF'
        context = AsyncMock()
        context.new_page.return_value = page
        browser = AsyncMock()
        browser.new_context.return_value = context
        runtime = AsyncMock()
        runtime.chromium.launch.return_value = browser
        manager = AsyncMock()
        manager.__aenter__.return_value = runtime
        with patch('playwright.async_api.async_playwright', return_value=manager):
            self.assertEqual(await research_pdf._render('<script>bad()</script><svg></svg>'), b'%PDF')
        browser.new_context.assert_awaited_once_with(java_script_enabled=False, service_workers='block', offline=True)
        self.assertIn("script-src 'none'", page.set_content.call_args.args[0])
        self.assertTrue(page.set_content.call_args.args[0].endswith('<script>bad()</script><svg></svg>'))
        context.route.assert_awaited_once()
        browser.close.assert_awaited_once()

    def test_filename_is_bounded(self):
        filename = research_pdf.pdf_filename('a' * 500 + '/\n')
        self.assertEqual(len(filename), 200)
        self.assertTrue(filename.endswith('.pdf'))


if __name__ == '__main__':
    unittest.main()
