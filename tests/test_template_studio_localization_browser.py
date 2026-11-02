"""Template Studio language switching with synthetic template data."""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1280, 'height': 1000}, accept_downloads=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('TEMPLATE_STUDIO_FIXTURE_URL', 'http://127.0.0.1:3004/template_studio_fixture.html'))
        await page.get_by_role('heading', name='Create a reusable template', exact=True).wait_for()
        english_text = await page.locator('.presentation-modal-card').evaluate('''el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const text=[]; let node;
            while(node=walker.nextNode()) {
                if(node.parentElement.closest('svg') || !node.textContent.trim()) continue;
                const value=node.textContent.trim();
                if(!['×','Calibri','Arial','Aptos','Georgia','Synthetic starter'].includes(value)) text.push(value);
            }
            return [...new Set(text)];
        }''')
        async def translated(key):
            return await page.evaluate('key => window.translateTemplateText(key)', key)
        for language in ('hi', 'el', 'en'):
            await page.evaluate('language => window.setTemplateLanguage(language)', language)
            title = await translated('Create a reusable template')
            await page.get_by_role('heading', name=title, exact=True).wait_for()
            await page.get_by_role('button', name=await translated('Save template'), exact=True).wait_for()
            if language != 'en':
                assert title != 'Create a reusable template'
                remaining = await page.locator('.presentation-modal-card').evaluate('''(el, phrases) => {
                    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const found=[];let node;
                    while(node=walker.nextNode()) if(!node.parentElement.closest('svg') && phrases.includes(node.textContent.trim())) found.push(node.textContent.trim());
                    return found;
                }''', english_text)
                assert not remaining, (language, remaining)
            assert await page.get_by_label(await translated('Template name'), exact=True).input_value() == await translated('My presentation template')
            assert await page.get_by_label(await translated('Brand'), exact=True).input_value() == await translated('My brand')
            # Label, placeholder, option and preview translations update immediately.
            describe = page.get_by_label(await translated('Describe your template'), exact=True)
            assert await describe.get_attribute('placeholder') == await translated('For example: a minimal blue and gold template with rounded cards')
            shape = page.get_by_label(await translated('Card shape'), exact=True)
            assert await shape.locator('option[value=roundedRectangle]').inner_text() == await translated('Rounded rectangle')
            await page.get_by_label(await translated('Chart style'), exact=True).select_option('bar')
            await page.get_by_role('tab', name=await translated('Chart slide'), exact=True).click()
            await page.wait_for_function('document.querySelector(".template-studio-slide").textContent.includes(window.translateTemplateText("Sample chart"))')
            for width in (1280,390,320):
                await page.set_viewport_size({'width':width,'height':1000})
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language,width)
            if language != 'en':
                # Generated HTML carries the chosen language, UI navigation and sample text.
                async with page.expect_download() as pending:
                    await page.get_by_role('button', name=await translated('Download HTML'), exact=True).click()
                download = await pending.value
                output = Path(f'/tmp/template-studio-{language}.html')
                await download.save_as(str(output))
                content = output.read_text()
                assert f'<html lang="{language}">' in content
                assert await translated('Previous') in content
                assert await translated('Sample chart') in content
            print(f'PASS {language}: headings, descriptions, buttons, labels, options, previews, exports and three widths')
        # Even deliberately typed text matching a default is user content.
        await page.get_by_label('Template name', exact=True).fill('')
        await page.get_by_label('Template name', exact=True).fill('My presentation template')
        await page.evaluate("window.setTemplateLanguage('hi')")
        assert await page.get_by_label(await translated('Template name'), exact=True).input_value() == 'My presentation template'
        await page.evaluate("window.setTemplateLanguage('en')")
        # User-entered content stays intact during a language change.
        await page.get_by_label('Template name', exact=True).fill('My own English template name')
        await page.get_by_label('Brand', exact=True).fill('My own brand')
        await page.get_by_label('Describe your template', exact=True).fill('My own English brief')
        await page.evaluate("window.setTemplateLanguage('hi')")
        assert await page.get_by_label(await translated('Template name'), exact=True).input_value() == 'My own English template name'
        assert await page.get_by_label(await translated('Brand'), exact=True).input_value() == 'My own brand'
        assert await page.get_by_label(await translated('Describe your template'), exact=True).input_value() == 'My own English brief'
        # Known local errors/loading messages also translate while open.
        await page.evaluate('window.fixtureState.failDrafts=true; window.fixtureState.draftDelay=1500')
        await page.get_by_role('button', name=await translated('Refresh drafts'), exact=True).click()
        await page.get_by_role('status').wait_for()
        assert await page.get_by_role('status').inner_text() == await translated('Loading Bob drafts…')
        await page.get_by_role('alert').wait_for()
        assert await page.get_by_role('alert').inner_text() == await translated('Could not load Bob drafts. Please try again.')
        await page.evaluate("window.setTemplateLanguage('el')")
        assert await page.get_by_role('alert').inner_text() == await translated('Could not load Bob drafts. Please try again.')
        assert not errors, errors
        await browser.close()
        print('PASS: switching languages preserves template edits and translates existing error messages')

asyncio.run(main())
