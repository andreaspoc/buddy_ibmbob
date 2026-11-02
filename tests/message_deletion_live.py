"""Real browser deletion and model followup with a disposable synthetic conversation."""
import asyncio
import json
import os
import secrets
from uuid import uuid4

import httpx
from fastapi import Response
from starlette.requests import Request
from playwright.async_api import async_playwright
from app import auth, sessions, job_queue, postgres_storage as storage, blob_storage


async def main():
    username = 'message-delete-live-' + uuid4().hex[:10]
    user = auth.create_user(username, secrets.token_urlsafe(24))
    response = Response()
    auth.start_session(response, user, Request({'type': 'http', 'scheme': 'http', 'path': '/', 'headers': [], 'server': ('localhost', 8080)}))
    token = response.headers['set-cookie'].split(';')[0].split('=', 1)[1]
    session = sessions.create_session(username)
    sid = session['id']
    base = os.environ['PUBLIC_BASE_URL']
    try:
        for index, (question, answer) in enumerate([
            ('Synthetic first question', 'The retained synthetic marker is LANTERN.'),
            ('Synthetic later question', 'The removed synthetic marker is COMET.'),
        ]):
            sessions.append_history(sid, username, {'type': 'request', 'prompt': question, 'user_message_id': f'fixture-q{index}', 'assistant_message_id': f'fixture-a{index}'})
            sessions.append_history(sid, username, {'type': 'delta', 'text': answer})
            sessions.append_history(sid, username, {'type': 'done'})
        async with httpx.AsyncClient(base_url=base, cookies={auth.COOKIE: token}, timeout=240) as api:
            await api.put('/personalization/tutorials', json={'disabled': True})
            async with async_playwright() as runtime:
                browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
                context = await browser.new_context(ignore_https_errors=True, viewport={'width': 1600, 'height': 1000})
                await context.add_cookies([{'name': auth.COOKIE, 'value': token, 'url': base}])
                await context.add_init_script(f"sessionStorage.setItem('buddy-approval-guide:{username}', 'seen')")
                page = await context.new_page()
                page.set_default_timeout(20000)
                await page.goto(base + '/?conversation=' + sid)
                await page.get_by_text('The removed synthetic marker is COMET.', exact=True).wait_for()
                await page.get_by_role('button', name='Delete answer', exact=True).last.click()
                await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
                await page.get_by_text('The removed synthetic marker is COMET.', exact=True).wait_for(state='detached')
                await page.get_by_text('Synthetic later question', exact=True).wait_for()
                await page.get_by_role('button', name='Delete question', exact=True).last.click()
                await page.get_by_role('dialog').get_by_role('button', name='Confirm', exact=True).click()
                await page.get_by_text('Synthetic later question', exact=True).wait_for(state='detached')
                await page.reload()
                await page.get_by_text('The retained synthetic marker is LANTERN.', exact=True).wait_for()
                assert not await page.get_by_text('Synthetic later question', exact=True).count()
                assert not await page.get_by_text('The removed synthetic marker is COMET.', exact=True).count()
                print('PASS deployed browser: individual question/answer deletion and persistence after reload', flush=True)
                await browser.close()
            result = await api.post('/chat/stream', json={
                'workspace_id': sid, 'mode': 'agent', 'ui_language': 'en',
                'prompt': 'What exact synthetic marker did you give in your previous remaining assistant answer? Reply only with that marker; do not use tools.',
                'session_id': 'a' * 32,
            })
            assert result.is_success, (result.status_code, result.text[:1000])
            answer = ''
            terminal = None
            for line in result.text.splitlines():
                if not line.strip():
                    continue
                if line.startswith('data: '):
                    line = line[6:]
                event = json.loads(line)
                if event.get('type') == 'delta':
                    answer = event.get('text', '') if event.get('replace') else answer + event.get('text', '')
                elif event.get('type') in {'done', 'error'}:
                    terminal = event
            assert terminal and terminal['type'] == 'done', terminal
            assert 'LANTERN' in answer and 'COMET' not in answer, answer
            history_result = await api.get(f'/sessions/{sid}/history')
            history_result.raise_for_status()
            assert 'COMET' not in history_result.text and 'Synthetic later question' not in history_result.text
            print('PASS real LLM followup from previous retained answer:', answer.strip(), flush=True)
    finally:
        with job_queue._connect() as db:
            active = db.execute("SELECT id FROM bob_jobs WHERE username=%s AND status IN ('queued','running')", (username,)).fetchall()
        for row in active:
            job_queue.request_cancel(str(row['id']), username)
        for _ in range(20):
            with job_queue._connect() as db:
                active = db.execute("SELECT 1 FROM bob_jobs WHERE username=%s AND status IN ('queued','running')", (username,)).fetchone()
            if not active:
                break
            await asyncio.sleep(1)
        if not active:
            with job_queue._connect() as db:
                for table in ('bob_answer_feedback', 'bob_conversation_shares', 'bob_interactive_widgets', 'bob_conversation_history', 'bob_jobs', 'bob_conversations', 'bob_storage_files', 'bob_storage_users', 'sessions', 'bob_user_profiles', 'bob_personalization', 'users'):
                    if db.execute('SELECT to_regclass(%s) AS name', (table,)).fetchone()['name']:
                        db.execute(f'DELETE FROM {table} WHERE username=%s', (username,))
            blob_storage.purge_message_caches(username, sid)
            print('Disposable live message-deletion account cleaned', flush=True)
        else:
            print('Fixture cleanup deferred until cancelled worker releases its lease:', username, flush=True)


asyncio.run(main())
