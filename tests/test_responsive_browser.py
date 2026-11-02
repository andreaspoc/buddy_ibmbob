"""Responsive UI checks using explicitly synthetic API fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        touch = os.getenv('RESPONSIVE_TOUCH') == '1'
        page = await browser.new_page(has_touch=touch)
        await page.add_init_script("localStorage.setItem('bob_sidebar_width','850'); sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');")
        async def route_request(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/src/', '/@', '/node_modules/', '/static/')) or path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'display_name': 'Fixture User', 'is_admin': True}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path.endswith('/capabilities'):
                data = {'web_search': False}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(content_type='application/json', body=json.dumps(data))
        await page.route('**/*', route_request)
        await page.goto(os.getenv('RESPONSIVE_PREVIEW_URL', 'http://127.0.0.1:3002'))
        await page.locator('.topbar').wait_for()
        for width, height in [(320,568),(375,667),(390,844),(667,375),(768,1024),(820,1180),(1180,820),(834,1194),(1194,834),(1024,1366),(1366,1024),(1024,768),(1280,720),(1366,768),(1536,864),(1600,900),(1920,1080),(2560,1440),(3840,2160)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.wait_for_timeout(250)
            result = await page.evaluate('''() => {
                const header = document.querySelector('.topbar').getBoundingClientRect();
                const nodes = [...document.querySelectorAll('.topbar-actions > *, .topbar-heading, .workspace-navigation')];
                const rects = nodes.map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
                return {
                    overflow: document.documentElement.scrollWidth * (Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1) > innerWidth + 1,
                    outside: rects.some(r => r.left < header.left - 1 || r.right > header.right + 1 || r.bottom > header.bottom + 1),
                    overlap: rects.some((a,i) => rects.slice(i+1).some(b => a.left < b.right-1 && a.right > b.left+1 && a.top < b.bottom-1 && a.bottom > b.top+1)),
                    composer: document.querySelector('#prompt-input').getBoundingClientRect().bottom <= innerHeight
                };
            }''')
            assert result == {'overflow': False, 'outside': False, 'overlap': False, 'composer': True}, (width,height,result)
            assert await page.evaluate("Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))") == (.85 if width <= 1439 else 1)
            # Navigation moves to a second row on narrow screens.
            assert await page.locator('.workspace-menu-buddy').is_visible()
            assert await page.locator('.feature-toolbar').count() == 0
            assert await page.locator('.workspace-navigation').evaluate("el => {const rects=[...el.children].map(child => child.getBoundingClientRect()); return rects.length === 4 && rects.every(r => Math.abs((r.top+r.bottom)/2 - (rects[0].top+rects[0].bottom)/2) <= 1);}")
            if width > 1100:
                sidebar_width = await page.locator('.sidebar').evaluate('el => el.getBoundingClientRect().width')
                assert sidebar_width <= min(520, width * .3) + 1
                header_height = await page.locator('.topbar').evaluate('el => el.getBoundingClientRect().height')
                assert header_height <= 70, (width, header_height)
            menus = {
                'Buddy menu': ['Memory & presets', 'New chat', 'Export & share', 'Compare documents', 'Artifact editor'],
                'Settings menu': ['My access', 'User groups & administrators', 'Connected services', 'Add connections', 'Add agents', 'Mods'],
            }
            panel_ids = []
            for menu_name, labels in menus.items():
                trigger = page.get_by_role('button', name=menu_name, exact=True)
                await trigger.click()
                panel = page.get_by_role('dialog', name=menu_name, exact=True)
                panel_ids.append(await panel.get_attribute('id'))
                assert await trigger.get_attribute('aria-controls') == panel_ids[-1]
                assert await panel.evaluate("el => {const r=el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && el.scrollWidth <= el.clientWidth;}")
                for label in labels:
                    assert await panel.get_by_role('button', name=label, exact=True).count() == 1, (width, menu_name, label)
                if menu_name == 'Buddy menu':
                    assert await panel.get_by_role('button', name='Export & share', exact=True).is_disabled()
                    assert await panel.get_by_role('combobox', name='Assistant preset', exact=True).count() == 1
                    await panel.get_by_role('combobox', name='Approval policy').select_option('selected')
                    last = panel.get_by_role('button', name='How approvals work', exact=True)
                    await last.scroll_into_view_if_needed()
                    assert await last.evaluate("el => {const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1;}")
                if menu_name == 'Settings menu':
                    assert await panel.get_by_role('heading', name='Account', exact=True).count() == 1
                    assert await page.locator('.workspace-toolbar-language').get_by_role('combobox').count() == 1
                await page.keyboard.press('Escape')
                assert await trigger.evaluate('el => el === document.activeElement')
                assert await panel.count() == 0
                await trigger.click()
                await page.locator('.topbar-heading').click()
                assert await panel.count() == 0
            assert len(set(panel_ids)) == 2
            # Switching menus leaves exactly one panel open.
            await page.get_by_role('button', name='Buddy menu', exact=True).click()
            await page.get_by_role('button', name='Settings menu', exact=True).click()
            assert await page.locator('.workspace-tools-panel').count() == 1
            await page.keyboard.press('Escape')
            if width <= 1100:
                menu = page.locator('.mobile-menu')
                await menu.click()
                await page.wait_for_timeout(250)
                assert await menu.get_attribute('aria-expanded') == 'true'
                sidebar = await page.locator('.sidebar').bounding_box()
                assert sidebar['width'] <= width - 56 + 1
                mods = page.locator('.sidebar-mod-button')
                await mods.scroll_into_view_if_needed()
                assert await mods.evaluate('el => { const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }')
                assert await page.locator('.sidebar-mod-button').evaluate("el => { const [label,badge]=el.children; return label.getBoundingClientRect().right <= badge.getBoundingClientRect().left; }")
                await page.keyboard.press('Escape')
                assert await menu.get_attribute('aria-expanded') == 'false'
                await menu.click()
                await page.locator('.sidebar-backdrop').click(position={'x': width - 10, 'y': 10})
                assert await menu.get_attribute('aria-expanded') == 'false'
            print(f'PASS {width}x{height}: header fits, controls do not overlap, composer and navigation usable')
        await page.set_viewport_size({'width': 1920, 'height': 1080})
        await page.get_by_role('button', name='Settings menu', exact=True).click()
        density = page.get_by_role('combobox', name='Display density', exact=True)
        await density.select_option('comfortable')
        await page.keyboard.press('Escape')
        comfortable_height = await page.locator('.topbar').evaluate('el => el.getBoundingClientRect().height')
        await page.reload()
        await page.locator('.workspace-navigation').wait_for()
        assert await page.evaluate("document.documentElement.dataset.uiDensity") == 'comfortable'
        await page.get_by_role('button', name='Settings menu', exact=True).click()
        await page.get_by_role('combobox', name='Display density', exact=True).select_option('compact')
        await page.keyboard.press('Escape')
        compact_height = await page.locator('.topbar').evaluate('el => el.getBoundingClientRect().height')
        assert compact_height < comfortable_height
        print('PASS density preference persists and compact layout gives chat more height')
        for scale in ['75', '85', '100']:
            await page.get_by_role('button', name='Settings menu', exact=True).click()
            await page.get_by_role('combobox', name='Display scale', exact=True).select_option(scale)
            await page.keyboard.press('Escape')
            dimensions = await page.locator('.shell').bounding_box()
            assert abs(dimensions['width'] - 1920) <= 2 and abs(dimensions['height'] - 1080) <= 2, (scale, dimensions)
            await page.get_by_role('button', name='Buddy menu', exact=True).click()
            assert await page.get_by_role('dialog', name='Buddy menu', exact=True).evaluate('el => {const r=el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;}')
            await page.keyboard.press('Escape')
        await page.reload()
        await page.locator('.workspace-navigation').wait_for()
        assert await page.evaluate('document.documentElement.dataset.uiScale') == 'auto'
        assert await page.evaluate("Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'))") == 1
        print('PASS manual scales fill the screen and keep settings accessible; reload restores automatic scaling')
        await browser.close()

asyncio.run(main())
