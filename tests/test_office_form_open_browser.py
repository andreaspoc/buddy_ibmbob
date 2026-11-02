"""Synthetic sidebar form creation: saved PDFs open only after a successful save."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

async def main():
    base = os.getenv('OFFICE_FORM_UI_URL', 'http://127.0.0.1:3020')
    file_id = '12345678-1234-4123-8123-123456789abc'
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--unsafely-treat-insecure-origin-as-secure=' + base])
        page = await browser.new_page()
        async def draft(route):
            plan = {'version': 1, 'kind': 'word', 'reply': 'Review this synthetic form.', 'actions': [], 'create_form': {
                'name': 'Synthetic leads', 'title': 'Synthetic leads', 'fields': [
                    {'name': 'status', 'label': 'Lead status', 'type': 'dropdown', 'options': ['New', 'Contacted']}]}}
            await route.fulfill(content_type='application/x-ndjson', body=json.dumps({'type': 'plan', 'plan': plan}) + '\n')
        await page.route('**/api/office/assistant/files/synthetic-only/draft', draft)
        await page.goto(base + '/tests/office-message-deletion.html')
        await page.evaluate("window.formNavigationCount=0;window.addEventListener('buddy-office-navigation',()=>window.formNavigationCount++)")
        await page.get_by_label('Instructions for Buddy').fill('Create a synthetic lead form')
        await page.get_by_role('button', name='Send to Buddy', exact=True).click()
        await page.get_by_role('button', name='Create form', exact=True).wait_for()
        assert await page.evaluate('window.formNavigationCount') == 0
        async def fail(route):
            await route.fulfill(status=503, content_type='application/json', body='{"detail":"Synthetic save failure"}')
        await page.route('**/api/office/assistant/files/synthetic-only/create-form', fail)
        await page.get_by_role('button', name='Create form', exact=True).click()
        await page.get_by_role('alert').filter(has_text='Synthetic save failure').wait_for()
        assert await page.evaluate('window.formNavigationCount') == 0
        await page.unroute('**/api/office/assistant/files/synthetic-only/create-form', fail)
        async def save(route):
            assert route.request.post_data_json['fields'][0]['type'] == 'dropdown'
            await route.fulfill(content_type='application/json', body=json.dumps({'id': file_id, 'name': 'Synthetic leads.pdf'}))
        await page.route('**/api/office/assistant/files/synthetic-only/create-form', save)
        await page.get_by_role('button', name='Create form', exact=True).click()
        await page.wait_for_function("id => location.pathname === '/office/files/' + id", arg=file_id)
        assert await page.evaluate('window.formNavigationCount') == 1
        print('PASS: preview stays put, failed save stays put, successful creation opens the saved PDF route.')
        await browser.close()

asyncio.run(main())
