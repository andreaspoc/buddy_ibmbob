"""Synthetic people-chat collaboration UI checks; no real member data or model calls."""
import asyncio
import json
import re
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

SELF='kc-collab-self-fixture'
PEER='kc-collab-peer-fixture'
THIRD='kc-collab-third-fixture'

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        context=await browser.new_context(viewport={'width':1280,'height':900})
        page=await context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.add_init_script(f"sessionStorage.setItem('buddy-welcome-v1:{SELF}','seen')")
        directory=[{'username':PEER,'display_name':'Ben Fixture'},{'username':THIRD,'display_name':'Cara Fixture'}]
        members=[{'username':SELF,'display_name':'Alice Fixture'},directory[0]]
        room={'id':1,'kind':'channel','name':'Fixture project','visibility':'private','subscribed':True,'is_owner':True,'member_count':2,'unread_count':0,'notification_mode':'all'}
        def msg(mid,body,**extra):
            return {'id':mid,'sender':PEER,'sender_name':'Ben Fixture','body':body,'created_at':'2026-10-16T10:00:00Z','attachment':None,'reactions':[],'tasks':[],'parent_id':None,'pinned':False,**extra}
        messages=[msg(10,'Discuss the selected project'),msg(11,'Another independent topic'),msg(12,'Existing thread reply',parent_id=10),
                  msg(13,'Hidden raw body',shared={'kind':'artifact','title':'Project presentation','body':'Shared presentation copy','path':'/private/source/secret.pptx'},attachment={'id':13,'filename':'project.pptx','size':1024}),
                  msg(14,'Greek Bob summary',sender=SELF,sender_name='Alice Fixture',automated=True,shared={'kind':'bob','title':'Bob reply','requested_by':'Alice Fixture','context_count':1})]
        calls=[]
        tasks=[]
        settings={'instructions':''}
        pref={'mode':'all'}
        quiet={'quiet_enabled':False,'start':'22:00','end':'08:00','timezone':'UTC'}
        async def route(r):
            path=urlsplit(r.request.url).path; method=r.request.method
            if path=='/' or path.startswith(('/assets/','/static/')): await r.continue_(); return
            payload=None
            if r.request.post_data:
                try: payload=json.loads(r.request.post_data)
                except ValueError: payload=r.request.post_data
            calls.append((method,path,payload))
            data=[]
            if path=='/auth/status': data={'user':{'username':SELF,'display_name':'Alice Fixture','is_admin':False}}
            elif path=='/personalization/tutorials': data={'disabled':True}
            elif path=='/api/community/members': data=directory
            elif path=='/api/community/rooms': data=[room]
            elif path=='/api/community/rooms/1/messages':
                if method=='POST':
                    assert isinstance(payload,str)
                    parent=re.search(r'name="parent_id"\r\n\r\n(\d+)',payload)
                    messages.append(msg(20,'New thread response',sender=SELF,sender_name='Alice Fixture',parent_id=int(parent.group(1)) if parent else None))
                    data={'id':20}
                else: data=messages
            elif path.endswith('/receipts'):
                data=[{'username':PEER,'display_name':'Ben Fixture','last_read':14,'seen_message_ids':[10,11,12,13,14]}]
            elif path.endswith('/read'):
                data={'last_read':max(payload.get('message_ids') or [payload.get('message_id',0)])}
            elif path=='/api/community/rooms/1/members':
                if method=='PUT': members[:]=[{'username':SELF,'display_name':'Alice Fixture'},*[m for m in directory if m['username'] in payload['usernames']]]
                data=members
            elif path.endswith('/messages/10/reactions'):
                messages[0]['reactions']=[] if messages[0]['reactions'] else [{'emoji':payload['emoji'],'count':1,'mine':True}]
                data={'ok':True}
            elif path.endswith('/messages/10/pin'): messages[0]['pinned']=payload['pinned']; data={'ok':True}
            elif path.endswith('/save-note'): data={'id':99}
            elif path.endswith('/messages/10/tasks'):
                tasks.append({'id':1,'room_id':1,'message_id':10,'creator':SELF,**payload,'status':'todo'})
                data=tasks[-1]
            elif path=='/api/community/rooms/1/tasks/1': tasks[0]['status']=payload['status'];data=tasks[0]
            elif path=='/api/community/rooms/1/tasks': data=tasks
            elif path=='/api/community/rooms/1/files': data=[{'id':13,'filename':'project.pptx','size':1024}]
            elif path.endswith('/search'): data=[{**messages[0],'room_id':1}]
            elif path.endswith('/bob-settings'):
                if method=='PUT':settings.update(payload)
                data=settings
            elif path.endswith('/bob'):
                data={'id':30,'reply':'Synthetic Bob reply'}
            elif path=='/api/community/rooms/1/notifications':
                if method=='PUT': pref.update(payload);room['notification_mode']=pref['mode']
                data=pref
            elif path=='/api/community/notification-settings':
                if method=='PUT': quiet.update(payload)
                data=quiet
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.goto('http://127.0.0.1:8080')
        await page.locator('.member-chat-launcher').click()
        panel=page.locator('#member-chat-panel')
        await panel.get_by_role('button',name='Channels',exact=True).click()
        await panel.locator('.member-chat-room').filter(has_text='Fixture project').click()
        await expect(panel.locator('[data-message-id="10"]')).to_be_visible()
        await expect(panel.get_by_text('Bob · requested by you',exact=True)).to_be_visible()
        assert 'automatic reply' not in await panel.locator('[data-message-id="14"]').inner_text()
        assert '/private/source' not in await panel.inner_text()
        await expect(panel.get_by_text('Project presentation',exact=True)).to_be_visible()
        async def action(label):
            await panel.locator('[data-message-id="10"]').get_by_role('button',name='Message actions',exact=True).click()
            await panel.get_by_role('button',name=label,exact=True).click()
        async def tool(label):
            await panel.get_by_role('button',name='Conversation tools',exact=True).click()
            await panel.locator('.people-conversation-menu').get_by_role('button',name=label,exact=True).click()
            await expect(panel.locator('.people-chat-tools')).to_be_visible()
        async def back(): await panel.locator('.people-chat-tools').get_by_role('button',name='Back to messages',exact=True).click()
        await action('React 👍')
        await expect(panel.get_by_role('button',name='👍, 1 reactions')).to_be_visible()
        await panel.get_by_role('button',name='👍, 1 reactions').click()
        await expect(panel.get_by_role('button',name='👍, 1 reactions')).to_have_count(0)
        await action('Pin message')
        await tool('Pinned')
        await expect(panel.locator('.people-chat-tools').get_by_text('Discuss the selected project',exact=True)).to_be_visible()
        await back()
        await action('Save as private note')
        await expect(panel.get_by_text(re.compile('Saved a private note linked'))).to_be_visible()
        assert any(path.endswith('/messages/10/save-note') for _,path,_ in calls)
        await action('Reply in thread')
        await expect(panel.get_by_text('Existing thread reply',exact=True)).to_be_visible()
        await expect(panel.get_by_text('Another independent topic',exact=True)).to_have_count(0)
        await panel.get_by_role('textbox',name='Message to Fixture project').fill('New thread response')
        await panel.get_by_role('textbox',name='Message to Fixture project').press('Enter')
        await expect(panel.get_by_text('New thread response',exact=True)).to_be_visible()
        posts=[body for method,path,body in calls if method=='POST' and path.endswith('/messages')]
        assert 'name="parent_id"\r\n\r\n10' in posts[-1],posts[-1]
        # Incoming unrelated roots must not become Seen while only this thread is visible.
        mark=len(calls)
        messages.extend([msg(21,'New unrelated root'),msg(22,'New visible thread reply',parent_id=10)])
        await page.evaluate("window.dispatchEvent(new Event('community-updated'))")
        await expect(panel.get_by_text('New visible thread reply',exact=True)).to_be_visible(timeout=10000)
        await expect(panel.get_by_text('New unrelated root',exact=True)).to_have_count(0)
        await page.wait_for_timeout(500)
        for method,path,payload in calls[mark:]:
            if method=='POST' and path.endswith('/read') and isinstance(payload,dict) and 'message_ids' in payload:
                assert 21 not in payload['message_ids'],payload
        await panel.get_by_role('button',name='Back to conversation',exact=True).click()
        await action('Create task / reminder')
        await panel.get_by_role('textbox',name='Task title').fill('Review shared presentation')
        await panel.get_by_role('combobox',name='Task assignee').select_option(PEER)
        await panel.get_by_label('Task due date').fill('2026-10-20T09:30')
        await panel.get_by_role('button',name='Create task',exact=True).click()
        await tool('Tasks')
        await panel.get_by_role('combobox',name='Status of Review shared presentation').select_option('done')
        await expect(panel.get_by_role('combobox',name='Status of Review shared presentation')).to_have_value('done')
        assert tasks[0]['assignee']==PEER and tasks[0]['due_at']
        assert any(method=='PATCH' and path.endswith('/tasks/1') for method,path,_ in calls)
        await back()
        await tool('Members')
        await expect(panel.get_by_text(re.compile('New members can read the existing conversation history'))).to_be_visible()
        await panel.locator('.people-tool-member-list label').filter(has_text='Cara Fixture').get_by_role('checkbox').check()
        await panel.get_by_role('button',name='Save membership').click()
        await expect(panel.get_by_text('Membership updated.',exact=True)).to_be_visible()
        assert THIRD in next(body['usernames'] for method,path,body in reversed(calls) if method=='PUT' and path.endswith('/members'))
        await back()
        await tool('Shared files')
        await expect(panel.get_by_role('link',name=re.compile('project.pptx'))).to_have_attribute('href','/api/community/rooms/1/attachments/13')
        await back()
        await tool('Search')
        await panel.get_by_role('textbox',name='Search messages and shared items').fill('project')
        await panel.locator('.people-chat-tools').get_by_role('button',name='Search',exact=True).click()
        await expect(panel.locator('.people-tool-row').filter(has_text='Discuss the selected project')).to_be_visible()
        await panel.get_by_role('checkbox',name='All conversations I can access').check()
        await panel.locator('.people-chat-tools').get_by_role('button',name='Search',exact=True).click()
        await page.wait_for_timeout(100)
        assert any(path=='/api/community/rooms/1/search' for _,path,_ in calls)
        assert any(path=='/api/community/search' for _,path,_ in calls)
        await back()
        await panel.get_by_role('button',name='Ask Bob in this conversation').click()
        await panel.get_by_role('textbox',name='Question for Bob').fill('Σύνοψη παρακαλώ')
        await panel.locator('.people-tool-context label').filter(has_text='Discuss the selected project').get_by_role('checkbox').check()
        await panel.get_by_role('button',name='Ask Bob with 1 selected messages').click()
        await expect(panel.get_by_role('textbox',name='Message to Fixture project')).to_be_visible()
        assert next(body for method,path,body in reversed(calls) if method=='POST' and path.endswith('/bob'))=={'prompt':'Σύνοψη παρακαλώ','message_ids':[10]}
        await tool('Bob for this inbox')
        await panel.get_by_role('textbox',name='Bob inbox instructions').fill('Use project context and a friendly tone.')
        await panel.get_by_role('button',name='Save Bob instructions').click()
        await expect(panel.get_by_text('Saved your instructions for this inbox.',exact=True)).to_be_visible()
        assert settings['instructions']=='Use project context and a friendly tone.'
        await back()
        await tool('Notifications')
        for mode in ['mentions','muted','all']:
            await panel.get_by_role('combobox',name='Conversation notifications').select_option(mode)
            await panel.get_by_role('button',name='Save notifications').click()
            await expect(panel.get_by_text('Notification settings saved. Unread counts remain visible.',exact=True)).to_be_visible()
            assert pref['mode']==mode
        await panel.get_by_role('checkbox',name='Quiet hours for all people chat').check()
        await panel.get_by_label('Quiet hours start').fill('21:30')
        await panel.get_by_label('Quiet hours end').fill('07:30')
        await panel.get_by_label('Quiet hours timezone').fill('Europe/London')
        await panel.get_by_role('button',name='Save notifications').click()
        await page.wait_for_timeout(150)
        assert quiet=={'quiet_enabled':True,'start':'21:30','end':'07:30','timezone':'Europe/London'},quiet
        await back()
        await page.set_viewport_size({'width':390,'height':844})
        await tool('Bob for this inbox')
        await expect(panel.get_by_role('textbox',name='Bob inbox instructions')).to_be_visible()
        box=await panel.bounding_box()
        assert box['width']<=390 and box['x']>=0,box
        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        await page.screenshot(path='/tmp/people-collaboration-mobile.png',full_page=True)
        assert not errors,errors
        print('People collaboration browser checks passed: reactions, pins, threads, tasks, membership, sharing, search, Bob scope/context, notification preferences, mobile layout.')
        await browser.close()

asyncio.run(main())
