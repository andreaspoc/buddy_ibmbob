"""Browser regression for a synthetic Apps fixture; no production user data."""
import asyncio
import os
from playwright.async_api import async_playwright, expect


async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('BUDDY_APPS_FIXTURE_URL', 'http://127.0.0.1:5179/tests/apps.html'))
        await page.locator('#launch').click()
        dialog = page.get_by_role('dialog')
        await expect(dialog.get_by_role('button', name='Notes', exact=False)).to_be_visible()
        await expect(dialog.get_by_text('No additional apps available')).to_be_visible()
        # Simulate installing while the view is already open.
        await page.evaluate("document.querySelector('#install').click()")
        await expect(dialog.get_by_role('button', name='Office Suite', exact=False)).to_be_visible()
        link = dialog.get_by_role('link', name='Fixture portal', exact=False)
        await expect(link).to_have_attribute('target', '_blank')
        await expect(link).to_have_attribute('rel', 'noopener noreferrer')
        await page.screenshot(path='/tmp/buddy-apps-desktop.png')
        await dialog.get_by_role('searchbox').fill('Office')
        await expect(dialog.locator('.installed-app-card')).to_have_count(1)
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        await expect(page.locator('#launch')).to_be_focused()
        await page.locator('#launch').click()
        await page.get_by_role('button', name='Notes', exact=False).click()
        await expect(page.locator('#last')).to_have_text('notes')
        await expect(page.get_by_role('dialog')).to_have_count(0)
        await page.set_viewport_size({'width':390, 'height':844})
        await page.locator('#device').click()
        await page.locator('#launch').click()
        await expect(page.get_by_role('button', name='Office Suite', exact=False)).to_have_count(0)
        await expect(page.get_by_role('button', name='Member chat', exact=False)).to_be_visible()
        await page.screenshot(path='/tmp/buddy-apps-mobile.png')
        assert await page.get_by_role('dialog').evaluate('(element) => element.getBoundingClientRect().right <= innerWidth && element.getBoundingClientRect().left >= 0')
        await page.keyboard.press('Escape')
        for language, title in [('el', 'Εφαρμογές'), ('hi', 'ऐप्स'), ('mt', 'Applikazzjonijiet')]:
            await page.get_by_label('Fixture language').select_option(language)
            await page.locator('#launch').click()
            await expect(page.get_by_role('dialog').get_by_role('heading', name=title, exact=True)).to_be_visible()
            await page.keyboard.press('Escape')
        assert not errors, errors
        print('PASS: core-only, runtime registration, search, existing launch handlers, keyboard/focus, mobile Office exclusion, safe external links and Greek/Hindi/Maltese labels')
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
