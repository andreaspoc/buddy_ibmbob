"""Synthetic browser fixtures verify ephemeral named typing, never draft sharing."""
import asyncio
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':900})
        await page.add_init_script("sessionStorage.setItem('buddy-welcome-v1:self','seen')")
        signals=[]; sent=[]; errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        async def route(r):
            path=urlsplit(r.request.url).path
            if path=='/' or path.startswith(('/assets/','/static/')): await r.continue_(); return
            data=[]
            if path=='/auth/status':data={'user':{'username':'self','display_name':'Test User','is_admin':False}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/api/community/rooms':data=[{'id':2,'kind':'channel','name':'Team','subscribed':True,'unread_count':0,'visibility':'private','member_count':5}]
            elif path=='/api/community/members':data=[{'username':'maria','display_name':'Maria'},{'username':'alice','display_name':'Alice'}]
            elif path.endswith('/typing'):signals.append(r.request.post_data_json);data={'sent':True}
            elif path.endswith('/messages'):
                if r.request.method=='POST':sent.append(r.request.post_data);data={'id':1}
            elif path.endswith('/away'):data={'active':False}
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.goto('http://127.0.0.1:8080')
        await page.locator('.member-chat-launcher').wait_for()
        await page.evaluate("window.dispatchEvent(new CustomEvent('community-open-room',{detail:{roomId:2,kind:'channel'}}))")
        panel=page.locator('#member-chat-panel')
        await expect(panel.locator('.member-chat-conversation-header h2')).to_have_text('Team')
        async def signal(name,typing=True,room=2,parent=None):
            await page.evaluate("data=>window.dispatchEvent(new CustomEvent('community-typing',{detail:data}))",dict(room_id=room,username=name.lower(),display_name=name,typing=typing,parent_id=parent))
        indicator=panel.locator('.member-chat-typing')
        await signal('Maria');await expect(indicator).to_have_text('Maria is typing…')
        await signal('Alice');await expect(indicator).to_have_text('Maria and Alice are typing…')
        await signal('Anna');await signal('Nikos');await expect(indicator).to_have_text('Maria, Alice and 2 others are typing…')
        await signal('Maria',False);await expect(indicator).not_to_contain_text('Maria')
        await signal('Other',room=99);await expect(indicator).not_to_contain_text('Other')
        await signal('Thread',parent=99);await expect(indicator).not_to_contain_text('Thread')
        draft=panel.get_by_role('textbox',name='Message to Team')
        await draft.fill('Private draft must stay local')
        await page.wait_for_timeout(200)
        assert signals and signals[-1]=={'typing':True,'parent_id':None}, signals
        assert all(set(value)<= {'typing','parent_id'} for value in signals)
        await draft.press('Enter');await expect(draft).to_have_value('')
        assert len(sent)==1
        await page.wait_for_timeout(200)
        assert signals[-1]['typing'] is False
        await signal('Alice',False);await signal('Anna',False);await signal('Nikos',False)
        await expect(indicator).to_have_count(0)
        await signal('Maria')
        await page.wait_for_timeout(7200)
        await expect(indicator).to_have_count(0)
        await draft.fill('Minimize stops typing')
        await panel.get_by_role('button',name='Minimize chat',exact=True).click()
        await page.wait_for_timeout(200)
        assert signals[-1]['typing'] is False
        await page.locator('.member-chat-launcher').click()
        await expect(indicator).to_have_count(0)
        assert not errors,errors
        await browser.close()
        print('PASS typing names, group aggregation, stop/expiry/minimize, room/thread isolation, no draft transport')

asyncio.run(main())
