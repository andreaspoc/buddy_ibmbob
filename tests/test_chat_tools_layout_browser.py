"""Synthetic actual-App regression for input tools, references, skills and touch keyboard layout.
All API requests are intercepted; no real files, notes, accounts, voice or model services are used.
"""
import asyncio
import os
import re
from urllib.parse import urlsplit
from playwright.async_api import async_playwright


async def main():
    sid = 'c' * 32
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000}, has_touch=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en')")
        async def route(request):
            path = urlsplit(request.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.svg', '.png', '.ico')):
                await request.continue_()
                return
            data = []
            if path == '/auth/status': data = {'user': {'username': 'fixture-user', 'is_admin': False}}
            elif path == '/personalization/tutorials': data = {'disabled': True}
            elif path.endswith('/capabilities'): data = {'web_search': False}
            elif path.startswith('/auth/microsoft'): data = {'configured': False, 'connected': False}
            elif path == '/sessions': data = {'id': sid} if request.request.method == 'POST' else [{'id': sid, 'title': 'Synthetic tools chat'}]
            elif path == '/api/apps': data = {'apps': [{'id': app_id, 'name': name, 'description': 'Synthetic '+name, 'kind': 'installed' if app_id == 'office' else 'core', 'desktop_only': app_id == 'office', 'launch': {'kind': app_id}} for app_id, name in [('office','Office Suite'),('chat','Chat'),('notes','Notes'),('presentations','Create presentation'),('productivity','Productivity workspace'),('connections','Connected services'),('people','People')]]}
            elif path == '/api/office/chat-capabilities': data = {'version': 1}
            elif path == '/api/office/files': data = {'items': [{'id': 'fixture-file', 'name': 'Synthetic reference.docx', 'extension': 'docx'}]}
            elif path == '/api/notes': data = {'items': [{'id': 123, 'title': 'Synthetic selected note'}], 'next_before_id': None}
            await request.fulfill(json=data)
        await page.route('**/*', route)
        await page.goto(os.getenv('CHAT_TOOLS_PREVIEW_URL', 'http://127.0.0.1:3023'))
        row = page.get_by_role('group', name='Chat tools', exact=True)
        await row.get_by_role('button', name='Use Office files', exact=True).wait_for()
        for name in ['Office Suite', 'Notes', 'Selected notes (0/5)', 'Use Office files', 'Voice chat']:
            assert await row.get_by_role('button', name=re.compile(r'^(?:▤ )?Notes$') if name == 'Notes' else name, exact=True).is_visible(), name
        assert await page.locator('.workspace-navigation').get_by_role('button', name='Office Suite', exact=True).count() == 0
        assert await page.locator('.workspace-navigation').get_by_role('button', name='Notes', exact=True).count() == 0
        navigation = page.get_by_role('navigation', name='Workspace navigation', exact=True)
        primary = navigation.locator('.workspace-notes-tab, .workspace-menu-trigger')
        assert await primary.count() == 3, await navigation.inner_html()
        for name in ['Apps', 'Buddy menu', 'Settings menu']:
            assert await navigation.get_by_role('button', name=name, exact=True).is_visible()
        assert await navigation.get_by_role('button', name='Workspace tools', exact=True).count() == 0
        await navigation.get_by_role('button', name='Settings menu', exact=True).click()
        settings = page.get_by_role('dialog', name='Settings menu', exact=True)
        for name in ['Connected services', 'Add connections', 'Add agents']:
            assert await settings.get_by_role('button', name=name, exact=True).is_visible()
        assert await settings.get_by_role('button', name='Apps', exact=True).count() == 0
        await page.keyboard.press('Escape')
        await navigation.get_by_role('button', name='Apps', exact=True).click()
        apps = page.get_by_role('dialog', name='Apps', exact=True)
        assert await apps.get_by_role('button', name=re.compile('Connected services')).count() == 0
        await apps.get_by_role('button', name=re.compile('Create presentation')).click()
        await page.get_by_role('dialog', name='Set up your presentation', exact=True).wait_for()
        await page.get_by_role('dialog', name='Set up your presentation', exact=True).get_by_role('button', name='Close presentation setup', exact=True).click()
        await navigation.get_by_role('button', name='Apps', exact=True).click()
        await apps.get_by_role('button', name=re.compile('Productivity workspace')).click()
        await page.get_by_role('dialog', name='Productivity workspace', exact=True).wait_for()
        await page.get_by_role('dialog', name='Productivity workspace', exact=True).get_by_role('button', name='Close', exact=True).click()
        assert await row.get_by_role('button', name='Templates', exact=True).count() == 0
        assert await page.locator('#welcome-prompt-templates').count() == 0
        skills = row.get_by_role('button', name='Skills', exact=True)
        assert await skills.get_attribute('aria-expanded') == 'true'
        await skills.click()
        await page.locator('#chat-skill-picker input').wait_for()
        assert await page.locator('#chat-skill-picker input').evaluate('(el)=>el===document.activeElement')
        await page.reload()
        await row.get_by_role('button', name='Use Office files', exact=True).wait_for()
        await page.locator('#chat-skill-picker').wait_for()

        async def bounds(selector):
            return await page.locator(selector).evaluate('(el)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}')
        async def assert_popup(selector, baseline):
            popup = await bounds(selector)
            field = await bounds('#prompt-input')
            viewport = page.viewport_size
            assert popup['x'] >= -1 and popup['right'] <= viewport['width'] + 1, popup
            assert popup['y'] >= -1 and popup['bottom'] <= field['y'] + 1, (popup, field)
            assert abs(field['y'] - baseline['y']) < 1, (baseline, field)
            print('MEASURE', viewport['width'], selector, popup, 'input_y', field['y'], flush=True)
        note_trigger = row.get_by_role('button', name='Selected notes (0/5)', exact=True)
        baseline = await bounds('#prompt-input')
        await note_trigger.click()
        await page.get_by_role('dialog', name='Select notes', exact=True).wait_for()
        await assert_popup('.note-chat-references .office-reference-picker', baseline)
        await page.get_by_label('Search saved notes').press('Escape')
        assert await note_trigger.evaluate('(el)=>el===document.activeElement')
        await note_trigger.click()
        await page.get_by_role('checkbox', name='Synthetic selected note', exact=True).check()
        await page.get_by_role('dialog', name='Select notes', exact=True).get_by_role('button', name='Done', exact=True).click()
        await page.locator('.composer-reference-tray').get_by_text('Synthetic selected note', exact=True).wait_for()
        office_trigger = row.get_by_role('button', name='Use Office files', exact=True)
        await office_trigger.click()
        await page.get_by_role('checkbox', name='Synthetic reference.docx DOCX · My files', exact=True).check()
        await page.get_by_role('dialog', name='Office files for this conversation', exact=True).get_by_role('button', name='Done', exact=True).click()
        await page.locator('.composer-reference-tray').get_by_role('button', name='Synthetic reference.docx', exact=True).wait_for()
        assert await office_trigger.evaluate('(el)=>el===document.activeElement')

        for width, height in [(1440,1000),(320,568),(390,844)]:
            await page.set_viewport_size({'width':width,'height':height})
            await row.get_by_role('button', name='Selected notes (1/5)', exact=True).wait_for()
            assert await row.get_by_role('button', name=re.compile(r'^(?:▤ )?Notes$')).is_visible()
            assert await row.get_by_role('button', name='Voice chat', exact=True).is_visible()
            if width < 1100:
                assert not await row.get_by_role('button', name='Office Suite', exact=True).count()
                assert not await row.get_by_role('button', name='Use Office files', exact=True).count()
            if width < 1100:
                field = page.locator('#prompt-input')
                effective_font = await field.evaluate('el => {let zoom=1;for(let n=el;n;n=n.parentElement)zoom*=Number(getComputedStyle(n).zoom)||1;return parseFloat(getComputedStyle(el).fontSize)*zoom}')
                assert effective_font >= 16 - .01, f'Mobile effective input font must avoid iOS focus zoom: {effective_font}'
                await field.fill('Synthetic pointer target check')
                send = page.locator('.send-button')
                await send.scroll_into_view_if_needed()
                await send.click(trial=True)
                launch = page.locator('.member-chat-launcher')
                await field.evaluate('el=>el.blur()')
                await page.wait_for_timeout(80)
                if await launch.is_visible():
                    a, b = await bounds('.send-button'), await bounds('.member-chat-launcher')
                    assert a['right'] <= b['x'] or b['right'] <= a['x'] or a['bottom'] <= b['y'] or b['bottom'] <= a['y'], (a,b)
                await field.focus()
                assert not await launch.is_visible(), 'Floating People launcher must yield to focused mobile composer'
                # Prevent submission while checking a real pointer click reaches Send.
                await send.evaluate('el => el.addEventListener("click",event=>{event.preventDefault();window.__sendPointerReached=true},{once:true})')
                await send.click()
                assert await page.evaluate('window.__sendPointerReached === true')
                await field.fill('')
            baseline = await bounds('#prompt-input')
            assert baseline['y'] >= 0 and baseline['bottom'] <= height + 1, baseline
            assert await page.locator('.composer-reference-tray').get_by_text('Synthetic selected note', exact=True).is_visible()
            await row.get_by_role('button', name='Selected notes (1/5)', exact=True).click()
            await assert_popup('.note-chat-references .office-reference-picker', baseline)
            await page.get_by_label('Search saved notes').press('Escape')
            voice = row.get_by_role('button', name='Voice chat', exact=True)
            await voice.click()
            await page.locator('.voice-chat-panel').wait_for()
            await assert_popup('.voice-chat-panel', baseline)
            await page.get_by_role('button', name='Close voice chat', exact=True).focus()
            await page.keyboard.press('Escape')
            await page.locator('.voice-chat-panel').wait_for(state='detached')
            assert await voice.evaluate('(el)=>el===document.activeElement')
            assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
            if width in [1440,390]:
                await page.screenshot(path='/tmp/chat-tools-desktop.png' if width == 1440 else '/tmp/chat-tools-mobile.png', full_page=True)
        # Model the mobile keyboard shrinking/panning the visual viewport while
        # the layout viewport remains unchanged (the Safari/Chrome phone case).
        for width, height in [(320,568),(390,844)]:
            await page.set_viewport_size({'width':width,'height':height})
            field = page.locator('#prompt-input')
            await field.fill('Synthetic keyboard pointer target')
            await field.focus()
            for offset in [0,40]:
                await page.evaluate("""offset=>{const v=visualViewport;
                    Object.defineProperties(v,{height:{configurable:true,value:320},offsetTop:{configurable:true,value:offset},scale:{configurable:true,value:1}});
                    v.dispatchEvent(new Event('resize'));v.dispatchEvent(new Event('scroll'));
                }""",offset)
                await page.wait_for_timeout(100)
                a,b=await bounds('#prompt-input'),await bounds('.send-button')
                assert a['y']>=offset-1 and a['bottom']<=offset+321,(width,offset,a)
                assert b['y']>=offset-1 and b['bottom']<=offset+321,(width,offset,b)
                assert not await page.locator('.member-chat-launcher').is_visible()
                await page.locator('.send-button').click(trial=True)
                print('KEYBOARD',width,offset,a,b,flush=True)
            await field.fill('')
            await field.evaluate('el=>el.blur()')
            await page.evaluate("""()=>{const v=visualViewport;delete v.height;delete v.offsetTop;delete v.scale;v.dispatchEvent(new Event('resize'))}""")
        assert not errors, errors
        print('PASS input tools, template opt-in, references, popovers, native touch font, People/Send pointer access, and keyboard viewport resize/pan')
        await browser.close()


asyncio.run(main())
