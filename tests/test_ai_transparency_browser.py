"""Production UI checks with synthetic history/events; no real task is submitted."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

SESSION = 'a' * 32
TASK = '11111111-1111-4111-8111-111111111111'
STAMP = '2026-10-19T10:00:00Z'

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page()
        page.set_default_timeout(12000)
        errors = []
        cancel_gate = asyncio.Event()
        page.on('pageerror', lambda error: errors.append(str(error)))
        task = {'id': TASK, 'session_id': 'b' * 32, 'kind': 'chat', 'mode': 'agent', 'title': 'Synthetic queued task', 'status': 'queued', 'progress': 'Queued', 'created_at': STAMP, 'updated_at': STAMP}
        history = [
            {'type': 'request', 'prompt': 'Synthetic request', 'mode': 'agent', 'note_references': [{'id': 1, 'title': 'Synthetic planning note', 'truncated': True}], 'office_references': [{'id': 'fixture-file', 'name': 'Synthetic policy.docx', 'revision': 3}]},
            {'type': 'skill', 'name': 'fixture-skill'},
            {'type': 'tool', 'id': 'tool-one', 'name': 'knowledge_search', 'status': 'started', 'input': {'query': 'Synthetic query', 'secret': 'never-show-this-in-context'}},
            {'type': 'tool', 'id': 'tool-one', 'name': 'knowledge_search', 'status': 'completed', 'output': {'text': 'Synthetic result'}},
            {'type': 'delta', 'text': 'Synthetic answer with [Policy](https://example.com/policy) and [Duplicate](https://example.com/policy). [Unsafe](javascript:alert).'},
            {'type': 'done'},
            {'type': 'request', 'prompt': 'Deleted synthetic request', 'user_deleted': True},
            {'type': 'delta', 'text': 'Legacy answer with no recorded completion or source links.'},
        ]
        history[4]['text'] += '\n\n[Knowledge policy](/knowledge/11111111-1111-4111-8111-111111111111/file?citation=fixture)'
        history[4]['text'] += '\n\n```bobquestion\n' + json.dumps({'question': 'Synthetic follow-up?', 'options': ['Option A', 'Option B']}) + '\n```'
        history[4]['text'] += '\n\n```bobui\n' + json.dumps({'kind': 'split', 'title': 'Synthetic form', 'total': 120, 'people': 4, 'tip': 10}) + '\n```'
        history[7]['text'] += ' [Ordinary link](https://example.com/general)'
        history[1:1] = [{'type': 'delivery_state', 'state': state, 'timestamp': f'2026-10-19T10:00:{seconds:02d}Z'} for state,seconds in [('sending',0),('accepted',0),('queued',0),('running',0),('streaming',19),('completed',32)]]
        await page.add_init_script("""(() => {
            sessionStorage.setItem('buddy-active-session:explainability-fixture', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            const original = window.fetch;
            window.fetch = (input, options = {}) => {
                if (input !== '/chat/stream') return original(input, options);
                window.syntheticPayload = JSON.parse(options.body);
                return Promise.resolve(new Response(new ReadableStream({start(controller) {
                    window.syntheticEmit = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\\n'));
                    window.syntheticClose = () => controller.close();
                    options.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once: true});
                    window.syntheticEmit({type: 'start'});
                }}), {headers: {'Content-Type': 'application/x-ndjson', 'X-Bob-Job-Id': '22222222-2222-4222-8222-222222222222'}}));
            };
        })()""")
        async def respond(route):
            path = urlsplit(route.request.url).path
            if path == '/' or path.startswith(('/assets/', '/static/')) or path.endswith(('.svg', '.png', '.ico')):
                await route.continue_(); return
            data = []
            if path == '/auth/status': data = {'user': {'username': 'explainability-fixture', 'is_admin': False}}
            elif path == '/personalization/tutorials': data = {'disabled': True}
            elif path == '/sessions': data = [{'id': SESSION, 'title': 'Synthetic source conversation', 'updated_at': 1}]
            elif path == f'/sessions/{SESSION}/history': data = history
            elif path == '/tasks': data = [task]
            elif path == f'/tasks/{TASK}': data = {**task, 'result': '', 'steps': [{'id': 1, 'type': 'status', 'message': task['progress'], 'timestamp': STAMP}]}
            elif path.endswith('/cancel'):
                if TASK in path: task.update(status='stopped', progress='Stopped')
                else: await cancel_gate.wait()
                data = {'status': 'stopped'}
            elif path.endswith('/approval-policy'): data = {'policy': {'mode': 'auto', 'actions': []}, 'revision': 1, 'mutable': True, 'reason': None}
            elif path == '/modes': data = [{'slug': 'agent', 'name': 'Agent', 'kind': 'built-in'}]
            elif path.endswith('/capabilities'): data = {'web_search': False}
            elif path.startswith('/auth/microsoft'): data = {'configured': False, 'connected': False}
            await route.fulfill(json=data)
        await page.route('**/*', respond)
        url = os.getenv('AI_TRANSPARENCY_PREVIEW_URL', 'http://127.0.0.1:8080')
        for width, height in [(320, 568), (768, 1024), (1440, 1000)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.goto(url + '?conversation=' + SESSION)
            await page.locator('.message.assistant').nth(1).wait_for()
            answer = page.locator('.message.assistant').first
            assert await answer.locator('.ai-task-state,.request-delivery-timeline,.work-panel,.thinking-disclosure,.answer-sources').count() == 0
            assert await answer.locator('.answer-details').count() == 1
            await answer.locator('.clarification-card').wait_for()
            await answer.locator('.intelligent-answer').wait_for()
            assert await answer.locator('.clarification-card,.clarification-option-tile,.clarification-step-num,.intelligent-answer,.ia-fields input').evaluate_all("els=>els.length>5 && els.every(el=>getComputedStyle(el).borderRadius==='0px')"), 'Follow-up forms and interactive answer surfaces use square corners'
            assert await answer.locator('.clarification-custom-radio').first.evaluate("el=>getComputedStyle(el).borderRadius==='50%'"), 'Radio indicators remain circular'

            assert await answer.locator('.answer-details').get_attribute('open') is None
            panel = answer.locator('.answer-context')
            await panel.locator('summary').click()
            await panel.get_by_role('link', name='Policy', exact=True).wait_for()
            assert await panel.get_by_role('link').count() == 2, 'Deduplicate and exclude unsafe links'
            assert await panel.get_by_text('Synthetic planning note', exact=False).count() == 1
            assert await panel.get_by_text('Synthetic policy.docx', exact=False).count() == 1
            assert 'knowledge search' in await panel.inner_text()
            assert 'never-show-this-in-context' not in await panel.inner_text()
            stages = panel.locator('.answer-stage-track > li')
            assert await stages.count() == 4, 'Transport events collapse into four readable milestones'
            assert await stages.locator('.answer-stage-label').all_text_contents() == ['Request received', 'Working', 'Response started', 'Completed']
            assert await stages.locator('time').all_text_contents() == ['+0s', '+0s', '+19s', '+32s']
            assert 'Elapsed time · 32s' in await panel.inner_text()
            assert 'Done' not in await panel.locator('.answer-journey').inner_text(), 'No repeated terminal activity'
            assert await panel.locator('.answer-stage-track').evaluate("el=>el.scrollWidth<=el.clientWidth+1"), 'Timeline fits at every width'
            if width == 320:
                await panel.screenshot(path='/tmp/answer-journey-phone.png', animations='disabled')

            legacy = page.locator('.message.assistant').nth(1)
            assert await legacy.locator('.ai-task-state').count() == 0
            await legacy.locator('.answer-context summary').click()
            await legacy.locator('.answer-detail-status').filter(has_text='Response available').wait_for()
            assert await legacy.locator('.answer-detail-sources').count() == 0
            assert await legacy.get_by_role('heading', name='Recorded context', exact=True).count() == 0
            assert 'Synthetic planning note' not in await legacy.locator('.answer-context').inner_text(), 'Context cannot cross turns'
            assert await page.evaluate('document.documentElement.scrollWidth * Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) <= innerWidth+1')
            if width == 1440:
                await panel.screenshot(path='/tmp/ai-sources-context.png', animations='disabled')
            await panel.locator('summary').focus()
            await page.keyboard.press('Enter')
            assert await panel.get_attribute('open') is None, 'Keyboard can collapse explainability'
            print(f'PASS sources/context and missing metadata at {width}px', flush=True)
        await page.set_viewport_size({'width': 320, 'height': 568})
        for language, label in [('el', 'Λεπτομέρειες απάντησης'), ('hi', 'उत्तर का विवरण'), ('mt', 'Dettalji tat-tweġiba')]:
            await page.locator('.workspace-toolbar-language select').select_option(language)
            await page.locator('.answer-context summary').first.filter(has_text=label).wait_for()
            assert await page.evaluate('document.documentElement.scrollWidth * Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) <= innerWidth+1')
        await page.locator('.workspace-toolbar-language select').select_option('en')
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        print('PASS localized source disclosures at phone width', flush=True)
        prompt = page.locator('#prompt-input')
        await prompt.fill('Synthetic live lifecycle check')
        await prompt.press('Enter')
        await page.wait_for_function('typeof window.syntheticEmit === "function"')
        live = page.locator('.message.assistant').last
        async def emit(event):
            await page.evaluate('(event) => window.syntheticEmit(event)', event)
        for state, label in [('accepted', 'Accepted'), ('queued', 'Queued'), ('running', 'Working')]:
            await emit({'type': 'delivery_state', 'state': state, 'timestamp': STAMP})
            await live.locator('.answer-details > summary .ai-task-badge').filter(has_text=label).wait_for()
        await emit({'type': 'tool', 'id': 'unnamed-tool', 'status': 'started'})
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Running tool').wait_for()
        await live.locator('.answer-details > summary').click()
        await live.locator('.answer-context-body').get_by_text('Tool name unavailable',exact=True).first.wait_for()
        assert await page.locator('.error-boundary-card').count() == 0
        await emit({'type': 'tool', 'id': 'unnamed-tool', 'status': 'completed'})
        await live.locator('.answer-details > summary').click()
        await emit({'type': 'tool', 'id': 'live-tool', 'name': 'knowledge_search', 'status': 'started'})
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Running tool').wait_for()
        await emit({'type': 'approval', 'approval_id': 'synthetic-approval', 'job_id': '22222222-2222-4222-8222-222222222222', 'title': 'Synthetic read action', 'status': 'pending'})
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Waiting for approval').wait_for()
        await emit({'type': 'approval', 'approval_id': 'synthetic-approval', 'job_id': '22222222-2222-4222-8222-222222222222', 'title': 'Synthetic read action', 'status': 'approved'})
        await emit({'type': 'tool', 'id': 'live-tool', 'status': 'completed'})
        await emit({'type': 'delta', 'text': 'Synthetic partial answer.'})
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Working').wait_for()
        await page.locator('.stop-button').click()
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Stopping').wait_for()
        assert await live.locator('.ai-task-stopped').count() == 0, 'Do not claim stopped before server confirmation'
        cancel_gate.set()
        await live.locator('.answer-details > summary .ai-task-badge').filter(has_text='Stopped').wait_for()
        print('PASS live accepted/queued/working/tool/approval/writing states and server-confirmed Stop', flush=True)
        if await page.locator('.sidebar').is_visible():
            await page.locator('.sidebar').get_by_role('button', name='Tasks', exact=False).click()
        else:
            await page.locator('.mobile-menu').click()
            await page.locator('.sidebar').get_by_role('button', name='Tasks', exact=False).click()
        await page.locator('.task-card').first.click()
        await page.locator('.task-detail .ai-task-state strong').filter(has_text='Queued').wait_for()
        await page.locator('.task-detail').get_by_role('button', name='Stop task', exact=True).click()
        await page.locator('.task-detail .ai-task-state strong').filter(has_text='Stopped').wait_for()
        assert await page.locator('.task-card .ai-task-badge').inner_text() == 'Stopped', 'List and detail cannot disagree after detail confirms a terminal state'
        assert await page.locator('.task-last-updated time').get_attribute('datetime') == STAMP
        assert await page.locator('.task-detail').get_by_role('button', name='Stop task', exact=True).count() == 0
        assert await page.locator('.error-boundary-card').count() == 0
        assert not errors, errors
        print('PASS durable task status, authoritative update timestamp, terminal controls', flush=True)
        await page.screenshot(path='/tmp/ai-task-states.png', animations='disabled')
        await browser.close()

asyncio.run(main())
