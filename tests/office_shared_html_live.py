"""Real two-user HTML sharing/listing/editor/permission checks; disposable synthetic files only."""
import asyncio
import os
import secrets
from contextlib import AsyncExitStack
from uuid import uuid4

import httpx
from fastapi import Response
from starlette.requests import Request
from playwright.async_api import async_playwright
from app import auth, job_queue
from buddy_office import office


def account(prefix):
    username = prefix + uuid4().hex[:10]
    user = auth.create_user(username, secrets.token_urlsafe(24))
    response = Response()
    auth.start_session(response, user, Request({'type': 'http', 'scheme': 'http', 'path': '/', 'headers': [], 'server': ('localhost', 8080)}))
    return username, response.headers['set-cookie'].split(';')[0].split('=', 1)[1]


async def main():
    owner, owner_token = account('share-owner-check-')
    recipient, recipient_token = account('share-recipient-check-')
    base = os.environ['PUBLIC_BASE_URL'].rstrip('/')
    try:
        async with AsyncExitStack() as stack:
            sender = await stack.enter_async_context(httpx.AsyncClient(base_url=base, cookies={auth.COOKIE: owner_token}, timeout=60))
            receiver = await stack.enter_async_context(httpx.AsyncClient(base_url=base, cookies={auth.COOKIE: recipient_token}, timeout=60))
            for client in (sender, receiver):
                (await client.put('/personalization/tutorials', json={'disabled': True})).raise_for_status()
            result = await sender.post('/api/office/files', files={'file': ('Synthetic shared HTML.html', b'<!doctype html><html><body><h1>Synthetic shared HTML visibility</h1><p>Synthetic fixture only.</p></body></html>', 'text/html')})
            result.raise_for_status(); file = result.json(); fid = file['id']
            assert (await receiver.get(f'/api/office/files/{fid}/content')).status_code == 404
            async with async_playwright() as runtime:
                browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
                context = await browser.new_context(ignore_https_errors=True, viewport={'width': 1700, 'height': 1100})
                await context.add_cookies([{'name': auth.COOKIE, 'value': recipient_token, 'url': base}])
                page = await context.new_page(); page.set_default_timeout(20000)
                errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(base + '/office')
                await page.get_by_role('button', name='Refresh office files').wait_for()
                assert not await page.get_by_role('button', name=file['name'], exact=True).count()
                (await sender.post(f'/api/office/files/{fid}/shares', json={'username': recipient, 'permission': 'write'})).raise_for_status()
                await page.evaluate("window.dispatchEvent(new Event('focus'))")
                await page.get_by_role('button', name=file['name'], exact=True).wait_for()
                print('PASS new share appears automatically in recipient All files without reloading', flush=True)
                await page.locator('.office-sidebar button').filter(has_text='HTML presentations').click()
                await page.get_by_role('button', name=file['name'], exact=True).wait_for()
                await page.locator('.office-sidebar button').filter(has_text='My files').click()
                assert not await page.get_by_role('button', name=file['name'], exact=True).count()
                await page.locator('.office-sidebar button').filter(has_text='Shared with me').click()
                await page.get_by_role('button', name=file['name'], exact=True).wait_for()
                print('PASS shared HTML appears in HTML and Shared with me; My files remains owner-only', flush=True)
                await page.get_by_role('button', name=file['name'], exact=True).click()
                await page.frame_locator('.office-html-live-frame').get_by_role('heading', name='Synthetic shared HTML visibility', exact=True).wait_for()
                print('PASS recipient opens shared HTML in live editor', flush=True)
                content = await receiver.get(f'/api/office/files/{fid}/content'); content.raise_for_status()
                edited = content.json()['html'].replace('Synthetic fixture only.', 'Synthetic shared write verified.')
                update = await receiver.put(f'/api/office/files/{fid}/content', json={'html': edited, 'revision': content.json()['revision']}); update.raise_for_status()
                assert 'Synthetic shared write verified.' in (await sender.get(f'/api/office/files/{fid}/content')).json()['html']
                (await sender.post(f'/api/office/files/{fid}/shares', json={'username': recipient, 'permission': 'read'})).raise_for_status()
                latest = (await receiver.get(f'/api/office/files/{fid}/content')).json()
                assert (await receiver.put(f'/api/office/files/{fid}/content', json={'html': latest['html'], 'revision': latest['revision']})).status_code == 403
                await page.get_by_role('button', name='Back to file library', exact=True).click()
                await page.get_by_role('button', name=file['name'], exact=True).wait_for()
                (await sender.delete(f'/api/office/files/{fid}/shares/{recipient}')).raise_for_status()
                await page.evaluate("window.dispatchEvent(new Event('focus'))")
                await page.get_by_role('button', name=file['name'], exact=True).wait_for(state='detached')
                assert (await receiver.get(f'/api/office/files/{fid}/content')).status_code == 404
                assert not errors, errors
                print('PASS write permission, read-only enforcement and revocation refresh; no browser errors', flush=True)
                await browser.close()
    finally:
        storage = office.s3(); bucket = os.environ['BOB_S3_BUCKET']
        for username in (owner, recipient):
            prefix = f'users/{username}/office/'
            for chunk in storage.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
                entries = [{'Key': item['Key'], 'VersionId': item['VersionId']} for item in chunk.get('Versions', []) + chunk.get('DeleteMarkers', [])]
                if entries: storage.delete_objects(Bucket=bucket, Delete={'Objects': entries})
            with job_queue._connect() as db:
                db.execute('DELETE FROM office.bob_office_sessions WHERE file_id IN (SELECT id FROM office.bob_office_files WHERE username=%s)', (username,))
                for table in ('office.bob_office_files', 'sessions', 'bob_user_profiles', 'bob_personalization', 'bob_storage_files', 'bob_storage_users', 'users'):
                    db.execute(f'DELETE FROM {table} WHERE username=%s', (username,))
        print('Disposable sharing accounts and files cleaned', flush=True)


asyncio.run(main())
