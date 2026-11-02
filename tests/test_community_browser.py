"""Synthetic UI fixtures: no member data is read, sent, or deleted."""
import asyncio
import json
import re
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

SELF = 'kc-self-fixture-234234'
BOB = 'kc-bob-fixture-234234'
CAROL = 'kc-carol-fixture-234234'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width':1280,'height':900})
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.add_init_script(f"sessionStorage.setItem('buddy-welcome-v1:{SELF}','seen')")
        members = [{'username':BOB,'display_name':'Bob Jones'}, {'username':CAROL,'display_name':'Carol Smith'}]
        rooms = [{'id':1,'kind':'direct','name':'Bob Jones','subscribed':True,'unread_count':1,'visibility':'private','member_count':2}]
        messages = [
            {'id':10,'sender':BOB,'sender_name':'Bob Jones','body':'Fixture greeting','created_at':'2026-10-16T10:00:00Z','attachment':None},
            {'id':11,'sender':SELF,'sender_name':SELF,'body':'My removable message','created_at':'2026-10-16T10:01:00Z','attachment':None},
        ]
        sent, created, deleted, reads, acknowledgements = [], [], [], [], []
        def acknowledged_ids():
            return {message_id for path, payload in acknowledgements if path == '/api/community/rooms/1/read' for message_id in payload['message_ids']}
        peer_cursor = 0
        fail_next_send = False
        async def route(r):
            nonlocal fail_next_send
            path = urlsplit(r.request.url).path
            method = r.request.method
            if path == '/' or path.startswith(('/assets/','/static/')):
                await r.continue_(); return
            data = []
            if path == '/auth/status': data = {'user':{'username':SELF,'display_name':'Alice Fixture','is_admin':False}}
            elif path == '/api/apps': data = {'apps':[{'id':'people','name':'Member chat','description':'Synthetic app fixture','kind':'installed','desktop_only':False,'launch':{'kind':'people'}}]}
            elif path == '/personalization/tutorials': data = {'disabled':True}
            elif path == '/api/community/rooms':
                if method == 'POST':
                    payload = json.loads(r.request.post_data)
                    created.append(payload)
                    if payload['kind'] == 'direct': data = {'id':1}
                    else:
                        rooms.append({'id':3,'kind':'channel','name':payload['name'],'subscribed':True,'unread_count':0,'visibility':payload['visibility'],'member_count':3})
                        data = {'id':3}
                else: data = rooms
            elif path == '/api/community/members': data = members
            elif path.endswith('/members') and path.startswith('/api/community/rooms/'):
                data = [{'username':SELF,'display_name':'Alice Fixture'}, *members]
            elif path.endswith('/receipts') and path.startswith('/api/community/rooms/'):
                data = [{'username':SELF,'display_name':'Alice Fixture','last_read':11}, {'username':BOB,'display_name':'Bob Jones','last_read':peer_cursor}]
                if '/3/' in path: data.append({'username':CAROL,'display_name':'Carol Smith','last_read':peer_cursor})
            elif path.endswith('/read') and method == 'POST':
                payload = json.loads(r.request.post_data)
                acknowledgements.append((path,payload))
                rooms[0]['unread_count'] = 0
                assert set(payload) == {'message_ids'} and payload['message_ids']
                data = {'last_read':max(payload['message_ids'])}
            elif path.endswith('/messages') and path.startswith('/api/community/rooms/'):
                if method == 'POST':
                    if fail_next_send:
                        fail_next_send = False
                        await r.fulfill(status=503,json={'detail':'Fixture send unavailable'})
                        return
                    sent.append(r.request.post_data)
                    data = {'id':20}
                else:
                    reads.append(path)
                    data = messages if '/1/' in path else [{'id':30,'sender':SELF,'sender_name':'Alice Fixture','body':'Group fixture','created_at':'2026-10-16T10:04:00Z','attachment':None}]
            elif path == '/api/community/rooms/1/messages/11' and method == 'DELETE':
                deleted.append(path)
                messages[:] = [message for message in messages if message['id'] != 11]
                await r.fulfill(status=204); return
            elif path.startswith('/auth/microsoft'): data = {'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.goto('http://127.0.0.1:8080')
        panel = page.locator('#member-chat-panel')
        launcher = page.locator('.member-chat-launcher')
        await expect(launcher).to_be_visible()
        await expect(panel).to_be_hidden()
        await expect(page.locator('.chat-layout-main')).to_be_visible()
        await expect(page.locator('.conversation-new .welcome-buddy-hero')).to_be_visible()
        await page.screenshot(path='/tmp/buddy-new-chat.png',full_page=True,animations='disabled')
        await page.set_viewport_size({'width':390,'height':844})
        await page.screenshot(path='/tmp/buddy-new-chat-mobile.png',full_page=True,animations='disabled')
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        await page.set_viewport_size({'width':1280,'height':900})
        await launcher.click()
        await expect(panel).to_be_visible()
        box = await panel.bounding_box()
        scale = await page.evaluate("Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1")
        assert abs(box['width'] - 390 * scale) < 2 and box['height'] <= 601 * scale, box
        await page.wait_for_timeout(250)
        await page.screenshot(path='/tmp/member-chat-widget-list.png',full_page=True,animations='disabled')
        await panel.get_by_role('button',name='New message',exact=True).click()
        await panel.get_by_role('textbox',name='Search members').fill('Bob')
        await expect(panel.get_by_role('button',name='Bob Jones Start private conversation')).to_be_visible()
        await expect(panel.get_by_role('button',name='Carol Smith Start private conversation')).to_have_count(0)
        await panel.get_by_role('button',name='Bob Jones Start private conversation').click()
        assert created == [{'kind':'direct','peer':BOB}], created
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Bob Jones')
        await expect(panel.get_by_text('Fixture greeting',exact=True)).to_be_visible()
        await expect(panel.locator('.member-chat-message.is-own strong')).to_have_text('You')
        await expect(panel.locator('.member-chat-message:not(.is-own) strong').first).to_have_text('Bob Jones')
        assert 'kc-' not in await panel.inner_text()
        await expect(launcher.locator('.member-chat-unread')).to_have_count(0)
        draft = panel.get_by_role('textbox',name='Message to Bob Jones')
        await expect(panel.locator('.member-chat-receipt')).to_have_text(re.compile(r'Sent$'))
        await page.wait_for_timeout(300)
        assert {10, 11} <= acknowledged_ids(), acknowledgements
        peer_cursor = 11
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await expect(panel.locator('.member-chat-receipt')).to_have_text(re.compile(r'Seen$'))
        await draft.fill('Retry this draft')
        fail_next_send = True
        await draft.press('Enter')
        await expect(panel.get_by_role('button',name='Send',exact=True)).to_be_enabled()
        await expect(draft).to_have_value('Retry this draft')
        assert not sent, 'Failed send must preserve draft'
        await draft.fill('Enter sends privately')
        await draft.press('Enter')
        await expect(draft).to_have_value('')
        assert len(sent) == 1 and 'Enter sends privately' in sent[0]
        await draft.fill('Draft stays private')
        await draft.press('Shift+Enter')
        await expect(draft).to_have_value('Draft stays private\n')
        await draft.dispatch_event('keydown', {'key':'Enter','code':'Enter','bubbles':True,'isComposing':True})
        await draft.dispatch_event('keydown', {'key':'Enter','code':'Enter','bubbles':True,'repeat':True})
        assert len(sent) == 1, 'Composition and repeated Enter must not send'
        await panel.get_by_role('button',name='Minimize chat',exact=True).click()
        await expect(panel).to_be_hidden()
        await page.wait_for_timeout(200)
        before, before_ack = len(reads), len(acknowledgements)
        messages.append({'id':12,'sender':BOB,'sender_name':'Bob Jones','body':'While minimized','created_at':'2026-10-16T10:02:00Z','attachment':None})
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await page.wait_for_timeout(250)
        assert len(reads) == before, 'Minimized widget must not fetch messages'
        assert len(acknowledgements) == before_ack, 'Minimized widget must not acknowledge messages'
        await launcher.click()
        await expect(draft).to_have_value('Draft stays private\n')
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Bob Jones')
        await expect(panel.get_by_text('While minimized',exact=True)).to_be_visible()
        await page.wait_for_timeout(350)
        assert 12 in acknowledged_ids(), acknowledgements
        other_page = await page.context.new_page()
        await other_page.goto('about:blank')
        await other_page.bring_to_front()
        # Headless Chromium does not consistently change document.hasFocus across tabs.
        await page.evaluate("window.__originalHasFocus = document.hasFocus; document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))")
        await page.wait_for_timeout(150)
        before_ack = len(acknowledgements)
        messages.append({'id':13,'sender':BOB,'sender_name':'Bob Jones','body':'While unfocused','created_at':'2026-10-16T10:03:00Z','attachment':None})
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await page.wait_for_timeout(300)
        assert len(acknowledgements) == before_ack, 'Unfocused page must not acknowledge messages'
        await page.bring_to_front()
        await page.evaluate("document.hasFocus = window.__originalHasFocus; window.dispatchEvent(new Event('focus'))")
        await page.wait_for_timeout(350)
        assert 13 in acknowledged_ids(), acknowledgements
        await other_page.close()
        # Once the reader scrolls up, fetching a newer message below the viewport is not a read.
        messages.extend({'id':i,'sender':BOB,'sender_name':'Bob Jones','body':f'History fixture {i} ' + 'detail ' * 12,'created_at':'2026-10-16T10:05:00Z','attachment':None} for i in range(40,60))
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await expect(panel.get_by_text(re.compile('^History fixture 59'))).to_be_visible()
        await page.wait_for_timeout(350)
        message_log = panel.locator('.member-chat-messages')
        await message_log.evaluate("element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); }")
        await page.wait_for_timeout(150)
        before_ack = len(acknowledgements)
        messages.append({'id':60,'sender':BOB,'sender_name':'Bob Jones','body':'Unseen below viewport','created_at':'2026-10-16T10:06:00Z','attachment':None})
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await page.wait_for_timeout(350)
        assert 60 not in acknowledged_ids(), 'Fetched messages below the viewport must remain unread'
        await message_log.evaluate("element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); }")
        await page.wait_for_timeout(350)
        assert 60 in acknowledged_ids(), acknowledgements
        await panel.get_by_role('button',name='Send',exact=True).click()
        await expect(draft).to_have_value('')
        assert len(sent) == 2 and 'Draft stays private' in sent[-1]
        await panel.get_by_role('button',name='Delete message',exact=True).click()
        await panel.get_by_role('button',name='Cancel',exact=True).click()
        assert not deleted
        await expect(panel.get_by_text('My removable message',exact=True)).to_be_visible()
        await panel.get_by_role('button',name='Delete message',exact=True).click()
        await panel.get_by_role('button',name='Delete',exact=True).click()
        await expect(panel.get_by_text('My removable message',exact=True)).to_have_count(0)
        assert deleted == ['/api/community/rooms/1/messages/11']
        await page.screenshot(path='/tmp/member-chat-widget-conversation.png',full_page=True,animations='disabled')
        await panel.get_by_role('button',name='Back to conversations',exact=True).click()
        await panel.get_by_role('button',name='Channels',exact=True).click()
        await panel.get_by_role('button',name='Create group',exact=True).click()
        await expect(panel.get_by_label('Group privacy')).to_have_value('private')
        await panel.get_by_role('textbox',name='Group name').fill('Design team')
        await panel.locator('.member-chat-member-option').filter(has_text='Bob Jones').get_by_role('checkbox').check()
        await panel.locator('.member-chat-member-option').filter(has_text='Carol Smith').get_by_role('checkbox').check()
        assert len(created) == 1 and len(sent) == 2, 'Selecting recipients must not share anything'
        await panel.get_by_role('button',name='Create group · 3 members',exact=True).click()
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Design team')
        assert created[-1] == {'kind':'channel','name':'Design team','visibility':'private','members':[BOB,CAROL]}, created
        await expect(panel.locator('.member-chat-receipt')).to_have_text(re.compile(r'Sent$'))
        peer_cursor = 30
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await expect(panel.locator('.member-chat-receipt')).to_have_text(re.compile(r'Seen by 2$'))
        await panel.get_by_role('button',name='View group members').click()
        await expect(panel.locator('.member-chat-audience li')).to_have_text(['You','Bob Jones','Carol Smith'])
        assert 'kc-' not in await panel.inner_text()
        await panel.get_by_role('button',name='Expand chat',exact=True).click()
        await expect(panel).to_have_css('width', '740px')
        await page.set_viewport_size({'width':390,'height':844})
        await page.wait_for_timeout(250)
        await page.screenshot(path='/tmp/member-chat-widget-mobile.png',full_page=True,animations='disabled')
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile document overflow'
        box = await panel.bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= 390 and box['height'] <= 600, box
        assert not errors, errors
        await browser.close()
        print('PASS: widget, identity/search, Enter/Shift+Enter/IME/repeat, failed-send draft, direct/group receipts, focused visible-only acknowledgements, minimized privacy, group audience, deletion and mobile (synthetic fixtures)')

asyncio.run(main())
