"""Synthetic account and notes only: explicit sharing and recipient privacy."""
import asyncio
import json
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':900})
        await page.add_init_script("sessionStorage.setItem('buddy-welcome-v1:sharing-fixture','seen')")
        shares, creations, errors = [], [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        async def route(r):
            path, method = urlsplit(r.request.url).path, r.request.method
            if path in ('/','/notes','/notes/') or path.startswith(('/assets/','/static/')):
                await r.continue_(); return
            data = []
            if path == '/auth/status': data = {'user':{'username':'sharing-fixture','display_name':'Alice Fixture','is_admin':False}}
            elif path == '/personalization/tutorials': data = {'disabled':True}
            elif path == '/api/notes': data = {'items':[{'id':91,'title':'Selected note fixture','body':'Only selected content','color':'yellow','sources':[],'created_at':'2026-10-16T10:00:00Z'}],'next_before_id':None}
            elif path == '/api/community/rooms':
                if method == 'POST':
                    creations.append(json.loads(r.request.post_data))
                    data = {'id':47,'name':'Bob Fixture','kind':'direct','subscribed':True}
                else: data = [{'id':8,'name':'Fixture team','kind':'channel','subscribed':True,'visibility':'private','unread_count':0},{'id':9,'name':'Unjoined fixture channel','kind':'channel','subscribed':False,'unread_count':0}]
            elif path == '/api/community/members': data = [{'username':'kc-bob-fixture-123','display_name':'Bob Fixture'}]
            elif path.endswith('/share'):
                shares.append((path,json.loads(r.request.post_data))); data = {'id':100}
            elif path.startswith('/auth/microsoft'): data = {'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*', route)
        await page.goto('http://127.0.0.1:8080/notes')
        await page.locator('[data-note-id="91"]').get_by_role('button',name='Share to people').click()
        dialog = page.get_by_role('dialog',name='Share to people',exact=True)
        await expect(dialog).to_be_visible()
        await expect(dialog).to_contain_text('Selected note fixture')
        await expect(dialog).not_to_contain_text('Unjoined fixture channel')
        await expect(dialog).not_to_contain_text('kc-bob-fixture-123')
        await expect(dialog.get_by_role('button',name='Share copy',exact=True)).to_be_disabled()
        await dialog.get_by_role('button',name='Bob Fixture Private message').click()
        assert not shares and not creations, 'Selecting a person must not create a chat or share content'
        await dialog.get_by_role('button',name='Cancel',exact=True).click()
        assert not shares and not creations
        await page.locator('[data-note-id="91"]').get_by_role('button',name='Share to people').click()
        await dialog.get_by_role('button',name='Bob Fixture Private message').click()
        await dialog.get_by_role('button',name='Share copy',exact=True).click()
        await expect(page.get_by_role('dialog',name='Item shared')).to_be_visible()
        assert creations == [{'kind':'direct','peer':'kc-bob-fixture-123'}]
        assert shares == [('/api/community/rooms/47/share',{'kind':'note','note_id':91,'title':'Selected note fixture'})]
        await page.get_by_role('button',name='Done',exact=True).click()
        await page.set_viewport_size({'width':390,'height':844})
        await page.locator('[data-note-id="91"]').get_by_role('button',name='Share to people').click()
        await expect(dialog).to_be_visible()
        await dialog.get_by_role('button',name='Fixture team Private group').click()
        assert len(shares) == 1
        box = await dialog.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= 391
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        assert not errors, errors
        print('People sharing: explicit consent, cancel, selected note only, exact private recipient, joined channels only, display names, mobile dialog and Escape passed')
        await browser.close()

asyncio.run(main())
