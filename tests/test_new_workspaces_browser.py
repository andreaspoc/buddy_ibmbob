"""New workspace UI using explicitly synthetic intercepted API responses only.

No connector calls or account mutations reach the live application. CSV/Excel
fixtures are synthetic and deterministic; underlying parsing is tested separately.
"""
import asyncio
import csv
import io
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright
from app.productivity import CsvInput, explore_csv, import_xlsx

SID = 'a' * 32
BRANCH = 'b' * 32
PID = 'fixture-project'

async def main():
    admin = True
    writes, chat_requests, errors = [], [], []
    sessions = [{'id': SID, 'title': 'Synthetic workspace chat', 'updated_at': 1}, {'id': BRANCH, 'title': 'Synthetic branch', 'updated_at': 2}]
    history = {SID: [{'type': 'request', 'prompt': 'Synthetic initial question', 'mode': 'agent'}, {'type': 'delta', 'text': 'Synthetic completed answer.'}, {'type': 'done'}], BRANCH: [{'type': 'request', 'prompt': 'Synthetic initial question', 'mode': 'agent'}, {'type': 'delta', 'text': 'Synthetic branch answer.'}, {'type': 'done'}]}
    memory = {'brief': 'Synthetic existing project brief', 'revision': 1}
    recipes = []
    task = {'id': 'fixture-task', 'session_id': SID, 'title': 'Synthetic completed task', 'kind': 'chat', 'mode': 'agent', 'status': 'completed', 'progress': 'Synthetic fixture completion', 'created_at': '2026-10-01T10:00:00Z', 'updated_at': '2026-10-01T10:01:00Z', 'result': 'Synthetic task result.', 'steps': []}
    notices = [{'id': 'job:fixture-task', 'kind': 'task', 'title': task['title'], 'status': 'completed', 'occurred_at': task['updated_at'], 'read_at': None, 'job_id': task['id'], 'session_id': SID}]
    template = {'id': 'fixture-tool', 'name': 'Synthetic Tool', 'description': 'Synthetic MCP fixture', 'icon': 'cloud', 'transport': 'http', 'url': 'https://example.invalid/mcp', 'command': '', 'args': [], 'fields': [{'key': 'token', 'label': 'Synthetic API token', 'location': 'header', 'target': 'Authorization', 'prefix': 'Bearer ', 'required': True}], 'knowledge_base': 'company', 'audience': 'both', 'access_mode': 'groups', 'users': [], 'enabled': True, 'allowed': True, 'connected': False}
    blocked_template = {**template, 'id': 'blocked-tool', 'name': 'Synthetic Blocked Tool', 'enabled': False, 'allowed': False}
    agents = [{'id': 'fixture-agent', 'slug': 'catalog-fixture-agent', 'name': 'Synthetic A2A Agent', 'description': 'Synthetic Agent Card fixture', 'icon': '↗', 'card_url': 'https://example.invalid/agent-card.json', 'endpoint': 'https://example.invalid/a2a', 'protocol_version': '0.3', 'api_key_header': 'x-api-key', 'capabilities': {'streaming': True}, 'skills': [{'id': 'fixture-skill', 'name': 'Synthetic research skill', 'description': 'Synthetic advertised skill'}], 'groups': ['buddy'], 'users': [], 'enabled': True, 'allowed': True, 'activated': False}]
    csv_text = 'region,value\nNorth,2\nNorth,4\nSouth,9\n=1+1,6\n'
    import openpyxl
    book = openpyxl.Workbook(); book.active.title = 'First'; book.active.append(['metric']); book.active.append([3]); second = book.create_sheet('Second'); second.append(['metric']); second.append([7]); stream = io.BytesIO(); book.save(stream); book.close(); xlsx_bytes = stream.getvalue()

    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width': int(os.getenv('WORKSPACE_TEST_WIDTH', '1440')), 'height': int(os.getenv('WORKSPACE_TEST_HEIGHT', '1050'))}, has_touch=os.getenv('WORKSPACE_TEST_TOUCH') == '1', accept_downloads=True)
        page.set_default_timeout(15000)
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.on('console', lambda msg: errors.append('console: ' + msg.text) if msg.type == 'error' else None)
        await page.add_init_script("sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');localStorage.setItem('bob-ui-language','en');")

        async def route_request(route):
            nonlocal memory, template, recipes, admin
            req = route.request; parsed = urlsplit(req.url); path = parsed.path; query = parse_qs(parsed.query)
            if path == '/' or path.startswith('/assets/') or path.endswith(('.svg', '.png', '.ico', '.woff2')):
                await route.continue_(); return
            method = req.method
            body = req.post_data_json if method not in ('GET', 'HEAD') and req.headers.get('content-type', '').startswith('application/json') else None
            if method not in ('GET', 'HEAD'):
                writes.append((method, path, body))
            data = []
            if path == '/auth/status': data = {'user': {'username': 'fixture-user', 'display_name': 'Synthetic User', 'is_admin': admin}, 'keycloak_configured': False, 'local_login_enabled': True}
            elif path == '/api/apps': data = {'apps': [{'id': identity, 'name': label, 'description': 'Synthetic app fixture', 'kind': 'core', 'desktop_only': False, 'launch': {'kind': identity}} for identity, label in [('research', 'Research reports'), ('knowledge', 'Knowledge base'), ('productivity', 'Productivity workspace'), ('workflows', 'Workflows'), ('search', 'Search saved work'), ('presentations', 'Presentations')]]}
            elif path == '/personalization/tutorials': data = {'disabled': True}
            elif path == '/projects': data = [{'id': PID, 'name': 'Synthetic Project', 'is_active': True}]
            elif path == '/sessions':
                if method == 'POST': data = {'id': SID}
                else: data = [session for session in sessions if not query.get('project_id')]
            elif path.endswith('/history'): data = history.get(path.split('/')[2], [])
            elif path == f'/sessions/{SID}/branch': data = {'id': BRANCH}
            elif path == '/modes': data = [{'slug': 'agent', 'name': 'Agent', 'kind': 'built-in'}, {'slug': 'presentation', 'name': 'Presentation', 'kind': 'built-in'}]
            elif path == '/presentation/intent': data = {'presentation': False, 'templates': [], 'format': None, 'slide_count': None, 'html_artifact': False}
            elif path == '/chat/stream':
                chat_requests.append(body)
                sid = body.get('workspace_id') or SID
                history.setdefault(sid, []).extend([{'type': 'request', 'prompt': body['prompt'], 'mode': body.get('mode', 'agent')}, {'type': 'delta', 'text': 'Synthetic completed workspace response.'}, {'type': 'done'}])
                await route.fulfill(status=200, content_type='application/x-ndjson', body='\n'.join(json.dumps(event) for event in [{'type': 'start'}, {'type': 'delta', 'text': 'Synthetic completed workspace response.'}, {'type': 'done', 'session_id': 'synthetic-native'}]) + '\n')
                return
            elif path == '/tasks': data = [task]
            elif path == '/tasks/fixture-task': data = task
            elif path == '/notifications': data = notices
            elif path == '/notifications/read':
                for item in notices:
                    if item['id'] == body['id']: item['read_at'] = '2026-10-01T11:00:00Z'
                data = {'read': True}
            elif path == f'/projects/{PID}/memory':
                if method == 'PUT': memory = {**body, 'revision': body['revision'] + 1}
                data = memory
            elif path == '/productivity/recipes':
                if method == 'POST': recipes.append({**body, 'id': 'fixture-recipe'})
                data = recipes[-1] if method == 'POST' else recipes
            elif path == '/productivity/recipes/fixture-recipe' and method == 'DELETE': recipes = []; data = {'deleted': True}
            elif path == '/productivity/csv/explore': data = explore_csv(CsvInput(**body))
            elif path == '/productivity/spreadsheet/import': data = import_xlsx(xlsx_bytes, query.get('sheet', [None])[0])
            elif path == '/admin/users': data = {'users': [{'username': 'fixture-user', 'display_name': 'Synthetic User', 'is_admin': admin}], 'pending_admins': []}
            elif path == '/mcp-catalog':
                if admin: data = [template, blocked_template]
                else: data = [{key: template[key] for key in ('id', 'name', 'description', 'icon', 'fields', 'allowed', 'connected')}]
            elif path == '/mcp-catalog/fixture-tool' and method == 'PUT': template = {**body, 'allowed': True, 'connected': template['connected']}; data = {'id': template['id']}
            elif path == '/mcp-catalog/fixture-tool/access' and method == 'PUT': template = {**template, **body, 'access_mode': 'grants'}; data = {'id': template['id']}
            elif path == '/mcp-catalog/fixture-tool/connect': template['connected'] = True; data = {'connected': True, 'server_name': 'catalog-fixture-tool'}
            elif path == '/mcp-catalog/fixture-tool/check': data = {'status': 'working', 'message': 'Synthetic fixture check passed', 'tools': ['synthetic_tool']}
            elif path == '/mcp-catalog/fixture-tool/connection' and method == 'DELETE': template['connected'] = False; data = None
            elif path == '/agent-catalog': data = agents
            elif path == '/admin/agent-catalog/fixture-agent' and method == 'PUT': agents[0].update(body); data = agents[0]
            elif path == '/agent-catalog/fixture-agent/activation': agents[0]['activated'] = method != 'DELETE'; data = {'activated': agents[0]['activated']}
            elif path.startswith('/auth/microsoft'): data = {'configured': False, 'connected': False}
            elif path == '/workflows/capabilities': data = {'web_search': False}
            elif method not in ('GET', 'HEAD'):
                errors.append(f'Unexpected write {method} {path}')
                await route.fulfill(status=400, content_type='application/json', body=json.dumps({'detail': 'Unexpected synthetic-fixture request'})); return
            await route.fulfill(status=204 if data is None else 200, content_type='application/json', body='' if data is None else json.dumps(data))

        await page.route('**/*', route_request)
        base = os.getenv('LANGUAGE_PREVIEW_URL', 'http://127.0.0.1:8080')
        async def open_tool(name):
            if name == 'Notifications':
                await page.get_by_role('button', name=name, exact=True).click()
                return
            menu = 'Buddy menu' if name in ('Compare documents', 'Artifact editor', 'Project memory') else 'Settings menu' if name in ('MCP server catalog', 'A2A agent catalog') else 'Apps'
            label = {'MCP server catalog': 'Add connections', 'A2A agent catalog': 'Add agents'}.get(name, name)
            await page.get_by_role('button', name=menu, exact=True).click()
            dialog = page.get_by_role('dialog', name=menu, exact=True)
            if menu == 'Apps':
                await dialog.locator('.installed-app-card').filter(has_text=label).click()
            else:
                await dialog.get_by_role('button', name=label, exact=True).click()
        async def open_mcp():
            await page.get_by_role('button', name='Settings menu', exact=True).click()
            await page.get_by_role('button', name='Connected services', exact=True).click()
            return page.get_by_role('dialog', name='MCP connections', exact=True)
        async def close_dialog(dialog): await dialog.get_by_role('button', name='Close', exact=True).click()
        async def wait_chat(count):
            for _ in range(100):
                if len(chat_requests) >= count: break
                await page.wait_for_timeout(50)
            assert len(chat_requests) == count, {'chat': chat_requests, 'writes': writes, 'body': (await page.locator('body').inner_text())[-7000:], 'errors': errors}
            await page.get_by_role('button', name='Apps', exact=True).wait_for()
            await page.wait_for_timeout(200)

        await page.goto(base + '?conversation=' + SID)
        try:
            await page.get_by_text('Synthetic completed answer.', exact=True).wait_for()
        except Exception:
            print('BOOTSTRAP BODY', (await page.locator('body').inner_text())[:8000], 'ERRORS', errors, flush=True)
            raise
        assert await page.get_by_role('button', name='Apps', exact=True).is_visible()
        # Branch sends the exact turn boundary and navigates to the saved fork.
        await page.get_by_role('button', name='Branch conversation', exact=True).click()
        await page.get_by_text('Synthetic branch answer.', exact=True).wait_for()
        assert ('POST', f'/sessions/{SID}/branch', {'turn_index': 0}) in writes
        assert 'conversation=' + BRANCH in page.url

        await open_tool('Productivity workspace')
        workspace = page.get_by_role('dialog', name='Productivity workspace', exact=True)
        assert 'buddy-surface' in (await workspace.get_attribute('class'))
        # Transcript extraction is a reviewed chat request, never external writes.
        await workspace.get_by_label('Transcript', exact=True).fill('Synthetic meeting: Taylor will review the proposal by 2026-10-20. Decision: retain the current scope.')
        await workspace.get_by_role('button', name='Extract draft in chat', exact=True).click()
        await wait_chat(1)
        assert 'Do not create tasks or send messages.' in chat_requests[-1]['prompt']
        assert 'Synthetic meeting:' in chat_requests[-1]['prompt']
        await open_tool('Productivity workspace')
        await workspace.get_by_label('Reviewed decisions', exact=True).fill('Retain the current scope.')
        await workspace.get_by_label('Action 1', exact=True).fill('Review the proposal')
        await workspace.get_by_label('Owner', exact=True).fill('Taylor')
        await workspace.get_by_label('Due date', exact=True).fill('2026-10-20')
        await workspace.get_by_label('Monday board (optional)', exact=True).fill('Synthetic board')
        await workspace.get_by_label('Email recipients (optional)', exact=True).fill('synthetic@example.invalid')
        await workspace.get_by_role('button', name='Prepare handoff in chat', exact=True).click()
        await wait_chat(2)
        prompt = chat_requests[-1]['prompt']
        expected = [{'action': 'Review the proposal', 'owner': 'Taylor', 'due_date': '2026-10-20'}]
        assert json.dumps(expected, separators=(',', ':')) in prompt.replace(', ', ',').replace(': ', ':')
        assert 'until I explicitly confirm' in prompt and 'Monday board: Synthetic board' in prompt and 'Email recipients: synthetic@example.invalid' in prompt
        assert not any('/monday' in path or '/send' in path for _, path, _ in writes)

        await open_tool('Productivity workspace'); await workspace.get_by_role('button', name='Data explorer', exact=True).click()
        await workspace.get_by_label('Upload spreadsheet', exact=True).set_input_files({'name': 'synthetic-data.csv', 'mimeType': 'text/csv', 'buffer': csv_text.encode()})
        await workspace.get_by_text('synthetic-data.csv: 4 of 4 rows', exact=True).wait_for()
        await workspace.get_by_label('Contains', exact=True).fill('north')
        await workspace.get_by_label('Numeric column', exact=False).select_option('1')
        await workspace.get_by_role('button', name='Apply and calculate', exact=True).click()
        await workspace.get_by_text('synthetic-data.csv: 2 of 4 rows', exact=True).wait_for()
        await workspace.get_by_text('Numeric cells: 2; excluded: 0. Sum: 6; mean: 3; minimum: 2; maximum: 4.', exact=True).wait_for()
        assert await workspace.locator('figure').count() == 1
        async with page.expect_download() as exported:
            await workspace.get_by_role('button', name='Export filtered CSV', exact=True).click()
        file_path = await (await exported.value).path()
        assert list(csv.reader(io.StringIO(Path(file_path).read_text()))) == [['region', 'value'], ['North', '2'], ['North', '4']]
        async with page.expect_download() as provenance:
            await workspace.get_by_role('button', name='Export calculations and provenance', exact=True).click()
        document = json.loads(Path(await (await provenance.value).path()).read_text())
        assert document['stats']['sum'] == 6 and document['provenance']['filter'] == 'north' and 'rows' not in document
        await workspace.get_by_label('Contains', exact=True).fill('')
        await workspace.get_by_role('button', name='Apply and calculate', exact=True).click()
        await workspace.get_by_text('synthetic-data.csv: 4 of 4 rows', exact=True).wait_for()
        async with page.expect_download() as safe_export:
            await workspace.get_by_role('button', name='Export filtered CSV', exact=True).click()
        assert list(csv.reader(io.StringIO(Path(await (await safe_export.value).path()).read_text())))[-1][0] == "'=1+1"
        await workspace.get_by_label('Upload spreadsheet', exact=True).set_input_files({'name': 'synthetic-book.xlsx', 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buffer': xlsx_bytes})
        await workspace.get_by_label('Worksheet', exact=False).wait_for()
        await workspace.get_by_label('Worksheet', exact=False).select_option('Second')
        await workspace.locator('tbody td').filter(has_text='7').wait_for()
        assert await workspace.get_by_label('Worksheet', exact=False).input_value() == 'Second'
        await workspace.get_by_role('button', name='Deliverable recipes', exact=True).click()
        await workspace.get_by_label('Name', exact=True).fill('Synthetic weekly recipe')
        await workspace.get_by_label('Structure, branding and instructions', exact=True).fill('Include a cited summary and an action table.')
        await workspace.get_by_label('Sources and required inputs', exact=True).fill('Use uploaded synthetic source data.')
        await workspace.get_by_label('Output', exact=False).select_option('spreadsheet')
        await workspace.get_by_role('button', name='Save recipe', exact=True).click()
        await workspace.get_by_text('Synthetic weekly recipe', exact=True).wait_for()
        assert recipes[0]['output'] == 'spreadsheet'
        await workspace.get_by_role('button', name='Run', exact=True).click(); await wait_chat(3)
        assert chat_requests[-1]['prompt'].startswith('Create an Excel spreadsheet.') and 'Use uploaded synthetic source data.' in chat_requests[-1]['prompt']
        await open_tool('Productivity workspace'); await workspace.get_by_role('button', name='Deliverable recipes', exact=True).click()
        await workspace.get_by_role('button', name='Delete', exact=True).click()
        await workspace.get_by_text('Synthetic weekly recipe', exact=True).wait_for(state='detached')
        assert not recipes
        await close_dialog(workspace)

        # A project must be selected before editing its separately versioned brief.
        if await page.locator('.mobile-menu').is_visible():
            await page.locator('.mobile-menu').click()
        if not await page.locator('.project-select').is_visible():
            await page.locator('.sidebar .section-heading').filter(has_text='PROJECTS').click()
        await page.locator('.project-select').select_option(PID)
        if await page.locator('.sidebar-backdrop').is_visible():
            await page.keyboard.press('Escape')
        await open_tool('Project memory')
        memory_dialog = page.get_by_role('dialog', name='Project memory', exact=True)
        await memory_dialog.get_by_label('Project brief', exact=True).fill('Synthetic goals and reviewed decisions.')
        await memory_dialog.get_by_role('button', name='Save brief', exact=True).click()
        for _ in range(100):
            if memory['revision'] == 2: break
            await page.wait_for_timeout(50)
        assert memory == {'brief': 'Synthetic goals and reviewed decisions.', 'revision': 2}
        assert await memory_dialog.get_by_role('button', name='Save brief', exact=True).is_disabled()
        await close_dialog(memory_dialog)
        await open_tool('Notifications')
        inbox = page.get_by_role('dialog', name='Notifications', exact=True)
        await inbox.get_by_role('button', name='Open task →', exact=True).click()
        await page.get_by_text('Synthetic task result.', exact=True).wait_for()
        assert ('POST', '/notifications/read', {'id': 'job:fixture-task'}) in writes

        mcp = await open_mcp()
        blocked = mcp.locator('article').filter(has_text='Synthetic Blocked Tool')
        assert await blocked.get_by_role('button', name='Connect', exact=True).is_disabled()
        card = mcp.locator('article').filter(has_text='Synthetic Tool').filter(has_not_text='Blocked')
        await card.get_by_role('button', name='Edit template & access', exact=True).click()
        await mcp.get_by_role('button', name='Add credential field', exact=True).click()
        fields = mcp.locator('fieldset')
        await fields.nth(1).get_by_label('key', exact=True).fill('account')
        await fields.nth(1).get_by_label('label', exact=True).fill('Synthetic account ID')
        await fields.nth(1).get_by_label('HTTP header', exact=True).fill('X-Account-ID')
        await mcp.get_by_role('checkbox', name='All company employees', exact=True).uncheck()
        await mcp.get_by_role('checkbox', name='Everyone', exact=True).check()
        await mcp.get_by_role('checkbox', name='Synthetic User (fixture-user)', exact=True).check()
        await mcp.get_by_role('button', name='Save template & access', exact=True).click()
        await mcp.get_by_role('status').filter(has_text='Template and access saved.').wait_for()
        assert len(template['fields']) == 2 and template['fields'][1]['target'] == 'X-Account-ID' and template['users'] == ['fixture-user'] and template['groups'] == ['buddy']
        await close_dialog(mcp)
        await open_tool('MCP server catalog')
        mcp = page.get_by_role('dialog', name='MCP server catalogue', exact=True)
        assert 'buddy-surface' in (await mcp.get_attribute('class'))
        await mcp.locator('article').filter(has_text='Synthetic Tool').filter(has_not_text='Blocked').get_by_role('button', name='Assign access', exact=True).click()
        access = mcp.get_by_role('form', name='Assign MCP server access', exact=True)
        await access.get_by_role('checkbox', name='Everyone', exact=True).uncheck()
        await access.get_by_role('checkbox', name='Everyone', exact=True).check()
        await access.get_by_label('Find users', exact=True).fill('fixture-user')
        assert await access.get_by_role('checkbox', name='Synthetic User (fixture-user)', exact=True).is_checked()
        await access.get_by_role('button', name='Save access', exact=True).click()
        await mcp.get_by_role('status').filter(has_text='MCP server access saved.').wait_for()
        assert template['groups'] == ['company_b'] and template['users'] == ['fixture-user']
        assert len(template['fields']) == 2
        await close_dialog(mcp)
        await open_tool('A2A agent catalog')
        catalog = page.get_by_role('dialog', name='A2A agent catalogue', exact=True)
        await catalog.get_by_role('button', name='Edit definition & access', exact=True).click()
        await catalog.get_by_label('Display name override', exact=True).fill('Synthetic reviewed A2A Agent')
        await catalog.get_by_label('Or grant selected users', exact=False).select_option(['fixture-user'])
        await catalog.get_by_role('button', name='Discover and save', exact=True).click()
        await catalog.get_by_role('heading', name='Synthetic reviewed A2A Agent', exact=True).wait_for()
        assert agents[0]['users'] == ['fixture-user']
        await close_dialog(catalog)

        # Employee catalogues expose credential entry without definition/access editors.
        admin = False; await page.goto(base + '?conversation=' + SID)
        await page.get_by_role('button', name='Apps', exact=True).wait_for()
        mcp = await open_mcp()
        assert await mcp.get_by_role('button', name='Create template', exact=True).count() == 0
        assert await mcp.get_by_role('button', name='Edit template & access', exact=True).count() == 0
        assert await mcp.get_by_role('button', name='＋ Define MCP server', exact=True).count() == 0
        await mcp.get_by_role('button', name='Connect', exact=True).click()
        assert await mcp.get_by_label('Server URL', exact=True).count() == 0
        await mcp.get_by_label('Synthetic API token', exact=True).fill('synthetic-token')
        await mcp.get_by_label('Synthetic account ID', exact=True).fill('synthetic-account')
        await mcp.get_by_role('button', name='Save connection', exact=True).click()
        await mcp.get_by_role('status').filter(has_text='Connection saved.').wait_for()
        assert ('POST', '/mcp-catalog/fixture-tool/connect', {'credentials': {'token': 'synthetic-token', 'account': 'synthetic-account'}}) in writes
        await mcp.get_by_role('button', name='Test again', exact=True).click()
        await mcp.locator('details').filter(has_text='Synthetic fixture check passed').locator('summary').click()
        await mcp.get_by_text('Synthetic fixture check passed', exact=True).wait_for()
        await close_dialog(mcp)
        await open_tool('A2A agent catalog')
        catalog = page.get_by_role('dialog', name='A2A agent catalogue', exact=True)
        assert await catalog.get_by_role('button', name='＋ Define A2A agent', exact=True).count() == 0
        assert await catalog.get_by_role('button', name='Edit definition & access', exact=True).count() == 0
        assert await catalog.get_by_role('button', name='Delete', exact=True).count() == 0
        await catalog.get_by_role('button', name='Activate', exact=True).click()
        await catalog.get_by_label('API key (x-api-key)', exact=True).fill('synthetic-agent-key')
        await catalog.get_by_label('Bearer token', exact=True).fill('synthetic-agent-token')
        await catalog.get_by_role('button', name='Activate agent', exact=True).click()
        await catalog.get_by_role('button', name='Private credentials', exact=True).wait_for()
        assert ('PUT', '/agent-catalog/fixture-agent/activation', {'api_key': 'synthetic-agent-key', 'auth_token': 'synthetic-agent-token', 'clear_credentials': False}) in writes
        assert not errors, errors
        await browser.close()
    print('PASS: synthetic browser fixtures verify Tools, transcript review, structured handoff without external writes, CSV stats/charts/safe exports, Excel worksheets, private recipes, project memory, branching, notifications, and admin/employee MCP+A2A catalogues; no console errors.')

asyncio.run(main())
