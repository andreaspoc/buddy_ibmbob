"""Server-side Office transport. Assistant tools never receive credentials."""
import asyncio
import hashlib
import json
import os
import time

import httpx
import jwt
from fastapi import HTTPException


def encode_payload(operation, arguments):
    return json.dumps({'operation': operation, 'arguments': arguments}, separators=(',', ':'), sort_keys=True).encode()


async def office_request(username, operation, arguments):
    from app.plugin_client import enabled
    if not username:
        raise PermissionError('Authenticated Office user required')
    if not enabled('office'):
        raise HTTPException(503, 'Office plugin is disabled')
    origin = os.getenv('BUDDY_OFFICE_PLUGIN_URL', '').strip().rstrip('/')
    if not origin:
        from app.office_app_actions import execute
        return await asyncio.to_thread(execute, username, operation, arguments)
    secret = os.getenv('OFFICE_JWT_SECRET', '')
    if len(secret) < 32:
        raise HTTPException(503, 'Office app integration is not configured')
    raw = encode_payload(operation, arguments)
    issued = int(time.time())
    token = jwt.encode({'sub': username, 'aud': 'buddy-office-actions', 'iat': issued, 'exp': issued + 60,
                        'body_sha256': hashlib.sha256(raw).hexdigest()}, secret, algorithm='HS256')
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            response = await client.post(origin + '/api/office/app-actions', content=raw,
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    except httpx.HTTPError:
        raise HTTPException(503, 'Office plugin unavailable') from None
    if response.status_code != 200:
        raise HTTPException(503 if response.status_code >= 500 else response.status_code, 'Office action failed')
    return response.json()


def conversation_content(username, session_id, path, workspace=None):
    from pathlib import Path, PurePath
    from app import postgres_storage as storage
    from app.sessions import storage_scope
    storage.validate_path(path)
    scope = storage_scope(session_id, username)
    if workspace:
        root = Path(workspace).resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            raise ValueError('Conversation path must remain inside the workspace')
        if target.is_file():
            if target.stat().st_size > 50 * 1024 * 1024:
                raise ValueError('Office file exceeds 50 MB')
            return PurePath(path).name, target.read_bytes()
    saved = storage.get_file(username, scope, path)
    if not saved:
        raise FileNotFoundError('Conversation file not found')
    if len(saved['content']) > 50 * 1024 * 1024:
        raise ValueError('Office file exceeds 50 MB')
    return PurePath(path).name, saved['content']
