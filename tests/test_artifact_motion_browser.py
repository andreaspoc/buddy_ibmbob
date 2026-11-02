"""Native dashboard motion: one-time reveals, stable layout and reduced motion."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    source = Path('/opt/bob-a2a/app/artifact_motion_runtime.js').read_text()
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':900, 'height':700})
        for reduced in ['no-preference', 'reduce']:
            await page.emulate_media(reduced_motion=reduced)
            await page.goto('about:blank')
            await page.set_content('<section id="first" data-bob-reveal style="height:200px">Source content</section><section id="next">Following content</section><button data-bob-interactive>Explore</button>')
            await page.evaluate('''() => {
                window.reveals = 0;
                const animate = Element.prototype.animate;
                Element.prototype.animate = function(...args) { window.reveals++; return animate.apply(this,args); };
            }''')
            before = await page.locator('#next').bounding_box()
            await page.add_script_tag(content=source)
            await page.wait_for_timeout(450)
            assert await page.evaluate('window.reveals') == (1 if reduced == 'no-preference' else 0)
            assert await page.locator('#next').bounding_box() == before, 'Reveal moved surrounding content'
            await page.evaluate('BobMotion.scan(); BobMotion.scan(); document.querySelector("#first").append("Updated source");')
            await page.wait_for_timeout(100)
            assert await page.evaluate('window.reveals') == (1 if reduced == 'no-preference' else 0), 'Reveal replayed during updates'
        await browser.close()
        print('PASS: one-time section reveal, stable surrounding layout, no repeat on updates and reduced motion')

asyncio.run(main())
