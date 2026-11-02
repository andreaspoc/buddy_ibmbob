"""Purple workspace visual regression using synthetic API fixtures only."""
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
                data = {'items':[{'id':1,'title':'Synthetic note','body':'Visual fixture only.','color':'butter','created_at':'2026-10-20T08:00:00Z','collection':'Inbox','tags':[],'sources':[],'favorite':False}]}
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
        async def background(selector,color):
            el=page.locator(selector).first
            await el.wait_for()
            if await el.evaluate('el=>el.classList.contains("buddy-toolbar")'):
                image=await el.evaluate('el=>getComputedStyle(el.classList.contains("buddy-toolbar-embedded")?el.parentElement:el).backgroundImage')
                assert image == 'none',(selector,image)
                assert await el.evaluate('el=>getComputedStyle(el).color')=='rgb(22, 22, 22)',selector
            else:
                actual=await el.evaluate('el=>getComputedStyle(el).backgroundColor')
                assert actual==color,(selector,actual,color)
        for width,height in [(320,568),(390,844),(768,1024),(1280,720),(1440,900),(1920,1080)]:
            await page.set_viewport_size({'width':width,'height':height})
            await page.wait_for_timeout(100)
            await background('.topbar','rgb(224, 224, 224)')
            await background('.composer','rgb(252, 249, 255)')
            heading=page.locator('.welcome-buddy-hero h2')
            size=await heading.evaluate('el=>getComputedStyle(el).fontSize')
            assert size==('32px' if width<=700 else '36px'),(width,size)
            assert await page.locator('#prompt-input').evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1')
            assert await page.evaluate("document.documentElement.scrollWidth*(Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))||1)<=innerWidth+1")
            await page.get_by_role('button',name='Buddy menu',exact=True).click()
            await background('.workspace-tools-panel','rgb(255, 255, 255)')
            await page.keyboard.press('Escape')
            assert await page.get_by_role('button',name='Buddy menu',exact=True).evaluate('el=>el===document.activeElement')
            print(f'PASS {width}: larger heading and accessible composer, no horizontal overflow')
        await page.set_viewport_size({'width':1440,'height':1000})
        assert await page.locator('.sidebar-group-label').first.evaluate('el=>getComputedStyle(el).fontSize') == '12px'
        await page.locator('#prompt-input').focus()
        assert await page.locator('.composer').evaluate('el=>getComputedStyle(el).outlineStyle') == 'solid'
        assert await page.locator('.composer').evaluate('el=>getComputedStyle(el).borderRadius') == '8px'
        await page.screenshot(path='/tmp/buddy-heading-refinement.png')
        await page.locator('.sidebar').get_by_role('button',name='Notes',exact=True).click()
        await background('.notes-workspace','rgb(241, 235, 246)')
        await background('.notes-collections','rgb(29, 25, 36)')
        await background('.notes-workspace-hero','rgb(224, 224, 224)')
        swatch=page.locator('.notes-color-dot[data-note-color=butter]').first
        assert await swatch.evaluate('el=>getComputedStyle(el).backgroundColor')=='rgb(255, 243, 189)'
        await page.locator('.note-options-trigger').first.click()
        await background('.note-options-menu','rgb(255, 255, 255)')
        await page.keyboard.press('Escape')
        await page.screenshot(path='/tmp/buddy-notes-refinement.png')
        await page.locator('[data-note-new]').click()
        await page.locator('.notes-editor[open]').wait_for()
        await background('.notes-editor-heading','rgb(224, 224, 224)')
        await page.keyboard.press('Escape')
        await page.locator('.notes-editor[open]').wait_for(state='detached')
        await page.locator('.notes-back').click()
        await page.locator('.sidebar').get_by_role('button',name='Tasks',exact=False).first.click()
        await background('.tasks-view','rgb(241, 235, 246)')
        await background('.tasks-view .buddy-section-header','rgb(224, 224, 224)')
        await page.locator('.sidebar').get_by_role('button',name='Knowledge base',exact=True).click()
        await background('.knowledge-page','rgb(241, 235, 246)')
        await background('.knowledge-hero','rgb(224, 224, 224)')
        await page.screenshot(path='/tmp/buddy-knowledge-refinement.png')
        await page.get_by_role('button',name='Apps',exact=True).click()
        await background('.installed-apps','rgb(241, 235, 246)')
        await background('.installed-apps .buddy-section-header','rgb(224, 224, 224)')
        await page.keyboard.press('Escape')
        for menu,item,selector in [('Buddy menu','Memory & presets','.personalization-dialog'),('Settings menu','Connected services','.mcp-manager'),('Settings menu','User groups & administrators','.administration-page'),('Settings menu','Mods','.mod-registry-dialog')]:
            await page.goto('http://127.0.0.1:8080')
            await page.locator('.topbar').wait_for()
            print('Checking',selector)
            await page.get_by_role('button',name=menu,exact=True).click()
            await page.get_by_role('button',name=item,exact=True).click()
            await background(selector,'rgb(241, 235, 246)')
            await background(selector+' .buddy-section-header','rgb(224, 224, 224)')
            await page.screenshot(path='/tmp/buddy-'+selector.lstrip('.')+'-refinement.png')
            if selector=='.mod-registry-dialog':
                close=page.get_by_role('button',name='Close Buddy Mods Registry',exact=True)
                assert await close.evaluate('el=>getComputedStyle(el).color')=='rgb(22, 22, 22)'
                assert await page.locator('.modal-backdrop').evaluate('el=>getComputedStyle(el).backdropFilter')=='none'
                assert await page.locator('.mod-card-author').first.evaluate('el=>getComputedStyle(el).fontSize')=='12px'
                assert await page.locator('.mod-card').first.evaluate("el=>getComputedStyle(el).backgroundColor")=='rgb(255, 255, 255)'
                assert await page.locator('.mod-card-name').first.evaluate("el=>getComputedStyle(el).color")=='rgb(22, 22, 22)'
                await background('.mod-registry-footer','rgb(255, 255, 255)')
                await page.locator('.mod-tab-btn').filter(has_text='Lifecycle Hooks').click()
                await page.get_by_text('No Lifecycle Hooks Configured',exact=True).wait_for()
                await page.get_by_role('button',name='Create Custom Hook',exact=True).click()
                await background('.hook-edit-form','rgb(255, 255, 255)')
                print('PASS Mods cards, footer and Lifecycle Hooks submenu use the shared palette')
            if selector in ('.personalization-dialog','.mcp-manager'):
                await page.locator(selector).get_by_role('button',name='Close',exact=True).click()
            elif selector=='.administration-page':
                await page.locator(selector).get_by_role('button',name='Back to chat',exact=True).click()
            elif selector=='.mod-registry-dialog':
                await page.get_by_role('button',name='Close Buddy Mods Registry',exact=True).click()
        assert await page.locator('.sidebar').evaluate('el=>getComputedStyle(el).backgroundColor')=='rgb(29, 25, 36)'
        assert not errors,errors
        print('PASS Notes, Tasks, Knowledge, Apps, memory, connections, administration and Mods share the neutral palette')
        await browser.close()

asyncio.run(main())
