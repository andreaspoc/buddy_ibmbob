"""Browser smoke using intercepted, explicitly synthetic UI fixtures only."""
import asyncio
import json
import os
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

SESSION = 'a' * 32
DECK = '<!DOCTYPE html><html><head><style>.slide{width:1280px;height:720px;background:white;color:#222;padding:40px}</style></head><body><section class="slide"><h1>Unchanged fixture heading</h1><p>Unchanged fixture content used to verify presentation controls and preserve the original document.</p></section></body></html>'


def verify_backend():
    from app.main import StreamRequest, app
    from app.research import ResearchSpec
    from app.workflows import WorkflowSpec
    from app.response_language import language_instruction
    from app import job_queue
    from app.tasks import list_tasks
    assert StreamRequest(prompt='Synthetic language validation', ui_language='el').ui_language == 'el'
    assert ResearchSpec(topic='Synthetic language validation', ui_language='el').ui_language == 'el'
    assert WorkflowSpec(name='Synthetic language validation', prompt='Synthetic request', ui_language='el').ui_language == 'el'
    assert 'research reports, report headings' in language_instruction('el')
    assert any(getattr(route, 'path', None) == '/mcps/{name}' and 'PUT' in (getattr(route, 'methods', set()) or set()) for route in app.routes)
    with job_queue._connect() as database:
        owners = database.execute('SELECT DISTINCT username FROM bob_jobs').fetchall()
        active = database.execute("SELECT count(*) AS count FROM bob_jobs WHERE status IN ('queued','running')").fetchone()['count']
    recovered, missing = 0, 0
    for owner in owners:
        for task in list_tasks(owner['username']):
            if task['status'] in {'completed', 'failed', 'stopped'}:
                if task.get('tokens') is None:
                    missing += 1
                else:
                    recovered += 1
    print(json.dumps({'backendLanguageModels': True, 'mcpUpdateRoute': True, 'historicalTasksWithReportedUsage': recovered, 'historicalTasksWithoutRecoverableUsage': missing, 'activeTasks': active}), flush=True)


async def main():
    errors, requests, routes = [], [], []
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 1050})
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen'); localStorage.setItem('bob_sidebar_collapsed',JSON.stringify({mcps:false,skills:true,microsoft:true,agents:true}));")

        async def route_request(route):
            request = route.request
            path = urlsplit(request.url).path
            routes.append(path)
            if path == '/' or path.startswith('/assets/') or path.endswith(('.png', '.svg', '.ico')):
                await route.continue_()
                return
            data = []
            if path == '/auth/status':
                data = {'user': {'username': 'fixture-user', 'display_name': 'Fixture User', 'is_admin': True}}
            elif path == '/personalization/tutorials':
                data = {'disabled': True}
            elif path == '/sessions':
                data = {'id': SESSION} if request.method == 'POST' else [{'id': SESSION, 'title': 'Unchanged fixture conversation', 'updated_at': 1}]
            elif path == '/mcps':
                data = [{'name': 'fixture_service', 'transport': 'http', 'target': 'https://example.invalid/mcp', 'can_manage': True}]
            elif path == '/mcps/fixture_service/config':
                data = {'httpURL': 'https://example.invalid/mcp', 'headers': {'Authorization': 'Bearer fixture-only-secret'}}
            elif path == '/mcps/fixture_service' and request.method == 'PUT':
                requests.append(request.post_data_json)
                data = {'name': 'fixture_service'}
            elif path.endswith('/check'):
                data = {'status': 'working', 'message': 'Fixture connection check', 'tools': []}
            elif path == '/workspace/pages':
                data = [{'name': 'fixture.html', 'path': 'fixture.html', 'size': len(DECK), 'is_presentation': True}]
            elif path == '/workspace/page':
                data = {'html': DECK}
            elif path.endswith('/file'):
                await route.fulfill(status=200, content_type='text/html', body=DECK)
                return
            elif path.endswith('/artifacts/source'):
                data = {'content': DECK, 'sha256': 'fixture-version', 'path': 'fixture.html'}
            elif path.endswith('/history'):
                data = [{'type': 'request', 'prompt': 'Unchanged original user request', 'mode': 'agent'}, {'type': 'delta', 'text': 'Unchanged saved answer'}, {'type': 'done', 'tokens': 1234, 'cost': .1}]
            elif path in ('/research/capabilities', '/workflows/capabilities'):
                data = {'web_search': True}
            elif path == '/research' and request.method == 'POST':
                requests.append(request.post_data_json)
                data = {'session_id': 'b' * 32, 'job_id': 'fixture-research'}
            elif path == '/research/' + 'b' * 32:
                data = {'title': 'Συνθετική δοκιμή αναφοράς', 'status': 'completed', 'report': '# Σύνοψη\nΣυνθετικό περιεχόμενο δοκιμής.', 'evidence': [], 'usage': {'tokens': None, 'bobcoins': None, 'phases': []}}
            elif path.startswith('/auth/microsoft'):
                data = {'configured': False, 'connected': False}
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(data))

        await page.route('**/*', route_request)
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL', 'http://127.0.0.1:8080'))
        await page.get_by_role('combobox', name='Language', exact=True).select_option('el')
        await page.get_by_role('button', name='Αναφορές έρευνας', exact=True).wait_for()
        assert await page.locator('html').get_attribute('lang') == 'el'
        assert await page.locator('.sidebar').count() == 1
        await page.get_by_role('button', name='Συνδέσεις MCP', exact=True).click()
        await page.get_by_role('button', name='Ρύθμιση fixture_service', exact=True).first.click()
        await page.locator('input[readonly]').wait_for()
        assert await page.locator('input[readonly]').input_value() == 'fixture_service'
        assert await page.locator('textarea').filter(has_text='fixture-only-secret').count() >= 1
        await page.get_by_role('button', name='Αποθήκευση αλλαγών', exact=True).click()
        assert requests[-1]['headers']['Authorization'] == 'Bearer fixture-only-secret'
        await page.get_by_role('button', name='Ολοκληρώθηκε', exact=True).click()
        await page.locator('.mcp-manager .feature-close').click()
        await page.get_by_role('button', name='Unchanged fixture conversation', exact=True).click()
        await page.get_by_text('Unchanged saved answer', exact=True).wait_for()
        pill_text = await page.locator('#token-pill').inner_text()
        assert any(value in pill_text for value in ('1.2k', '1,2'))
        await page.get_by_role('button', name='Στούντιο παρουσιάσεων', exact=True).click()
        select_objects = page.get_by_role('button', name='Επιλογή αντικειμένων', exact=True)
        try:
            await select_objects.wait_for(timeout=10000)
        except Exception:
            print('Fixture UI diagnostics:', await page.locator('body').inner_text(), 'errors:', errors, 'routes:', routes[-20:], 'fixture length:', len(DECK), flush=True)
            raise
        assert await select_objects.evaluate('(el) => getComputedStyle(el).borderRadius') == '8px'
        await select_objects.click()
        assert await select_objects.get_attribute('aria-pressed') == 'true'
        await page.get_by_role('button', name='Αίτημα αλλαγών', exact=True).click()
        change_form = page.locator('.artifact-change-form')
        await change_form.wait_for()
        assert await change_form.evaluate('(el) => getComputedStyle(el).backgroundColor') == 'rgb(27, 16, 44)'
        assert await page.locator('iframe').first.content_frame.get_by_text('Unchanged fixture heading').count() == 1
        await page.locator('.artifact-change-actions button[type=button]').click()
        await page.get_by_role('button', name='Αναφορές έρευνας', exact=True).click()
        await page.locator('.research-dialog textarea').fill('Συνθετική δοκιμή έρευνας για τη γλώσσα της αναφοράς')
        await page.locator('.research-dialog .feature-primary').click()
        await page.get_by_text('Συνθετικό περιεχόμενο δοκιμής.', exact=True).wait_for()
        assert requests[-1]['ui_language'] == 'el'
        await page.reload()
        assert await page.locator('html').get_attribute('lang') == 'el'
        await page.get_by_role('combobox', name='Γλώσσα', exact=True).select_option('en')
        await page.get_by_role('button', name='Research reports', exact=True).wait_for()
        assert await page.locator('html').get_attribute('lang') == 'en'
        assert not errors, errors
        print(json.dumps({'languageSwitch': True, 'persistedLanguage': True, 'contentPreserved': True, 'configuredMcp': True, 'studioControlsStyled': True, 'greekResearchRequest': True}))
        await browser.close()


if __name__ == '__main__':
    verify_backend()
    asyncio.run(main())
