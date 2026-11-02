"""Identity-preserving, read-only Office transfers for the learning library.

Only the original caller's authenticated Office view is queried. This module
never accepts a username, signs an elevated capability, or writes to Office.
"""
from __future__ import annotations

from app.branding import brand_text
import json
import os
from pathlib import PurePath
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from app.auth import current_user
from app.plugin_client import enabled

MAX_BYTES = 50 * 1024 * 1024
MAX_METADATA_BYTES = 8 * 1024 * 1024
SUPPORTED_EXTENSIONS = frozenset({'epub', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'html', 'htm', 'txt', 'md'})


def _origin():
    if not enabled('office'):
        raise HTTPException(503, 'Office Suite is disabled')
    origin = os.getenv('BUDDY_OFFICE_PLUGIN_URL', '').strip().rstrip('/')
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise HTTPException(503, 'Office Suite connection is not configured correctly')
    return origin


def _headers(request):
    # Never forward actor/role/username headers, model capabilities or host data.
    return {key: value for key, value in request.headers.items()
            if key.lower() in {'cookie', 'authorization'}}


def _status(response):
    if response.status_code == 200:
        return
    if response.status_code in (401, 403):
        raise HTTPException(response.status_code, 'Office access denied; sign in with an authorized account')
    if response.status_code == 404:
        raise HTTPException(404, 'Office file not found or not accessible')
    if response.status_code == 413:
        raise HTTPException(413, 'Office file exceeds 50 MB')
    if response.status_code >= 500 or response.status_code == 429:
        raise HTTPException(503, 'Office Suite is unavailable')
    # Redirects are deliberately not followed, including to another origin.
    raise HTTPException(502, 'Office Suite returned an unexpected response')


async def _get(client, url, headers, maximum):
    try:
        async with client.stream('GET', url, headers=headers) as response:
            _status(response)
            length = response.headers.get('content-length', '')
            if length.isdecimal() and int(length) > maximum:
                raise HTTPException(413, 'Office response exceeds the transfer size limit')
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > maximum:
                    raise HTTPException(413, 'Office response exceeds the transfer size limit')
            return bytes(raw)
    except httpx.HTTPError:
        raise HTTPException(503, 'Office Suite is unavailable') from None


def _json(raw):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise HTTPException(502, 'Office Suite returned invalid file metadata') from None


def _metadata(item):
    if not isinstance(item, dict):
        raise HTTPException(502, 'Office Suite returned invalid file metadata')
    try:
        identity = str(UUID(str(item['id'])))
        name = item['name']
        extension = item['extension']
    except (KeyError, ValueError, TypeError, AttributeError):
        raise HTTPException(502, 'Office Suite returned invalid file metadata') from None
    if not isinstance(name, str) or not 1 <= len(name) <= 240 or '\x00' in name or not isinstance(extension, str):
        raise HTTPException(502, 'Office Suite returned invalid file metadata')
    extension = extension.lower()
    # The Office extension is canonical; require the filename to agree rather
    # than silently presenting a mismatched or unsupported import type.
    if extension not in SUPPORTED_EXTENSIONS or PurePath(name).suffix.lower() != '.' + extension:
        return None
    return {'id': identity, 'name': name, 'extension': extension}


async def list_files(request: Request, query='', offset=0, limit=25):
    if (not isinstance(query, str) or len(query) > 200 or type(offset) is not int or offset < 0
            or offset > 100000 or type(limit) is not int or not 1 <= limit <= 100):
        raise HTTPException(422, 'Invalid Office file search or pagination')
    origin = _origin()
    user = await current_user(request)
    if origin:
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            data = _json(await _get(client, origin + '/api/office/files', _headers(request), MAX_METADATA_BYTES))
    else:
        from app import office
        data = await run_in_threadpool(office.files, user=user)
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise HTTPException(502, 'Office Suite returned invalid file metadata')
    items = []
    for item in data['items']:
        metadata = _metadata(item)
        if metadata and query.strip().casefold() in metadata['name'].casefold():
            items.append(metadata)
    return {'items': items[offset:offset + limit],
            'next_offset': offset + limit if offset + limit < len(items) else None}


async def read_file(request: Request, file_id):
    try:
        identity = UUID(str(file_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, 'Select a valid Office file') from None
    origin = _origin()
    user = await current_user(request)
    if origin:
        headers = _headers(request)
        async with httpx.AsyncClient(trust_env=False, timeout=90, follow_redirects=False) as client:
            info = _json(await _get(client, origin + f'/api/office/files/{identity}', headers, MAX_METADATA_BYTES))
            metadata = _metadata(info)
            if metadata is None:
                raise HTTPException(422, brand_text('This Office file format cannot be imported into Learning Buddy'))
            if metadata['id'] != str(identity):
                raise HTTPException(502, 'Office Suite returned mismatched file metadata')
            if isinstance(info.get('size'), int) and info['size'] > MAX_BYTES:
                raise HTTPException(413, 'Office file exceeds 50 MB')
            raw = await _get(client, origin + f'/api/office/files/{identity}/download', headers, MAX_BYTES)
    else:
        from app import office
        info = await run_in_threadpool(office.file_info, identity, user=user)
        metadata = _metadata(info)
        if metadata is None:
            raise HTTPException(422, brand_text('This Office file format cannot be imported into Learning Buddy'))
        if metadata['id'] != str(identity):
            raise HTTPException(502, 'Office Suite returned mismatched file metadata')
        if isinstance(info.get('size'), int) and info['size'] > MAX_BYTES:
            raise HTTPException(413, 'Office file exceeds 50 MB')
        response = await run_in_threadpool(office.download, identity, user=user)
        raw = response.body
        if len(raw) > MAX_BYTES:
            raise HTTPException(413, 'Office file exceeds 50 MB')
    return {'name': metadata['name'], 'raw': raw}
