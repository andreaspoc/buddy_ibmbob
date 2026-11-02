"""Core integrations with feature services; identities use the original session."""
import os

import httpx
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool


def enabled(name):
    upper = name.upper()
    if upper in ('DECISIONS', 'ZEN'):
        val = os.getenv('BUDDY_DECISIONS_ENABLED') or os.getenv('BUDDY_ZEN_ENABLED') or '1'
        return val.strip().lower() not in {'0', 'false', 'no', 'off'}
    return os.getenv(f'BUDDY_{upper}_ENABLED', '0').strip().lower() not in {'0', 'false', 'no', 'off'}


def capabilities():
    return {'plugins': [
        {'id': name.lower(), 'version': 1,
         'enabled': enabled(name),
         'mode': 'service' if os.getenv(f'BUDDY_{name}_PLUGIN_URL', '').strip() else 'embedded'}
        for name in ('OFFICE', 'PEOPLE', 'PROJECTS', 'DECISIONS', 'TETRAGON', 'LEARNING')
    ]}


async def office_context(request, username, file_ids):
    if not capabilities()['plugins'][0]['enabled']:
        raise HTTPException(503, 'Office plugin is disabled')
    origin = os.getenv('BUDDY_OFFICE_PLUGIN_URL', '').strip().rstrip('/')
    if not origin:
        from app.office_chat import chat_context
        return await run_in_threadpool(chat_context, username, file_ids)
    allowed = {'host', 'origin', 'cookie', 'authorization', 'x-forwarded-proto',
               'x-correlation-id', 'idempotency-key', 'x-chat-id',
               'x-user-message-id', 'x-assistant-message-id'}
    headers = [(k, v) for k, v in request.headers.items() if k.lower() in allowed]
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            response = await client.post(origin + '/api/office/chat-context', headers=headers,
                                         json={'file_ids': [str(value) for value in file_ids]})
    except httpx.HTTPError:
        raise HTTPException(503, 'Office plugin unavailable') from None
    if response.status_code != 200:
        try:
            detail = response.json().get('detail', 'Office reference unavailable')
        except ValueError:
            detail = 'Office reference unavailable'
        raise HTTPException(response.status_code if 400 <= response.status_code < 600 else 502, detail)
    data = response.json()
    return data['context'], data['references']


def _headers(request):
    allowed = {'host', 'origin', 'cookie', 'authorization', 'x-forwarded-proto',
               'x-correlation-id', 'idempotency-key', 'x-chat-id',
               'x-user-message-id', 'x-assistant-message-id'}
    return [(k, v) for k, v in request.headers.items() if k.lower() in allowed]


async def save_office_file(request, username, name, raw, folder_id=None):
    if not enabled('office'):
        raise HTTPException(503, 'Office plugin is disabled')
    origin = os.getenv('BUDDY_OFFICE_PLUGIN_URL', '').strip().rstrip('/')
    if not origin:
        from app.office import store_new
        return await run_in_threadpool(store_new, username, name, raw, folder_id) if folder_id else await run_in_threadpool(store_new, username, name, raw)
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            response = await client.post(origin + '/api/office/files', headers=_headers(request),
                                         files={'file': (name, raw, 'application/octet-stream')},
                                         data={'folder_id': str(folder_id)} if folder_id else {})
    except httpx.HTTPError:
        raise HTTPException(503, 'Office plugin unavailable') from None
    if response.status_code != 200:
        try:
            detail = response.json().get('detail', 'Office export unavailable')
        except ValueError:
            detail = 'Office export unavailable'
        raise HTTPException(response.status_code if 400 <= response.status_code < 600 else 502, detail)
    return response.json()
