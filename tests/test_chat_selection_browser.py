"""Real UI selection/composer checks; all conversation and network data are fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

SESSION = 'a' * 32
OTHER = 'b' * 32
PASSAGE = 'Selected fixture passage with <literal> text.'
LABELS = {
    'en': ('Ask about this', 'Selected text', 'Remove selected text', 'Selected text:'),
    'el': ('Ρώτησε γι’ αυτό', 'Επιλεγμένο κείμενο', 'Αφαίρεση επιλεγμένου κειμένου', 'Επιλεγμένο κείμενο:'),
    'hi': ('इसके बारे में पूछें', 'चुना हुआ पाठ', 'चुना हुआ पाठ हटाएँ', 'चुना हुआ पाठ:'),
}

async def select(page, selector, start=0, end=None):
    await page.locator(selector).first.evaluate('''(element, offsets) => {
        element.scrollIntoView({block: 'nearest'});
        const node = element.firstChild;
        const range = document.createRange();
        range.setStart(node, offsets[0]); range.setEnd(node, offsets[1] ?? node.textContent.length);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
    }''', [start, end])

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        for language, (ask, preview, remove, context) in LABELS.items():
            page = await browser.new_page(viewport={'width': 1280, 'height': 900}, has_touch=language == 'hi')
            errors, sent = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.add_init_script(f"localStorage.setItem('bob-ui-language', '{language}'); sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
            async def route_request(route):
                request = route.request
                path = urlsplit(request.url).path
                if path == '/' or path.startswith('/assets/') or path.endswith(('.png', '.svg', '.ico')):
                    await route.continue_(); return
                data = []
                if path == '/auth/status':
                    data = {'user': {'username': 'fixture-user', 'display_name': 'Fixture User', 'is_admin': False}}
                elif path == '/personalization/tutorials':
                    data = {'disabled': True}
                elif path == '/sessions':
                    data = [{'id': SESSION, 'title': 'Fixture conversation', 'updated_at': 1}, {'id': OTHER, 'title': 'Other conversation', 'updated_at': 1}]
                elif path.endswith('/history'):
                    data = [{'type': 'request', 'prompt': 'Original fixture request', 'mode': 'agent'}, {'type': 'delta', 'text': PASSAGE.replace('<', '&lt;').replace('>', '&gt;') + '\n\n```text\n    line one\n    line two\n```'}, {'type': 'done', 'tokens': 10}]
                elif path in ('/workflows/capabilities', '/research/capabilities'):
                    data = {'web_search': False}
                elif path.startswith('/auth/microsoft'):
                    data = {'configured': False, 'connected': False}
                elif path == '/chat/stream':
                    sent.append(request.post_data_json)
                    await route.fulfill(content_type='text/event-stream', body='data: {"type":"done","tokens":1}\n\n'); return
                await route.fulfill(content_type='application/json', body=json.dumps(data))
            await page.route('**/*', route_request)
            await page.goto(os.getenv('LANGUAGE_PREVIEW_URL', 'http://127.0.0.1:8080'))
            await page.get_by_role('button', name='Fixture conversation', exact=True).click()
            await page.locator('.message.assistant .markdown-body p').wait_for()
            composer = page.locator('#prompt-input')
            await composer.fill('My existing draft')
            if language == 'en':
                paragraph = page.locator('.message.assistant .markdown-body p').first
                await paragraph.scroll_into_view_if_needed()
                rect = await paragraph.evaluate('''element => {
                    const range = document.createRange(); range.selectNodeContents(element);
                    const box = range.getBoundingClientRect();
                    return {left: box.left, right: box.right, y: box.top + box.height / 2};
                }''')
                await page.mouse.move(rect['left'] + .25, rect['y'])
                await page.mouse.down()
                await page.mouse.move(rect['right'] + 1, rect['y'], steps=8)
                await page.mouse.up()
            else:
                await select(page, '.message.assistant .markdown-body p')
            action = page.get_by_role('button', name=ask, exact=True)
            await action.wait_for()
            box = await action.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= 1280
            assert box['y'] >= 0 and box['y'] + box['height'] <= 900
            if language == 'hi':
                await action.tap()
            else:
                await action.click()
            assert await composer.input_value() == 'My existing draft'
            assert await page.locator('.composer-quote blockquote').inner_text() == PASSAGE
            assert await composer.evaluate('element => element === document.activeElement')
            assert not sent, 'Selecting a passage must not send a question'
            assert await page.locator('.composer-quote-content > span').inner_text() == preview
            await select(page, '.message.assistant .markdown-body p')
            await action.click()
            assert await page.locator('.composer-quote').count() == 1, 'Repeated selections must not duplicate quotes'
            await select(page, '.message.assistant .markdown-body pre code')
            selected_code = await page.evaluate('window.getSelection().toString()')
            await action.click()
            assert await page.locator('.composer-quote').count() == 2
            quoted_code = await page.locator('.composer-quote blockquote').nth(1).text_content()
            assert quoted_code == selected_code, repr((quoted_code, selected_code))
            assert quoted_code.startswith('    line one\n    line two'), repr(quoted_code)
            await page.get_by_role('button', name=remove, exact=True).nth(1).click()
            assert await composer.input_value() == 'My existing draft'
            await composer.fill('What does this mean?')
            async with page.expect_response(lambda response: urlsplit(response.url).path == '/chat/stream'):
                await page.locator('.composer .send-button').click()
            await page.wait_for_function("document.querySelectorAll('.composer-quote').length === 0")
            assert len(sent) == 1 and sent[0]['prompt'] == f'What does this mean?\n\n{context}\n> {PASSAGE}', sent
            assert sent[0]['ui_language'] == language
            if language == 'en':
                long_text = 'Long fixture passage. ' * 500
                await page.locator('.message.assistant .markdown-body p').first.evaluate('(element, text) => element.textContent = text', long_text)
                await select(page, '.message.assistant .markdown-body p')
                await action.click()
                assert await page.locator('.composer-quote blockquote').text_content() == long_text.rstrip()
                assert await page.locator('.composer-quotes').evaluate('element => element.clientHeight') <= 168
                assert await page.locator('.composer .send-button').is_disabled(), 'A quote alone must not send a question'
                await page.get_by_role('button', name=remove, exact=True).click()
            await select(page, '.sidebar-group-label')
            await page.wait_for_timeout(150)
            assert await action.count() == 0, 'Selections outside messages must not open the action'
            await select(page, '.message.user .bubble p')
            await action.wait_for()
            await page.keyboard.press('Escape')
            assert await action.count() == 0
            await select(page, '.message.user .bubble p')
            await action.wait_for()
            await action.focus()
            await page.keyboard.press('Enter')
            assert await page.locator('.composer-quote').count() == 1
            await page.get_by_role('button', name='Other conversation', exact=True).click()
            assert await page.locator('.composer-quote').count() == 0, 'Quotes must not leak to another conversation'
            assert not errors, errors
            print(json.dumps({'language': language, 'draftPreserved': True, 'literalQuoteSent': True, 'multiQuoteAndRemoval': True, 'scopeAndSessionIsolation': True}), flush=True)
            await page.close()
        await browser.close()

asyncio.run(main())
