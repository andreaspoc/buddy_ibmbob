"""Synthetic Notes interactions; all account and note APIs are intercepted."""
import asyncio
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect


async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen')")
        notes = [{'id': 1, 'title': 'Fixture Alpha', 'body': '# Overview\n\nExisting fixture text', 'color': 'butter', 'collection': 'Fixture collection', 'tags': [], 'sources': [], 'favorite': False, 'created_at': '2026-01-01T10:00:00Z', 'updated_at': '2026-01-01T10:00:00Z'}]
        async def respond(route):
            request = route.request
            path = urlsplit(request.url).path
            if path in ('/', '/notes', '/notes/') or path.startswith(('/assets/', '/static/')) or path.endswith(('.svg', '.png', '.ico')):
                await route.continue_(); return
            data = []
            if path == '/auth/status': data = {'user': {'username': 'fixture-user', 'is_admin': False}}
            elif path == '/personalization/tutorials': data = {'disabled': True}
            elif path == '/api/notes':
                if request.method == 'POST':
                    data = {**request.post_data_json, 'id': max(item['id'] for item in notes) + 1}
                    notes.append(data)
                else: data = {'items': notes, 'next_before_id': None, 'default_collection': '2026-01-01'}
            elif path.startswith('/api/notes/') and path.endswith(('/versions', '/attachments')): data = {'items': []}
            elif path.startswith('/api/notes/') and request.method == 'PATCH':
                note_id = int(path.rsplit('/', 1)[1]); original = next(item for item in notes if item['id'] == note_id)
                original.update(request.post_data_json); data = original
            elif path == '/api/community/rooms': data = []
            elif path == '/api/community/members': data = [{'username':'fixture-peer','display_name':'Fixture Peer'}]
            elif path.startswith('/integrations/'): data = {'enabled': False}
            elif path.startswith('/auth/microsoft'): data = {'configured': False, 'connected': False}
            elif path.endswith('capabilities'): data = {'web_search': False}
            await route.fulfill(json=data)
        await page.route('**/*', respond)
        await page.goto(os.getenv('NOTES_APP_URL', 'http://127.0.0.1:8080') + '/notes')
        await page.locator('[data-note-id="1"]').wait_for()
        # The original design remains the default; list view is an explicit choice.
        await expect(page.locator('.notes-hero-art')).to_be_visible()
        await expect(page.locator('.notes-list-view')).to_have_count(0)
        await page.get_by_role('button', name='List', exact=True).click()
        await expect(page.locator('.notes-list-view')).to_have_count(1)
        await page.get_by_label('Sort notes', exact=True).select_option('title')
        await page.get_by_role('button', name='Fixture Alpha', exact=True).click()
        editor = page.locator('[data-note-editor]')
        content = editor.get_by_label('Note content', exact=True)
        await content.fill('Fixture text')
        await content.evaluate('element => element.setSelectionRange(0, 7)')
        await editor.get_by_role('button', name='Bold', exact=True).click()
        await expect(content).to_have_value('**Fixture** text')
        await content.fill('/'); await content.press('ArrowDown')
        menu = editor.get_by_role('menu', name='Insert block')
        await menu.get_by_role('menuitem', name='Checklist', exact=True).click()
        await expect(content).to_have_value('- [ ] Text')
        await content.fill('# Fixture outline\n\nParagraph')
        await editor.locator('.notes-outline summary').click()
        await editor.get_by_role('button', name='Fixture outline', exact=True).click()
        await expect(content).to_be_focused()
        assert await content.evaluate('element => element.selectionStart') == 0
        # The app confirmation is a second native modal above the note editor.
        await editor.get_by_role('button', name='Close note editor').click()
        confirmation = page.get_by_role('dialog', name='Confirm action')
        await confirmation.get_by_role('button', name='Cancel', exact=True).click()
        await expect(editor).to_be_visible()
        await content.press('Control+s')
        await expect(editor).not_to_be_visible()
        assert notes[0]['body'] == '# Fixture outline\n\nParagraph'
        await page.get_by_role('button', name='Daily note', exact=True).click()
        await content.wait_for()
        await content.press('Control+s')
        await expect(editor).not_to_be_visible()
        daily_id = notes[-1]['id']; count = len(notes)
        await page.get_by_role('button', name='Daily note', exact=True).click()
        await expect(editor.get_by_label('Title', exact=True)).to_have_value(notes[-1]['title'])
        assert len(notes) == count and notes[-1]['id'] == daily_id
        await editor.get_by_role('button', name='Close note editor').click()
        await page.locator('[data-note-new]').click()
        await editor.get_by_label('Note template', exact=True).select_option('meeting')
        assert '## Agenda' in await content.input_value()
        await editor.get_by_role('button', name='Close note editor').click()
        await confirmation.get_by_role('button', name='Confirm', exact=True).click()
        # Card options have one secondary menu, including an isolated delete action.
        await page.get_by_role('button', name='All notes', exact=True).first.click()
        card = page.locator('[data-note-id="1"]')
        options = card.get_by_role('button', name='Options for Fixture Alpha', exact=True)
        await options.click()
        menu = page.get_by_role('menu', name='Note options')
        await options.click()
        await expect(menu).not_to_be_visible()
        await options.click()
        await expect(menu).to_be_visible()
        await page.keyboard.press('End')
        await expect(menu.get_by_role('menuitem', name='Delete note', exact=True)).to_be_focused()
        await page.keyboard.press('Escape')
        await expect(options).to_be_focused()
        await expect(menu).not_to_be_visible()
        await options.click()
        await menu.get_by_role('menuitem', name='Share to people', exact=True).click()
        share = page.get_by_role('dialog', name='Share to people', exact=True)
        await expect(share).to_be_visible()
        await share.get_by_role('button', name='Cancel', exact=True).click()
        await expect(options).to_be_focused()
        await options.click()
        await menu.get_by_role('menuitem', name='Delete note', exact=True).click()
        await card.get_by_role('button', name='Keep note', exact=True).click()
        assert len(notes) == count
        await card.get_by_role('button', name='Edit note: Fixture Alpha', exact=True).click()
        await editor.get_by_role('tab', name='Write', exact=True).focus()
        await page.keyboard.press('ArrowRight')
        await expect(editor.get_by_role('tab', name='Preview', exact=True)).to_be_focused()
        await page.keyboard.press('ArrowLeft')
        await expect(editor.get_by_role('tab', name='Write', exact=True)).to_be_focused()
        await editor.locator('.notes-properties summary').click()
        await editor.get_by_label('Note tags', exact=True).fill('fixture-property')
        await editor.get_by_role('button', name='Close note editor').click()
        await confirmation.get_by_role('button', name='Cancel', exact=True).click()
        await expect(editor.get_by_label('Note tags', exact=True)).to_have_value('fixture-property')
        await editor.get_by_role('button', name='Close note editor').click()
        await confirmation.get_by_role('button', name='Confirm', exact=True).click()
        for width, height in [(390, 844), (768, 1024), (1440, 1000)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await options.scroll_into_view_if_needed()
            await options.click()
            rect = await menu.bounding_box()
            assert rect and rect['x'] >= 0 and rect['x'] + rect['width'] <= width + 1 and rect['y'] >= 0 and rect['y'] + rect['height'] <= height + 1, (width, rect)
            await page.keyboard.press('Escape')
            assert await page.evaluate('document.documentElement.scrollWidth * (Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1) <= innerWidth + 1')
        assert not errors, errors
        print('PASS: original cards design, optional list, sorting, title navigation, formatting, slash blocks, outline, discard protection, keyboard save, daily-note reuse, templates, options keyboard/focus, nested confirmation/share popups, properties, safe delete cancellation and three viewport sizes')
        await browser.close()


asyncio.run(main())
