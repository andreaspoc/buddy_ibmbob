"""User-owned exports and revocable, immutable account-gated conversation snapshots."""
from __future__ import annotations
import hashlib
import json
import os
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
from app.auth import current_user
from app import job_queue
from app.sessions import get_session, read_history

router = APIRouter()


def snapshot(title, history):
    """Allow only visible prose; never serialize raw history or tool payloads."""
    messages = []
    assistant = None
    for event in history:
        if event.get('type') == 'request':
            prompt = event.get('display_prompt') or event.get('prompt') or ''
            if not event.get('user_deleted'):
                messages.append({'role': 'user', 'content': str(prompt)})
            assistant = None if event.get('assistant_deleted') else {'role': 'assistant', 'content': ''}
            if assistant is not None:
                messages.append(assistant)
        elif event.get('type') == 'delta' and assistant is not None:
            text = event.get('text')
            if isinstance(text, str):
                assistant['content'] = text if event.get('replace') else assistant['content'] + text
    return {'title': str(title), 'messages': [m for m in messages if m['content']]}


def markdown_export(data):
    return '# ' + data['title'].replace('\n', ' ') + '\n\n' + '\n\n'.join(
        '## ' + m['role'].capitalize() + '\n\n' + m['content'] for m in data['messages']) + '\n'


def _owned_snapshot(session_id, username):
    try:
        record = get_session(session_id, username)
        return snapshot(record.get('title', 'Conversation'), read_history(session_id, username))
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, 'Conversation not found') from exc


def _schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS bob_conversation_shares (
        token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, session_id TEXT NOT NULL,
        snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')


@router.get('/sessions/{session_id}/export')
async def export_conversation_document(session_id: str, format: str = 'markdown', content: str = 'conversation', user: dict = Depends(current_user)):
    if format in {'docx', 'pdf'}:
        from app.conversation_office_export import export_chat
        from urllib.parse import quote
        name, raw = await export_chat(user['username'], session_id, format, content=content)
        media = 'application/pdf' if format == 'pdf' else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        return Response(raw, media_type=media, headers={
            'Content-Disposition': "attachment; filename*=UTF-8''" + quote(name, safe=''),
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(export_conversation, session_id, format, user)


def export_conversation(session_id: str, format: str = 'markdown', user: dict = Depends(current_user)):
    if format not in {'markdown', 'json'}:
        raise HTTPException(400, 'Format must be markdown, json, docx or pdf')
    data = _owned_snapshot(session_id, user['username'])
    body = markdown_export(data) if format == 'markdown' else json.dumps(data, ensure_ascii=False, indent=2)
    extension = 'md' if format == 'markdown' else 'json'
    return Response(body, media_type='text/markdown' if format == 'markdown' else 'application/json',
                    headers={'Content-Disposition': f'attachment; filename="conversation.{extension}"', 'Cache-Control': 'no-store'})


def _review_share(session_id, username, confirmed):
    from app import privacy_policy
    blocked, ask = privacy_policy.review_text(markdown_export(_owned_snapshot(session_id, username)), 'share')
    if blocked:
        raise HTTPException(403, {'code': 'personal_data_blocked', 'categories': blocked, 'message': 'Your data protection policy does not allow sharing this conversation.'}, headers={'X-Personal-Data-Review': 'blocked'})
    if ask and not confirmed:
        raise HTTPException(409, {'code': 'personal_data_share', 'categories': ask, 'message': 'This conversation may contain personal data.'}, headers={'X-Personal-Data-Review': 'download'})


@router.post('/sessions/{session_id}/share', status_code=201)
def share_conversation(session_id: str, request: Request, user: dict = Depends(current_user)):
    _review_share(session_id, user['username'], request.headers.get('x-personal-data-confirmed') == '1')
    data = _owned_snapshot(session_id, user['username'])
    token = secrets.token_urlsafe(32)
    with job_queue._connect() as db:
        _schema(db)
        db.execute('INSERT INTO bob_conversation_shares(token_hash,username,session_id,snapshot) VALUES (%s,%s,%s,%s::jsonb)',
                   (hashlib.sha256(token.encode()).hexdigest(), user['username'], session_id, json.dumps(data)))
    # A configured public address lets recipients reach the host even when
    # the sender accesses it through localhost or a development server.
    public_base = os.getenv('PUBLIC_BASE_URL', '').strip().rstrip('/')
    address = urlsplit(public_base)
    if address.scheme in {'http', 'https'} and address.hostname and address.hostname not in {'localhost', '127.0.0.1', '::1', '0.0.0.0'}:
        url = public_base + '/shared/' + session_id + '/' + token
    else:
        url = str(request.url_for('shared_session_conversation', session_id=session_id, token=token))
    return {'url': url, 'created_at': datetime.now(timezone.utc).isoformat()}


@router.delete('/sessions/{session_id}/share', status_code=204)
def revoke_shares(session_id: str, user: dict = Depends(current_user)):
    _owned_snapshot(session_id, user['username'])
    with job_queue._connect() as db:
        _schema(db)
        db.execute('DELETE FROM bob_conversation_shares WHERE username=%s AND session_id=%s', (user['username'], session_id))
    return Response(status_code=204)


SHARE_HEADERS = {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer'}


def _validate_share(token: str, session_id: str | None = None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise HTTPException(404, 'Share not found')
    if session_id is not None and not re.fullmatch(r'legacy|[a-f0-9]{32}', session_id):
        raise HTTPException(404, 'Share not found')


def _shared_shell(token: str, session_id: str | None = None):
    _validate_share(token, session_id)
    static = Path(__file__).parent / 'static'
    index = static / 'dist' / 'index.html'
    return FileResponse(index if index.is_file() else static / 'index.html', headers=SHARE_HEADERS)


@router.get('/shared/{token}')
def shared_conversation(token: str):
    return _shared_shell(token)


@router.get('/shared/{session_id}/{token}')
def shared_session_conversation(session_id: str, token: str):
    return _shared_shell(token, session_id)


def _shared_snapshot(token: str, session_id: str | None = None):
    _validate_share(token, session_id)
    with job_queue._connect() as db:
        _schema(db)
        row = db.execute('''SELECT s.snapshot, s.session_id FROM bob_conversation_shares s
            WHERE token_hash=%s AND (%s::text IS NULL OR s.session_id=%s)
            AND NOT EXISTS (SELECT 1 FROM bob_deleted_conversations d
            WHERE d.username=s.username AND d.workspace_id=s.session_id)''',
            (hashlib.sha256(token.encode()).hexdigest(), session_id, session_id)).fetchone()
    if not row:
        raise HTTPException(404, 'Share not found')
    return {**row['snapshot'], 'session_id': row['session_id']}


@router.get('/api/shared/{token}')
def shared_snapshot(token: str, user: dict = Depends(current_user)):
    return JSONResponse(_shared_snapshot(token), headers=SHARE_HEADERS)


@router.get('/api/shared/{session_id}/{token}')
def shared_session_snapshot(session_id: str, token: str, user: dict = Depends(current_user)):
    return JSONResponse(_shared_snapshot(token, session_id), headers=SHARE_HEADERS)
