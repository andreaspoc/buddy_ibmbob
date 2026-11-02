"""Actual Chromium checks of the document viewer with clearly synthetic HTTP fixtures."""
import asyncio
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        pending_reads = 0
        retried = False
        async def handle(route):
            nonlocal pending_reads, retried
            url = route.request.url
            if '/documents/prepare?' in url:
                retried = True
                await route.fulfill(json={'status': 'queued'})
                return
            path = url.split('path=')[-1]
            status = 'ready'
            if 'pending' in path:
                pending_reads += 1
                status = 'queued' if pending_reads == 1 else 'ready'
            if 'broken' in path and not retried:
                status = 'failed'
            await route.fulfill(json={'status': status, 'text': '# Synthetic fixture\n\nReview milestone: Thursday.\n\n' + ('unbroken' * 150), 'error': 'Synthetic unreadable document fixture' if status == 'failed' else None})
        await page.route('**/sessions/fixture-session/documents/**', handle)
        await page.goto(os.getenv('DOCUMENT_FIXTURE_URL', 'http://127.0.0.1:3002/conversation_document_fixture.html'))
        await page.get_by_text('Review milestone: Thursday.').wait_for()
        for width in (1280, 390, 320):
            await page.set_viewport_size({'width': width, 'height': 900})
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}'
        await page.get_by_label('Ask Bob about this document').fill('What is the milestone?')
        await page.get_by_role('button', name='Ask Bob', exact=True).click()
        assert '[Attached document: "synthetic-notes.md"]\nWhat is the milestone?' == await page.locator('output').text_content()
        await page.get_by_role('button',name='Create test from document',exact=True).click()
        test_prompt = await page.locator('output').text_content()
        assert test_prompt.startswith('[Attached document: "synthetic-notes.md"]\n')
        assert 'Use a bobquiz form' in test_prompt and 'only after I submit the complete test' in test_prompt
        await page.get_by_role('button', name='Pending fixture').click()
        await page.get_by_text('Preparing document for reading…',exact=False).wait_for()
        assert await page.get_by_role('button', name='Ask Bob', exact=True).is_disabled()
        await page.get_by_text('Review milestone: Thursday.').wait_for()
        assert pending_reads >= 2
        await page.get_by_role('button', name='Failed fixture').click()
        await page.get_by_role('alert').wait_for()
        await page.get_by_role('button', name='Retry preparation').click()
        await page.get_by_text('Review milestone: Thursday.').wait_for()
        assert retried
        await page.get_by_role('button', name='Summarize document').click()
        assert 'Summarize this document' in await page.locator('output').text_content()
        await page.get_by_role('button', name='PDF fixture').click()
        iframe=page.locator('iframe[title="PDF preview: synthetic.pdf"]')
        await iframe.wait_for()
        assert await iframe.get_attribute('src')=='/sessions/fixture-session/file?path=synthetic.pdf'
        assert await iframe.get_attribute('sandbox')=='allow-same-origin'
        await page.get_by_text('Read extracted text',exact=True).click()
        await page.get_by_text('Review milestone: Thursday.').wait_for()
        await page.get_by_role('button', name='Close document preview').click()
        assert await page.get_by_role('region', name='Document preview').count() == 0
        assert not errors, errors
        print('Document browser passed: desktop/mobile layout, Markdown rendering, contextual question, queued polling, failure retry, summary, close, no JavaScript errors.')
        await browser.close()

asyncio.run(main())
