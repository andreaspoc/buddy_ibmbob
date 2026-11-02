"""Header stress checks with synthetic usage and all optional controls enabled."""
import asyncio
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for language in ('en', 'el', 'hi', 'mt'):
            page = await browser.new_page()
            await page.add_init_script(f"localStorage.setItem('bob-ui-language', '{language}')")
            await page.goto(os.getenv('TOPBAR_FIXTURE_URL', 'http://127.0.0.1:3004/topbar_fixture.html'))
            await page.locator('.topbar-token-pill').wait_for(state='attached')
            for width, height in [(320,568),(375,667),(390,844),(667,375),(768,1024),(1024,768),(1280,800),(1920,1080),(2560,1440)]:
                await page.set_viewport_size({'width': width, 'height': height})
                await page.wait_for_timeout(100)
                issue = await page.evaluate('''() => {
                    const header = document.querySelector('.topbar').getBoundingClientRect();
                    const nodes = [...document.querySelectorAll('.topbar-heading,.topbar-actions > *,.workspace-navigation')];
                    const overlap = rects => rects.some((a,i) => rects.slice(i+1).some(b => a.left < b.right-1 && a.right > b.left+1 && a.top < b.bottom-1 && a.bottom > b.top+1));
                    const rects = nodes.map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
                    return {
                        overflow: document.documentElement.scrollWidth * (Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1) > innerWidth + 1,
                        overlap: overlap(rects),
                        outside: rects.some(r => r.left < header.left-1 || r.right > header.right+1 || r.bottom > header.bottom+1),
                        contentsOverlap: nodes.some(el => overlap([...el.children].map(child => child.getBoundingClientRect()).filter(r => r.width && r.height))),
                        navigationWrapped: (() => {const buttons=[...document.querySelectorAll('.workspace-menu-trigger')].map(el => el.getBoundingClientRect());return buttons.some(r => Math.abs((r.top+r.bottom)/2-(buttons[0].top+buttons[0].bottom)/2)>1);})()
                    };
                }''')
                assert not any(issue.values()), (language, width, height, issue)
            await page.close()
            print(f'PASS {language}: brand, navigation, mode and task usage fit nine screen sizes')
        await browser.close()

asyncio.run(main())
