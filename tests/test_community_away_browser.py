"""Synthetic away-assistant UI only; no live member data or AI calls."""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

SELF = 'kc-owner-away-fixture'
PEER = 'kc-peer-away-fixture'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280, 'height':900})
        await page.add_init_script(f"sessionStorage.setItem('buddy-welcome-v1:{SELF}','seen')")
        settings = {'enabled':False,'instructions':'','starts_at':None,'ends_at':None,'active':False,'ready':True,'error':None}
        saves, previews, sends, errors = [], [], [], []
        fail_preview = False
        page.on('pageerror', lambda error: errors.append(str(error)))
        async def route(r):
            path = urlsplit(r.request.url).path
            if path == '/' or path.startswith(('/assets/', '/static/')):
                await r.continue_(); return
            data = []
            if path == '/auth/status': data = {'user':{'username':SELF,'display_name':'Alice Fixture','is_admin':False}}
            elif path == '/personalization/tutorials': data = {'disabled':True}
            elif path == '/api/community/away':
                if r.request.method == 'PUT':
                    payload = json.loads(r.request.post_data)
                    saves.append(payload)
                    settings.update(payload)
                    settings['active'] = payload['enabled']
                data = settings
            elif path == '/api/community/away/preview':
                previews.append(json.loads(r.request.post_data))
                if fail_preview:
                    await r.fulfill(status=503, json={'detail':'Bob is temporarily unavailable. Please try again.'}); return
                data = {'reply': 'Example one: Alice will follow up tomorrow.' if len(previews) == 1 else 'Example two: Thanks for reaching out. Alice will reply tomorrow.'}
            elif path == '/api/community/rooms': data = [{'id':1,'kind':'direct','name':'Bob Jones','subscribed':True,'unread_count':0,'visibility':'private','member_count':2}]
            elif path == '/api/community/members': data = [{'username':PEER,'display_name':'Bob Jones'}]
            elif path.endswith('/members'): data = [{'username':SELF,'display_name':'Alice Fixture'},{'username':PEER,'display_name':'Bob Jones'}]
            elif path.endswith('/messages'):
                if r.request.method == 'POST': sends.append(r.request.post_data)
                data = []
            elif path.endswith('/receipts'): data = []
            elif path.endswith('/read'): data = {'last_read':0}
            elif path.startswith('/auth/microsoft'): data = {'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*', route)
        await page.goto('http://127.0.0.1:8080')
        await page.locator('.member-chat-launcher').click()
        panel = page.locator('#member-chat-panel')
        await panel.locator('.member-chat-room').filter(has_text='Bob Jones').click()
        draft = panel.get_by_role('textbox', name='Message to Bob Jones')
        await draft.fill('Private draft preserved')
        async def open_away():
            await panel.get_by_role('button', name='Bob away assistant', exact=True).click()
            await expect(panel.locator('.member-chat-away')).to_be_visible()
        await open_away()
        away = panel.locator('.member-chat-away')
        await expect(away.get_by_role('checkbox')).not_to_be_checked()
        await expect(away.locator('.member-chat-away-heading > span')).to_have_text('Off')
        await expect(page.locator('.chat-layout-main')).to_be_visible()
        box = await panel.bounding_box()
        assert box['width'] <= 392 and box['height'] <= 601, box
        assert 'kc-' not in await panel.inner_text()
        instructions = 'I am away until tomorrow. Ask urgent requests to contact the service desk. Be concise and warm.'
        await away.get_by_role('textbox', name='What should Bob know?').fill(instructions)
        end_value = (datetime.now() + timedelta(hours=4)).strftime('%Y-%m-%dT%H:%M')
        await away.locator('input[type="datetime-local"]').nth(0).fill('')
        await away.locator('input[type="datetime-local"]').nth(1).fill(end_value)
        await away.get_by_text('Try an example reply', exact=True).click()
        await away.get_by_role('textbox', name='Example incoming message').fill('Can we talk today?')
        generate = away.get_by_role('button', name='Generate example', exact=True)
        await generate.click()
        await expect(away.locator('.member-chat-away-example p')).to_have_text('Example one: Alice will follow up tomorrow.')
        await generate.click()
        await expect(away.locator('.member-chat-away-example p')).to_have_text('Example two: Thanks for reaching out. Alice will reply tomorrow.')
        assert previews == [{'instructions':instructions,'sample_message':'Can we talk today?'}] * 2
        assert not saves and not sends, 'Drafting and previews must never save opt-in or send messages'
        await expect(away.get_by_role('checkbox')).not_to_be_checked()
        await away.get_by_role('checkbox').check()
        assert not saves, 'Checkbox alone must not activate replies'
        await away.get_by_role('button', name='Enable Bob while away', exact=True).click()
        await expect(away.locator('.member-chat-away-heading > span')).to_have_text('Active')
        assert len(saves) == 1 and saves[0]['enabled'] is True and saves[0]['instructions'] == instructions and saves[0]['starts_at'] is None, saves
        assert set(saves[0]) == {'enabled','instructions','starts_at','ends_at'}
        expiry = datetime.fromisoformat(saves[0]['ends_at'].replace('Z','+00:00'))
        assert datetime.now(timezone.utc) < expiry < datetime.now(timezone.utc) + timedelta(hours=5)
        await expect(panel.locator('.member-chat-away-indicator')).to_be_visible()
        await away.get_by_role('checkbox').uncheck()
        await away.get_by_role('button', name='Save — replies off', exact=True).click()
        await expect(away.locator('.member-chat-away-heading > span')).to_have_text('Off')
        assert saves[-1]['enabled'] is False and not sends
        await away.get_by_role('button', name='Back to messages', exact=True).click()
        await expect(draft).to_have_value('Private draft preserved')
        # Saved enabled schedule may always be disabled even if generation is unavailable.
        settings.update(enabled=True,active=True,ready=False)
        await open_away()
        await expect(away.get_by_role('checkbox')).to_be_checked()
        await expect(away.get_by_role('button', name='Enable Bob while away', exact=True)).to_be_disabled()
        await away.get_by_role('checkbox').uncheck()
        await expect(away.get_by_role('checkbox')).to_be_disabled()
        await away.get_by_role('button', name='Save — replies off', exact=True).click()
        await expect(away.locator('.member-chat-away-heading > span')).to_have_text('Off')
        assert saves[-1]['enabled'] is False
        await away.get_by_role('button', name='Back to messages', exact=True).click()
        settings['ready'] = True
        await open_away()
        await away.get_by_text('Try an example reply', exact=True).click()
        await away.get_by_role('textbox', name='Example incoming message').fill('Example error case')
        fail_preview = True
        await away.get_by_role('button', name='Generate example', exact=True).click()
        await expect(away.get_by_role('alert')).to_have_text('Bob is temporarily unavailable. Please try again.')
        assert len(saves) == 3 and not sends
        await expect(away.get_by_role('checkbox')).not_to_be_checked()
        await page.set_viewport_size({'width':390,'height':844})
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await page.screenshot(path='/tmp/member-chat-away-mobile.png', full_page=True)
        assert not errors, errors
        await browser.close()
        print('PASS: synthetic compact away settings, preserved draft, explicit opt-in/off, varied preview rendering, schedule payload, unavailable disable and error privacy')

asyncio.run(main())
