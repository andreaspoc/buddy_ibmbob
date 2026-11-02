"""Synthetic fixtures: command menu visibility and independent skill loading."""
import asyncio
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        async def route(r):
            path=urlsplit(r.request.url).path
            if path=='/' or path.startswith(('/assets/','/static/')):
                await r.continue_();return
            data=[]
            if path=='/auth/status':data={'user':{'username':'slash-fixture','display_name':'Slash Fixture','is_admin':False}}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/skills':data=[{'name':'analysis-buddy','description':'Analyze fixture documents'},{'name':'writing-buddy','description':'Write fixture content'}]
            elif path=='/projects':
                await r.abort();return  # Unrelated request failure must not hide skills.
            elif path.startswith('/auth/microsoft'):data={'configured':False,'connected':False}
            await r.fulfill(json=data)
        await page.route('**/*',route)
        await page.add_init_script("sessionStorage.setItem('buddy-welcome-v1:slash-fixture','seen')")
        await page.goto('http://127.0.0.1:8080')
        composer=page.locator('.composer-row textarea')
        for width,height in [(1280,900),(390,844)]:
            await page.set_viewport_size({'width':width,'height':height})
            await composer.fill('/')
            menu=page.locator('#skill-command-menu')
            await expect(menu).to_be_visible()
            skill=menu.get_by_role('button',name='Analysis Buddy',exact=False)
            await expect(skill).to_be_visible()
            await skill.click(trial=True)  # Wait for responsive layout and hit testing to settle.
            assert await skill.evaluate('''el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'''), 'Skill picker clipped or covered'
            await skill.click()
            await expect(composer).to_have_value('/analysis-buddy ')
            await expect(menu).to_have_count(0)
            await composer.fill('')
            await page.locator('.slash-button').click()
            await expect(menu.get_by_role('button',name='Writing Buddy',exact=False)).to_be_visible()
            await page.keyboard.press('Escape')
            await expect(menu).to_have_count(0)
        assert not errors,errors
        print('PASS: typing /, skill selection, slash button, Escape, desktop/mobile hit testing, and skills available despite failed project catalog')
        await browser.close()
asyncio.run(main())
