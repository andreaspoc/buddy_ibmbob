"""Keep Mermaid previews and editor state through answer updates (Vite port 3001)."""
import asyncio
import json
import os

from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'),
            args=['--no-sandbox'],
        )
        page = await browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.route('**/workflows/capabilities', lambda route: route.fulfill(json={'web_search': False}))
        await page.goto(os.getenv('STREAM_PREVIEW_URL', 'http://host.docker.internal:3001/tests/streaming.html'))
        await page.wait_for_function("typeof window.renderAnswer === 'function'")
        await page.evaluate('''() => {
            window.diagramAnswer = 'Before.\\n\\n```mermaid\\nflowchart LR\\nA["Start"] --> B["Finish"]\\n```';
            window.renderAnswer(window.diagramAnswer, false);
            window.originalPanel = document.querySelector('.mermaid-panel');
            // Update before the asynchronous Mermaid render finishes.
            window.renderAnswer(window.diagramAnswer + '\\n\\nAfter.', false);
            if (document.querySelector('.mermaid-panel') !== window.originalPanel)
                throw Error('Pending diagram replaced');
        }''')
        await page.locator('.mermaid-panel svg').wait_for()
        await page.get_by_role('button', name='Edit code', exact=True).click()
        await page.get_by_role('textbox', name='Mermaid code').fill('flowchart LR\nA["Draft"] --> B["Finish"]')
        result = await page.evaluate('''() => {
            const svg = document.querySelector('.mermaid-panel svg');
            window.renderAnswer(window.diagramAnswer + '\\n\\nMore follow-up text.', false);
            if (document.querySelector('.mermaid-panel') !== window.originalPanel ||
                document.querySelector('.mermaid-panel svg') !== svg)
                throw Error('Rendered diagram replaced');
            const editor = document.querySelector('.mermaid-editor');
            if (editor.hidden || !editor.querySelector('textarea').value.includes('Draft'))
                throw Error('Editor state lost');
            return {pendingRenderPreserved: true, svgPreserved: true, editorDraftPreserved: true};
        }''')
        await page.get_by_role('button', name='Maximize', exact=True).click()
        await page.keyboard.press('Escape')
        # Headless native fullscreen may not be entered; either mechanism must restore.
        await page.evaluate('''async () => {
            if (document.fullscreenElement) await document.exitFullscreen();
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        }''')
        await page.wait_for_function("!document.querySelector('.mermaid-panel').classList.contains('maximized')")
        await page.evaluate('''() => {
            window.renderAnswer(window.diagramAnswer.replace('Start', 'Changed'), false);
            if (document.querySelector('.mermaid-panel') === window.originalPanel)
                throw Error('Changed diagram reused stale source');
        }''')
        await page.locator('.mermaid-panel svg').wait_for()
        if errors:
            raise AssertionError(errors)
        print(json.dumps({**result, 'fullscreenListenersPreserved': True, 'changedSourceReplaced': True}))
        await browser.close()


asyncio.run(main())
