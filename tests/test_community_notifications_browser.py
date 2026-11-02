"""Synthetic fixtures only: notification privacy, recipient routing and emoji drafting."""
import asyncio
import json
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

SELF, BOB = 'kc-self-fixture-234234', 'kc-bob-fixture-234234'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':900})
        errors, fetches, reads, sends = [], [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.add_init_script(f"sessionStorage.setItem('buddy-welcome-v1:{SELF}','seen')")
        rooms = [
            {'id':1,'kind':'direct','name':'Bob Jones','subscribed':True,'unread_count':1,'visibility':'private','member_count':2,'latest_incoming_id':10,'latest_incoming_sender_name':'Bob Jones'},
            {'id':3,'kind':'channel','name':'Design','subscribed':True,'unread_count':0,'visibility':'private','member_count':2,'latest_incoming_id':0,'latest_incoming_sender_name':''},
        ]
        async def route(r):
            path, method = urlsplit(r.request.url).path, r.request.method
            if path == '/' or path.startswith(('/assets/','/static/')):
                await r.continue_(); return
            data = []
            if path == '/auth/status': data = {'user':{'username':SELF,'display_name':'Alice Fixture','is_admin':False}}
            elif path == '/personalization/tutorials': data = {'disabled':True}
            elif path == '/api/community/rooms': data = rooms
            elif path == '/api/community/members' or path.endswith('/members'): data = [{'username':BOB,'display_name':'Bob Jones'}]
            elif path.endswith('/receipts'): data = [{'username':SELF,'display_name':'Alice Fixture','last_read':0},{'username':BOB,'display_name':'Bob Jones','last_read':0}]
            elif path.endswith('/read') and method == 'POST':
                payload = json.loads(r.request.post_data)
                reads.append((path,payload))
                assert set(payload) == {'message_ids'} and payload['message_ids']
                data = {'last_read':max(payload['message_ids'])}
            elif path.endswith('/messages'):
                if method == 'POST':
                    sends.append(r.request.post_data)
                    data = {'id':99}
                else:
                    fetches.append(path)
                    room = rooms[1] if '/3/' in path else rooms[0]
                    data = [{'id':max(1,room['latest_incoming_id']),'sender':BOB,'sender_name':'Bob Jones','body':'PRIVATE BODY MUST NOT APPEAR IN TOAST','created_at':'2026-10-16T10:00:00Z','attachment':None}]
            elif path.startswith('/auth/microsoft'): data = {'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.goto('http://127.0.0.1:8080')
        launcher, panel, toast = page.locator('.member-chat-launcher'), page.locator('#member-chat-panel'), page.locator('.member-chat-toast')
        await expect(launcher).to_be_visible()
        await page.wait_for_timeout(350)
        await expect(toast).to_have_count(0)
        async def update():
            await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
            await page.wait_for_timeout(250)
        rooms[0]['latest_incoming_id'] = 11
        await update()
        await expect(toast).to_be_visible()
        await expect(toast).to_contain_text('Alice')
        await expect(toast).to_contain_text('Bob Jones')
        assert 'PRIVATE BODY' not in await toast.inner_text()
        assert not fetches and not reads, 'Toasts must not fetch or mark messages read'
        await page.screenshot(path='/tmp/member-chat-toast.png',full_page=True)
        await toast.get_by_role('button',name='Dismiss notification').click()
        await expect(toast).to_have_count(0)
        assert not reads
        await update()
        await expect(toast).to_have_count(0)
        rooms[0]['unread_count'] = 0
        await update()
        await expect(toast).to_have_count(0)
        rooms[1].update(latest_incoming_id=30,latest_incoming_sender_name='Bob Jones',unread_count=1)
        await update()
        await expect(toast).to_contain_text('Design')
        await expect(toast).to_contain_text('Bob Jones')
        await toast.get_by_role('button',name='Open chat').click()
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Design')
        await expect(toast).to_have_count(0)
        rooms[1].update(latest_incoming_id=31,unread_count=2)
        await update()
        await expect(toast).to_have_count(0)
        draft = panel.get_by_role('textbox',name='Message to Design')
        await draft.fill('Hello ')
        await panel.get_by_role('button',name='Add emoji',exact=True).click()
        await panel.get_by_role('button',name='Smile',exact=True).click()
        assert 'Hello ' in await draft.input_value() and len(await draft.input_value()) > 6
        assert not sends, 'Emoji selection must only change the draft'
        await draft.press('Enter')
        await expect(draft).to_have_value('')
        assert len(sends) == 1
        rooms[0].update(latest_incoming_id=12,unread_count=1)
        await update()
        await expect(toast).to_contain_text('Bob Jones')
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(200)
        box = await toast.bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await page.screenshot(path='/tmp/member-chat-toast-mobile.png',full_page=True)
        await toast.get_by_role('button',name='Open chat').click()
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Bob Jones')
        assert not errors, errors
        await browser.close()
        print('PASS: private notification popup, no backlog/receipt alerts, dismiss without read, correct room routing, active-room suppression, emoji drafting/Enter and mobile bounds')

asyncio.run(main())
