"""Maltese language switching using explicitly synthetic account and API fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000}, reduced_motion='reduce')
        errors = []
        page.set_default_timeout(8000)
        page.on('console',lambda msg: print('CONSOLE',msg.text[:2400]) if msg.type=='error' else None)
        page.on('pageerror', lambda error: (errors.append(str(error)),print('BROWSER ERROR',str(error))))
        await page.add_init_script("if (!localStorage.getItem('bob-ui-language')) localStorage.setItem('bob-ui-language','en'); sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        note_items=[{'id':1,'title':'Synthetic note','body':'Visual fixture only.','color':'butter','created_at':'2026-10-20T08:00:00Z','collection':'Inbox','tags':[],'sources':[],'favorite':False}]
        async def handle(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith('/assets/'):
                build=os.getenv('VISUAL_PREVIEW_BUILD')
                if build:
                    file=Path(build) / ('index.html' if path == '/' else path.lstrip('/'))
                    await route.fulfill(path=str(file))
                else:
                    await route.continue_()
                return
            if path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'display_name': 'Fixture User', 'is_admin': True}}
            elif path == '/api/apps':
                data = {'apps':[{'id':'office','name':'Office Suite','description':'Test office launcher','kind':'installed','desktop_only':True,'launch':{'kind':'office'}}]}
            elif path in ('/hooks','/api/hooks'):
                data = {'hooks':[],'templates':[]}
            elif path == '/api/notes':
                if route.request.method == 'POST':
                    data={**json.loads(route.request.post_data),'id':len(note_items)+1,'collection':'Inbox','created_at':'2026-10-20T08:00:00Z'}
                    note_items.append(data)
                else:
                    data={'items':note_items}
            elif path == '/admin/audit':
                data = {'events':[],'next_before_id':None}
            elif path == '/admin/feedback/quality':
                data = {'days':30,'totals':dict(reports=0,open=0,reviewed=0,resolved=0,reporters=0),'categories':[],'sources':[],'trend':[]}
            elif path == '/admin/feedback':
                data = {'items':[],'next_before_id':None}
            elif path == '/admin/smtp':
                data = {'enabled':False,'host':'','port':587,'security':'starttls','username':'','from_address':'','from_name':'','password_configured':False}
            elif path == '/admin/users':
                data = {'users':[],'pending_admins':[]}
            elif path == '/access/me':
                data = {'user':{'username':'fixture-user','display_name':'Fixture User'},'administrator':True,'libraries':[],'audiences':[],'mcps':[]}
            elif path == '/api/office/status':
                data = {'ready':True}
            elif path in ('/api/office/files','/api/office/folders'):
                data = {'items':[]}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            elif path in ('/research/capabilities', '/workflows/capabilities'):
                data = {'web_search': True}
            elif path == '/sessions':
                data = [{'id': 'a' * 32, 'title': 'Unchanged fixture conversation', 'updated_at': 1}]
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        await page.route('**/*', handle)
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL', 'http://127.0.0.1:8080'))
        await page.locator('.topbar').wait_for()
        await page.locator('.sidebar').get_by_role('button',name='Notes',exact=True).click()
        grid=page.locator('.notes-saved-grid')
        await grid.wait_for()
        assert await grid.locator('article').count()==1
        assert await grid.evaluate('el=>el.clientWidth') <= 640
        await page.locator('[data-note-new]').click()
        editor=page.locator('.notes-editor[open]')
        await editor.get_by_label('Title',exact=True).fill('Second synthetic note')
        await editor.locator('#note-write-panel textarea').fill('A long unbroken reference: '+('reference'*80))
        await editor.get_by_role('button',name='Save note',exact=True).click()
        await editor.wait_for(state='detached')
        await page.wait_for_function('document.querySelectorAll(".notes-saved-grid > article").length===2')
        assert await grid.locator('article').count()==2
        for width,expected in [(300,1),(620,2),(300,1)]:
            await grid.evaluate('(el,w)=>el.style.width=w+"px"',width)
            await page.wait_for_function('(n)=>getComputedStyle(document.querySelector(".notes-saved-grid")).gridTemplateColumns.split(" ").length===n',arg=expected)
            assert await grid.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
        await page.get_by_role('button',name='List',exact=True).click()
        await grid.evaluate('el=>el.style.width="620px"')
        await page.wait_for_function('getComputedStyle(document.querySelector(".notes-saved-grid")).gridTemplateColumns.split(" ").length===1')
        await page.get_by_role('button',name='Cards',exact=True).click()
        await page.wait_for_function('getComputedStyle(document.querySelector(".notes-saved-grid")).gridTemplateColumns.split(" ").length===2')
        await grid.evaluate('el=>el.style.removeProperty("width")')
        for width in [320,390,768,1440]:
            await page.set_viewport_size({'width':width,'height':1000})
            await page.wait_for_timeout(150)
            assert await grid.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
        assert not errors,errors
        print('PASS creation recalculates widths; container resizing, list/card switch, long content and responsive layouts fit')
        await browser.close()

asyncio.run(main())
