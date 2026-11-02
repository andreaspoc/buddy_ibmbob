"""Live Office routing, Greek labels and session expiry; disposable synthetic data."""
import asyncio
import os
import secrets
from uuid import uuid4

import httpx
from fastapi import Response
from playwright.async_api import async_playwright
from starlette.requests import Request

from app import auth, job_queue, office


async def main():
    username = 'office-routes-test-' + uuid4().hex[:10]
    user = auth.create_user(username, secrets.token_urlsafe(24))
    response = Response()
    auth.start_session(response, user, Request({'type': 'http', 'scheme': 'https', 'path': '/',
                                             'headers': [], 'server': ('localhost', 8080)}))
    token = response.headers['set-cookie'].split(';')[0].split('=', 1)[1]
    base = os.environ['PUBLIC_BASE_URL'].rstrip('/')
    try:
        async with httpx.AsyncClient(base_url=base, cookies={auth.COOKIE: token}, timeout=60) as api:
            (await api.put('/personalization/tutorials', json={'disabled': True})).raise_for_status()
            async with async_playwright() as p:
                browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
                context = await browser.new_context(ignore_https_errors=True, viewport={'width': 1700, 'height': 1100})
                await context.add_cookies([{'name': auth.COOKIE, 'value': token, 'url': base}])
                page = await context.new_page()
                page.set_default_timeout(20000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(base + '/office/new/word')
                await page.get_by_role('dialog', name='Create office file').wait_for()
                await page.keyboard.press('Escape')
                await page.wait_for_url(base + '/office')
                assert not await page.get_by_role('dialog', name='Create office file').count()
                assert (await api.get('/api/office/files')).json()['items'] == []
                print('PASS direct /office/new/word opens dialog; Escape returns /office without creating a file', flush=True)

                await page.goto(base + '/office/new/word')
                dialog = page.get_by_role('dialog', name='Create office file')
                await dialog.get_by_role('textbox', name='File name').fill('Synthetic route document')
                await dialog.get_by_role('button', name='Create & open', exact=True).click()
                await page.wait_for_url('**/office/files/*')
                await page.get_by_text('Ready to edit', exact=True).wait_for(timeout=120000)
                path = page.url
                file_id = path.rsplit('/', 1)[1]
                files = (await api.get('/api/office/files')).json()['items']
                assert len(files) == 1 and files[0]['id'] == file_id
                await page.reload()
                await page.get_by_text('Ready to edit', exact=True).wait_for(timeout=120000)
                assert page.url == path
                files = (await api.get('/api/office/files')).json()['items']
                assert len(files) == 1 and files[0]['id'] == file_id
                print('PASS create uses /office/files/UUID; reload restores same document with no duplicate', flush=True)

                await page.locator('.office-editor-title .language-selector select').select_option('el')
                await page.get_by_role('button', name='Αποθήκευση στο Office Suite', exact=True).wait_for()
                if not await page.locator('.office-assistant').is_visible():
                    await page.get_by_role('button', name='Ρωτήστε τον Buddy', exact=True).click()
                await page.get_by_role('textbox', name='Οδηγίες για τον Buddy').wait_for()
                assert await page.get_by_role('button', name='Επιστροφή στη βιβλιοθήκη αρχείων', exact=True).is_visible()
                print('PASS Greek Office controls and Bob panel labels', flush=True)

                # Revoke the real server-side session, retaining the browser cookie
                # to reproduce expiry rather than simulating an application event.
                with job_queue._connect() as db:
                    db.execute('DELETE FROM sessions WHERE username=%s', (username,))
                await page.evaluate("window.dispatchEvent(new Event('focus'))")
                await page.locator('.buddy-login-viewport').wait_for(timeout=25000)
                assert not await page.locator('.office-editor-frame iframe').count()
                assert not await page.locator('.office-assistant').count()
                assert not await page.locator('.shell').count()
                denied = await api.get('/api/office/files/' + file_id + '/download')
                assert denied.status_code == 401
                assert not errors, errors
                await page.screenshot(path='/tmp/office-session-expired.png', full_page=True)
                print('PASS revoked session + focus removes editor/Bob/workspace and displays login only', flush=True)
                await browser.close()
                await asyncio.sleep(2)
    finally:
        office.ensure_schema()
        client = office.s3()
        bucket = os.environ['BOB_S3_BUCKET']
        prefix = f'users/{username}/office/'
        for chunk in client.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
            entries = [{'Key': item['Key'], 'VersionId': item['VersionId']}
                       for item in chunk.get('Versions', []) + chunk.get('DeleteMarkers', [])]
            if entries:
                client.delete_objects(Bucket=bucket, Delete={'Objects': entries})
        for item in client.list_objects_v2(Bucket=bucket, Prefix=prefix).get('Contents', []):
            client.delete_object(Bucket=bucket, Key=item['Key'])
        with job_queue._connect() as db:
            db.execute('DELETE FROM office.bob_office_sessions WHERE file_id IN (SELECT id FROM office.bob_office_files WHERE username=%s)', (username,))
            for table in ('office.bob_office_files', 'sessions', 'bob_user_profiles', 'bob_personalization',
                          'bob_storage_files', 'bob_storage_users', 'users'):
                db.execute(f'DELETE FROM {table} WHERE username=%s', (username,))
        print('Disposable route test user and synthetic documents cleaned', flush=True)


asyncio.run(main())
