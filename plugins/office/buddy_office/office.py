"""Private Office Suite Office files and authenticated ONLYOFFICE editing sessions."""
from __future__ import annotations

from contextlib import nullcontext

import hashlib
import io
import logging
import os
from pathlib import PurePath
from typing import Annotated
from threading import Lock
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import UUID, uuid4
from zipfile import ZipFile, BadZipFile
import time

import httpx
import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.auth import current_user
from app import job_queue
from app.s3_client import client as s3

router = APIRouter(prefix='/api/office', tags=['office'])
log = logging.getLogger(__name__)
MAX_BYTES = 50 * 1024 * 1024
MIME = {'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'csv': 'text/csv', 'pdf': 'application/pdf', 'html': 'text/html', 'htm': 'text/html'}
_schema_lock = Lock()
_schema_urls: set[str] = set()


def ensure_schema():
    database = os.environ['DATABASE_URL']
    with _schema_lock:
        if database in _schema_urls:
            return
        with job_queue._connect() as db:
            db.execute('CREATE SCHEMA IF NOT EXISTS "office"')
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_office_schema'))")
            db.execute('''CREATE TABLE IF NOT EXISTS office.bob_office_files (
                id UUID PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL,
                extension TEXT NOT NULL, object_key TEXT NOT NULL, size BIGINT NOT NULL,
                sha256 TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                saved_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('ALTER TABLE office.bob_office_files ADD COLUMN IF NOT EXISTS save_sequence INTEGER NOT NULL DEFAULT 0')
            db.execute('CREATE INDEX IF NOT EXISTS bob_office_owner ON office.bob_office_files(username,saved_at DESC)')
            db.execute('''CREATE TABLE IF NOT EXISTS office.bob_office_sessions (
                id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES office.bob_office_files(id),
                source_key TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
                last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('ALTER TABLE office.bob_office_sessions ADD COLUMN IF NOT EXISTS last_receipt TEXT')
            db.execute('CREATE UNIQUE INDEX IF NOT EXISTS bob_office_active ON office.bob_office_sessions(file_id) WHERE active')
            db.execute('''CREATE TABLE IF NOT EXISTS office.bob_office_shares (
                file_id UUID NOT NULL REFERENCES office.bob_office_files(id) ON DELETE CASCADE,
                username TEXT NOT NULL,
                permission TEXT NOT NULL CHECK (permission IN ('read','write')),
                granted_by TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY(file_id, username))''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_office_shares_user ON office.bob_office_shares(username)')
            db.execute("CREATE TABLE IF NOT EXISTS office.bob_app_action_receipts (username TEXT NOT NULL, action_key TEXT NOT NULL, digest TEXT NOT NULL, result JSONB NOT NULL, PRIMARY KEY(username,action_key))")
            from buddy_office.office_folders import migrate
            migrate(db)
        _schema_urls.add(database)


def secret():
    value = os.getenv('OFFICE_JWT_SECRET', '')
    if len(value) < 32:
        raise HTTPException(503, 'Office editor is not configured')
    return value


def require_storage():
    if not all(os.getenv(k) for k in ('BOB_S3_BUCKET', 'BOB_S3_ENDPOINT', 'BOB_S3_ACCESS_KEY_ID', 'BOB_S3_SECRET_ACCESS_KEY')):
        raise HTTPException(503, 'Office Suite storage is not configured')


def internal_url():
    return os.getenv('OFFICE_INTERNAL_URL', 'http://onlyoffice').rstrip('/')


def public_url():
    return os.getenv('OFFICE_PUBLIC_URL', '/office-editor').rstrip('/')


def callback_base():
    return os.getenv('OFFICE_CALLBACK_BASE_URL', 'http://bob-agent:8080').rstrip('/')


def same_origin(request: Request):
    origin = request.headers.get('origin')
    if origin and urlsplit(origin).netloc != request.headers.get('host'):
        raise HTTPException(403, 'Cross-origin writes are not allowed')


def _file(db, file_id, username, lock=False, require_write=False, require_owner=False):
    row = db.execute('SELECT * FROM office.bob_office_files WHERE id=%s AND username=%s' + (' FOR UPDATE' if lock else ''),
                     (str(file_id), username)).fetchone()
    if row:
        if isinstance(row, dict):
            return {**row, 'access': 'owner', 'is_owner': True}
        return row
    if require_owner:
        raise HTTPException(404, 'Office file not found')
    shared = db.execute('''SELECT f.*, s.permission AS share_permission
        FROM office.bob_office_files f
        JOIN office.bob_office_shares s ON s.file_id = f.id AND s.username = %s
        WHERE f.id = %s''' + (' FOR UPDATE OF f' if lock else ''),
        (username, str(file_id))).fetchone()
    if not shared:
        raise HTTPException(404, 'Office file not found')
    perm = shared.get('share_permission', 'read') if isinstance(shared, dict) else 'read'
    if require_write and perm != 'write':
        raise HTTPException(403, 'Read-only access: ask the file owner for write permission')
    if isinstance(shared, dict):
        return {**shared, 'access': perm, 'is_owner': False}
    return shared


def summary(row, current_username=None):
    owner = row.get('username')
    is_owner = row.get('is_owner', True if current_username is None else (owner == current_username))
    access = row.get('access') or ('owner' if is_owner else (row.get('share_permission') or 'read'))
    out = {key: str(row[key]) if key == 'id' else row[key] for key in
           ('id', 'name', 'extension', 'size', 'revision', 'save_sequence', 'created_at', 'saved_at')}
    out['folder_id'] = str(row['folder_id']) if is_owner and row.get('folder_id') else None
    out['owner'] = owner
    out['owner_display'] = row.get('owner_display') or owner
    out['is_owner'] = bool(is_owner)
    out['access'] = access
    if 'share_count' in row:
        out['share_count'] = int(row['share_count'] or 0)
    return out


def validate_content(raw, extension):
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, 'Office files must be 50 MB or smaller')
    if extension in ('html', 'htm'):
        from buddy_office.office_html import validate_html
        validate_html(raw)
        return
    if extension == 'pdf':
        from pypdf import PdfReader
        try:
            if not raw.startswith(b'%PDF-'):
                raise ValueError('Invalid PDF header')
            reader = PdfReader(io.BytesIO(raw))
            if reader.is_encrypted or not len(reader.pages):
                raise ValueError('PDF must be unlocked and contain pages')
        except Exception as exc:
            raise HTTPException(422, 'Upload a valid, unlocked PDF with at least one page') from exc
        return
    if extension == 'csv':
        if b'\x00' in raw[:4096]:
            raise HTTPException(422, 'CSV must be a text file; use UTF-8 encoding')
        return
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            required = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}[extension]
            if required not in archive.namelist() or '[Content_Types].xml' not in archive.namelist():
                raise ValueError('Invalid Office package')
            if sum(item.file_size for item in archive.infolist()) > 300 * 1024 * 1024:
                raise ValueError('Expanded Office file is too large')
    except (BadZipFile, ValueError):
        raise HTTPException(422, 'File content does not match its Office format')


def object_key(username, file_id, extension):
    return f'users/{quote(username, safe="")}/office/{file_id}/{uuid4().hex}.{extension}'


def put(raw, key, extension):
    digest = hashlib.sha256(raw).hexdigest()
    s3().put_object(Bucket=os.environ['BOB_S3_BUCKET'], Key=key, Body=raw,
                    ContentType=MIME[extension], Metadata={'sha256': digest})
    return digest


def read(key):
    result = s3().get_object(Bucket=os.environ['BOB_S3_BUCKET'], Key=key)
    stream = result['Body']
    try:
        raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise HTTPException(413, 'Office file exceeds the size limit')
        expected = result.get('Metadata', {}).get('sha256')
        if expected and hashlib.sha256(raw).hexdigest() != expected:
            raise HTTPException(502, 'Stored file checksum mismatch')
        return raw
    finally:
        stream.close()


def store_new(username, name, raw, folder_id=None, *, db=None):
    require_storage()
    name = PurePath(name.replace('\\', '/')).name.strip()
    if not name or len(name) > 200 or any(ord(c) < 32 for c in name):
        raise HTTPException(422, 'Enter a filename of 1 to 200 characters')
    extension = name.rsplit('.', 1)[-1].lower()
    if extension not in MIME:
        raise HTTPException(422, 'Supported formats: DOCX, XLSX, PPTX, CSV, PDF, HTML')
    validate_content(raw, extension)
    ensure_schema()
    file_id = uuid4()
    key = object_key(username, file_id, extension)
    from buddy_office.office_folders import lock_owner, destination
    with (nullcontext(db) if db is not None else job_queue._connect()) as db:
        lock_owner(db, username)
        destination(db, folder_id, username)
        digest = put(raw, key, extension)
        row = db.execute('''INSERT INTO office.bob_office_files(id,username,name,extension,object_key,size,sha256,folder_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
            (str(file_id), username, name, extension, key, len(raw), digest,
             str(folder_id) if folder_id else None)).fetchone()
    return summary(row, username)


@router.get('/status')
def status(user: dict = Depends(current_user)):
    require_storage()
    secret()
    try:
        with httpx.Client(timeout=5) as http:
            response = http.get(internal_url() + '/healthcheck')
            response.raise_for_status()
            if response.text.strip() != 'true':
                raise ValueError('Editor is starting')
        s3().list_objects_v2(Bucket=os.environ['BOB_S3_BUCKET'], Prefix=f'users/{quote(user["username"], safe="")}/office/', MaxKeys=1)
    except Exception as exc:
        log.warning('Office health check failed: %s', type(exc).__name__)
        raise HTTPException(503, 'Office editor or Office Suite is unavailable. Try again shortly.')
    return {'ready': True, 'storage': 'Office Suite', 'max_bytes': MAX_BYTES}


@router.get('/files')
def files(user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    with job_queue._connect() as db:
        rows = db.execute('''SELECT f.*,
            CASE WHEN f.username = %s THEN 'owner' ELSE s.permission END AS access,
            (f.username = %s) AS is_owner,
            COALESCE(NULLIF(btrim(p.display_name), ''), f.username) AS owner_display,
            (SELECT count(*) FROM office.bob_office_shares sc WHERE sc.file_id = f.id) AS share_count
            FROM office.bob_office_files f
            LEFT JOIN office.bob_office_shares s ON s.file_id = f.id AND s.username = %s
            LEFT JOIN bob_user_profiles p ON p.username = f.username
            WHERE f.username = %s OR s.username IS NOT NULL
            ORDER BY f.saved_at DESC''', (uname, uname, uname, uname)).fetchall()
    return {'items': [summary(row, uname) for row in rows]}


@router.get('/files/{file_id}')
def file_info(file_id: UUID, user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    with job_queue._connect() as db:
        row = _file(db, file_id, uname)
        session = db.execute('SELECT last_error,last_receipt FROM office.bob_office_sessions WHERE file_id=%s ORDER BY created_at DESC LIMIT 1', (str(file_id),)).fetchone()
    return {**summary(row, uname), 'save_error': session['last_error'] if session else None, 'save_receipt': session['last_receipt'] if session else None}


@router.delete('/files/{file_id}', dependencies=[Depends(same_origin)])
def delete_file(file_id: UUID, user: dict = Depends(current_user)):
    require_storage()
    ensure_schema()
    uname = user['username']
    with job_queue._connect() as db:
        row = _file(db, file_id, uname, lock=True, require_owner=True)
        owner = row['username']
        db.execute('DELETE FROM office.bob_office_shares WHERE file_id=%s', (str(file_id),))
        db.execute('DELETE FROM office.bob_office_sessions WHERE file_id=%s', (str(file_id),))
        db.execute('DELETE FROM office.bob_office_files WHERE id=%s AND username=%s', (str(file_id), uname))
    try:
        prefix = f'users/{quote(owner, safe="")}/office/{file_id}/'
        bucket = os.environ['BOB_S3_BUCKET']
        client = s3()
        for item in client.list_objects_v2(Bucket=bucket, Prefix=prefix).get('Contents', []):
            client.delete_object(Bucket=bucket, Key=item['Key'])
    except Exception as exc:
        log.warning('Failed cleaning S3 objects for deleted file %s: %s', file_id, type(exc).__name__)
    return {'deleted': True, 'id': str(file_id)}


class ShareRequest(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    permission: str = Field(pattern='^(read|write)$')


@router.get('/users')
def office_users(user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    now_ts = int(time.time())
    with job_queue._connect() as db:
        rows = db.execute('''SELECT u.username,
            COALESCE(CASE WHEN btrim(p.display_name) <> ''
                AND p.display_name NOT LIKE 'kc-%%' AND position('@' in p.display_name)=0
                THEN p.display_name END,
                CASE WHEN u.username LIKE 'kc-%%' OR position('@' in u.username)>0
                THEN COALESCE(NULLIF(btrim(p.email), ''), u.username) ELSE u.username END) AS display_name,
            p.email,
            EXISTS(SELECT 1 FROM sessions s WHERE s.username = u.username AND s.expires > %s) AS online
            FROM users u
            LEFT JOIN bob_user_profiles p ON p.username = u.username
            WHERE u.username <> %s
            ORDER BY online DESC, lower(COALESCE(p.display_name, u.username)), u.username''', (now_ts, uname)).fetchall()
    return {'items': [dict(r) for r in rows]}


@router.get('/files/{file_id}/shares')
def get_shares(file_id: UUID, user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    now_ts = int(time.time())
    with job_queue._connect() as db:
        _file(db, file_id, uname, require_owner=True)
        rows = db.execute('''SELECT s.username, s.permission, s.created_at,
            COALESCE(NULLIF(btrim(p.display_name), ''), s.username) AS display_name,
            p.email,
            EXISTS(SELECT 1 FROM sessions sess WHERE sess.username = s.username AND sess.expires > %s) AS online
            FROM office.bob_office_shares s
            LEFT JOIN bob_user_profiles p ON p.username = s.username
            WHERE s.file_id = %s
            ORDER BY s.created_at ASC''', (now_ts, str(file_id))).fetchall()
    return {'items': [dict(r) for r in rows]}


@router.post('/files/{file_id}/shares', dependencies=[Depends(same_origin)])
def set_share(file_id: UUID, req: ShareRequest, user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    target = req.username.strip()
    if target == uname:
        raise HTTPException(422, 'You already own this file')
    with job_queue._connect() as db:
        _file(db, file_id, uname, require_owner=True)
        exists = db.execute('SELECT 1 FROM users WHERE username=%s', (target,)).fetchone()
        if not exists:
            raise HTTPException(404, 'User not found')
        db.execute('''INSERT INTO office.bob_office_shares(file_id, username, permission, granted_by)
            VALUES(%s, %s, %s, %s)
            ON CONFLICT(file_id, username) DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by''',
            (str(file_id), target, req.permission, uname))
    return get_shares(file_id, user)


@router.delete('/files/{file_id}/shares/{target_username}', dependencies=[Depends(same_origin)])
def remove_share(file_id: UUID, target_username: str, user: dict = Depends(current_user)):
    ensure_schema()
    uname = user['username']
    with job_queue._connect() as db:
        _file(db, file_id, uname, require_owner=True)
        db.execute('DELETE FROM office.bob_office_shares WHERE file_id=%s AND username=%s', (str(file_id), target_username))
    return get_shares(file_id, user)


@router.post('/files', dependencies=[Depends(same_origin)])
async def upload(file: UploadFile = File(...), user: dict = Depends(current_user),
                 folder_id: Annotated[UUID | None, Form()] = None):
    raw = bytearray()
    try:
        while chunk := await file.read(1024 * 1024):
            raw.extend(chunk)
            if len(raw) > MAX_BYTES:
                raise HTTPException(413, 'Office files must be 50 MB or smaller')
        if folder_id is None:
            return await run_in_threadpool(store_new, user['username'], file.filename or '', bytes(raw))
        return await run_in_threadpool(store_new, user['username'], file.filename or '', bytes(raw), folder_id)
    finally:
        await file.close()


class NewFile(BaseModel):
    folder_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(pattern='^(word|excel|powerpoint|csv|pdf|form)$')


def blank_docx():
    output = io.BytesIO()
    with ZipFile(output, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')
    return output.getvalue()


def blank_pptx():
    from pathlib import Path
    template_path = Path(__file__).parent / 'static' / 'blank.pptx'
    return template_path.read_bytes()


@router.post('/create', dependencies=[Depends(same_origin)])
def create(req: NewFile, user: dict = Depends(current_user)):
    extension = {'word': 'docx', 'excel': 'xlsx', 'powerpoint': 'pptx', 'csv': 'csv', 'pdf': 'pdf', 'form': 'pdf'}[req.kind]
    name = req.name if req.name.lower().endswith('.' + extension) else req.name + '.' + extension
    if extension == 'docx':
        raw = blank_docx()
    elif extension == 'xlsx':
        from openpyxl import Workbook
        workbook = Workbook()
        buffer = io.BytesIO()
        workbook.save(buffer)
        raw = buffer.getvalue()
    elif extension == 'pptx':
        raw = blank_pptx()
    elif extension == 'pdf':
        from pypdf import PdfWriter
        buffer = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=595.28, height=841.89)
        writer.write(buffer)
        raw = buffer.getvalue()
    else:
        raw = b'\xef\xbb\xbf\r\n'
    if req.folder_id is None:
        return store_new(user['username'], name, raw)
    return store_new(user['username'], name, raw, req.folder_id)


@router.get('/files/{file_id}/download')
def download(file_id: UUID, user: dict = Depends(current_user)):
    require_storage()
    ensure_schema()
    with job_queue._connect() as db:
        row = _file(db, file_id, user['username'])
    return Response(read(row['object_key']), media_type=MIME[row['extension']], headers={
        'Content-Disposition': f"attachment; filename*=UTF-8''{quote(row['name'], safe='')}", 'Cache-Control': 'no-store'})


@router.post('/files/{file_id}/editor', dependencies=[Depends(same_origin)])
def editor(file_id: UUID, ui_language: str = 'en', user: dict = Depends(current_user), view_only: bool = False):
    if ui_language not in ('en', 'el', 'hi', 'mt'):
        raise HTTPException(422, 'Unsupported editor language')
    secret()
    require_storage()
    ensure_schema()
    uname = user['username']
    with job_queue._connect() as db:
        row = _file(db, file_id, uname, lock=True)
        if row['extension'] in ('html', 'htm'):
            raise HTTPException(422, 'Open HTML presentations in the HTML viewer')
        can_edit = not view_only and row.get('access', 'owner') in ('owner', 'write')
        session = db.execute('SELECT * FROM office.bob_office_sessions WHERE file_id=%s AND active', (str(file_id),)).fetchone()
        if not session:
            session = db.execute('''INSERT INTO office.bob_office_sessions(id,file_id,source_key) VALUES(%s,%s,%s) RETURNING *''',
                                 (str(uuid4()), str(file_id), row['object_key'])).fetchone()
    sid = str(session['id'])
    token = jwt.encode({'aud': 'office-source', 'sid': sid, 'exp': int(time.time()) + 86400}, secret(), algorithm='HS256')
    doc_type = 'pdf' if row['extension'] == 'pdf' else 'word' if row['extension'] in ('docx', 'html', 'htm') else ('slide' if row['extension'] == 'pptx' else 'cell')
    config = {
        'documentType': doc_type,
        'type': 'desktop', 'width': '100%', 'height': '100%',
        'document': {'fileType': row['extension'], 'key': sid, 'title': row['name'],
                     'url': callback_base() + f'/api/office/source/{sid}?token={token}',
                     'permissions': {'edit': can_edit, 'download': True, 'print': True, 'comment': can_edit, 'review': can_edit}},
        'editorConfig': {'mode': 'edit' if can_edit else 'view', 'lang': ui_language if ui_language in ('en', 'el') else 'en',
                         'plugins': {'autostart': ['asc.{A58B77D1-3407-4EC8-9282-52C1884E02F4}'], 'disable': ['asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}'],
                                     'pluginsData': ['/static/office-bridge/config.json']},
                         'callbackUrl': callback_base() + '/api/office/callback',
                         'user': {'id': user['username'], 'name': user.get('display_name') or user['username']},
                         'customization': {'forcesave': can_edit, 'autosave': can_edit, 'compactHeader': True, 'compactToolbar': True, 'toolbarHideFileName': True, 'logo': {'visible': False}}},
    }
    config['token'] = jwt.encode(config, secret(), algorithm='HS256')
    return {'script_url': public_url() + '/web-apps/apps/api/documents/api.js', 'config': config, 'file': summary(row, uname)}


@router.get('/source/{session_id}')
def source(session_id: UUID, token: str):
    try:
        claims = jwt.decode(token, secret(), algorithms=['HS256'], audience='office-source')
        if claims.get('sid') != str(session_id):
            raise ValueError('Wrong session')
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(403, 'Invalid document access token')
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('''SELECT s.source_key,f.extension FROM office.bob_office_sessions s
            JOIN office.bob_office_files f ON f.id=s.file_id WHERE s.id=%s AND s.active''', (str(session_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Editing session has ended')
    if row['extension'] in ('html', 'htm'):
        raise HTTPException(422, 'HTML presentations use the authenticated viewer')
    return Response(read(row['source_key']), media_type=MIME[row['extension']], headers={'Cache-Control': 'no-store'})


def output_url(url):
    """Accept only the configured editor cache, never a caller-selected host or redirect."""
    target = urlsplit(url)
    internal = urlsplit(internal_url())
    public = urlsplit(os.getenv('PUBLIC_BASE_URL', '').rstrip('/') + public_url() if public_url().startswith('/') else public_url())
    if target.username or target.password or target.fragment or target.scheme not in ('http', 'https'):
        raise ValueError('Invalid editor output URL')
    if (target.scheme, target.netloc) == (internal.scheme, internal.netloc):
        path = target.path
    elif (target.scheme, target.netloc) == (public.scheme, public.netloc) and target.path.startswith(public.path.rstrip('/') + '/'):
        path = target.path[len(public.path.rstrip('/')):]
    else:
        raise ValueError('Editor output must come from the configured document server')
    if not path.startswith('/cache/files/') or '..' in path or '%' in path or '\\' in path:
        raise ValueError('Invalid editor cache path')
    return urlunsplit((internal.scheme, internal.netloc, path, target.query, ''))


def saved_content(url):
    download_url = output_url(url)
    with httpx.Client(timeout=120, follow_redirects=False) as http:
        with http.stream('GET', download_url) as response:
            response.raise_for_status()
            raw = bytearray()
            for chunk in response.iter_bytes(1024 * 1024):
                raw.extend(chunk)
                if len(raw) > MAX_BYTES:
                    raise ValueError('Edited document exceeds 50 MB')
    return bytes(raw)


def convert_csv(url, original):
    import csv
    text = original.decode('utf-8-sig', errors='replace')[:8192]
    try:
        delimiter = csv.Sniffer().sniff(text, delimiters=',;\t:|').delimiter
    except csv.Error:
        delimiter = ','
    # The converter accepts a custom delimiter as well as the standard numeric choices.
    command = {'async': False, 'filetype': 'xlsx', 'outputtype': 'csv', 'key': uuid4().hex,
               'url': output_url(url), 'codePage': 65001,
               'delimiter': {'\t': 1, ';': 2, ':': 3, ',': 4}.get(delimiter, 0),
               'delimiterChar': delimiter}
    command['token'] = jwt.encode(command, secret(), algorithm='HS256')
    with httpx.Client(timeout=120) as http:
        response = http.post(internal_url() + '/converter', json=command)
        response.raise_for_status()
        result = response.json()
    if result.get('error') or not result.get('endConvert') or not result.get('fileUrl'):
        raise ValueError('The editor could not convert the saved workbook back to CSV')
    return saved_content(result['fileUrl'])


def handle_callback(payload):
    sid = str(UUID(payload['key']))
    state = payload.get('status')
    ensure_schema()
    try:
        with job_queue._connect() as db:
            session = db.execute('SELECT * FROM office.bob_office_sessions WHERE id=%s FOR UPDATE', (sid,)).fetchone()
            if not session:
                return {'error': 0}
            if not session['active']:
                return {'error': 0}  # A retried final callback cannot overwrite a newer session.
            if state in (2, 6):
                row = db.execute('SELECT * FROM office.bob_office_files WHERE id=%s FOR UPDATE', (session['file_id'],)).fetchone()
                if row['extension'] in ('html', 'htm'):
                    raise ValueError('HTML files use the authenticated content endpoint')
                raw = saved_content(payload['url'])
                # CSV can be converted to XLSX by the editor; never label XLSX bytes as CSV.
                extension = payload.get('filetype', row['extension'])
                if row['extension'] == 'csv' and extension == 'xlsx':
                    raw = convert_csv(payload['url'], read(row['object_key']))
                    extension = 'csv'
                if extension != row['extension']:
                    raise ValueError('Editor returned an unexpected file format')
                validate_content(raw, extension)
                digest = hashlib.sha256(raw).hexdigest()
                key = row['object_key']
                if digest != row['sha256']:
                    key = object_key(row['username'], row['id'], extension)
                    put(raw, key, extension)
                    db.execute('''UPDATE office.bob_office_files SET object_key=%s,size=%s,sha256=%s,
                        revision=revision+1,saved_at=now() WHERE id=%s''', (key, len(raw), digest, row['id']))
                db.execute('UPDATE office.bob_office_files SET save_sequence=save_sequence+1,saved_at=now() WHERE id=%s', (row['id'],))
                db.execute('UPDATE office.bob_office_sessions SET last_error=NULL,source_key=%s,last_receipt=%s WHERE id=%s', (key, payload.get('userdata'), sid))
            if state in (2, 4):
                db.execute('UPDATE office.bob_office_sessions SET active=false WHERE id=%s', (sid,))
            if state in (3, 7):
                db.execute('UPDATE office.bob_office_sessions SET last_error=%s WHERE id=%s', ('The document server could not save this file. Retry Save before closing.', sid))
        return {'error': 0}
    except Exception:
        log.exception('Office save failed for session %s', sid)
        with job_queue._connect() as db:
            db.execute('UPDATE office.bob_office_sessions SET last_error=%s WHERE id=%s',
                       ('Saving to Office Suite failed. Keep the editor open and retry Save.', sid))
        return {'error': 1}


@router.post('/callback')
async def callback(request: Request):
    if int(request.headers.get('content-length', '0')) > 1024 * 1024:
        raise HTTPException(413, 'Callback too large')
    raw = await request.body()
    if len(raw) > 1024 * 1024:
        raise HTTPException(413, 'Callback too large')
    import json
    try:
        body = json.loads(raw)
        token = request.headers.get('authorization', '').removeprefix('Bearer ') or body.get('token', '')
        claims = jwt.decode(token, secret(), algorithms=['HS256'], options={'verify_aud': False})
        if claims.get('operation') not in (None, 'callback'):
            raise ValueError('Wrong token purpose')
        payload = claims.get('payload', claims)
        if not isinstance(payload, dict) or 'status' not in payload or 'key' not in payload:
            raise ValueError('Missing signed callback')
        if any(body.get(key) != value for key, value in payload.items() if key not in ('exp', 'iat', 'operation')):
            raise ValueError('Callback differs from its signature')
        UUID(payload['key'])
    except (jwt.PyJWTError, ValueError, TypeError, AttributeError):
        raise HTTPException(403, 'Invalid editor callback signature')
    return await run_in_threadpool(handle_callback, payload)


@router.post('/files/{file_id}/save', dependencies=[Depends(same_origin)])
def force_save(file_id: UUID, user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        row = _file(db, file_id, user['username'], require_write=True)
        session = db.execute('SELECT id FROM office.bob_office_sessions WHERE file_id=%s AND active', (str(file_id),)).fetchone()
    if not session:
        raise HTTPException(409, 'Reopen the document to start an editing session')
    receipt = uuid4().hex
    command = {'c': 'forcesave', 'key': str(session['id']), 'userdata': receipt}
    command['token'] = jwt.encode(command, secret(), algorithm='HS256')
    try:
        with httpx.Client(timeout=30) as http:
            result = http.post(internal_url() + '/coauthoring/CommandService.ashx', json=command)
            result.raise_for_status()
            error = result.json().get('error')
    except httpx.HTTPError:
        raise HTTPException(502, 'The editor could not be reached. Keep this document open and retry.')
    if error not in (0, 4):
        raise HTTPException(502, 'The editor could not save this document. Retry before closing.')
    return {'pending': error == 0, 'unchanged': error == 4, 'revision': row['revision'], 'receipt': receipt}


class HTMLContent(BaseModel):
    html: str = Field(max_length=MAX_BYTES)
    revision: int = Field(ge=1)


@router.get('/files/{file_id}/content')
def html_content(file_id: UUID, user: dict = Depends(current_user)):
    require_storage()
    ensure_schema()
    with job_queue._connect() as db:
        row = _file(db, file_id, user['username'])
    if row['extension'] not in ('html', 'htm'):
        raise HTTPException(422, 'This file is not an HTML presentation')
    from buddy_office.office_html import validate_html
    return {'html': validate_html(read(row['object_key'])), 'revision': row['revision']}


@router.put('/files/{file_id}/content', dependencies=[Depends(same_origin)])
def save_html_content(file_id: UUID, req: HTMLContent, user: dict = Depends(current_user)):
    require_storage()
    ensure_schema()
    raw = req.html.encode('utf-8')
    validate_content(raw, 'html')
    with job_queue._connect() as db:
        row = _file(db, file_id, user['username'], lock=True, require_write=True)
        if row['extension'] not in ('html', 'htm'):
            raise HTTPException(422, 'This file is not an HTML presentation')
        if row['revision'] != req.revision:
            raise HTTPException(409, 'This presentation changed. Reload before saving your edits.')
        key = object_key(row['username'], row['id'], row['extension'])
        digest = put(raw, key, row['extension'])
        updated = db.execute('''UPDATE office.bob_office_files SET object_key=%s,size=%s,sha256=%s,
            revision=revision+1,save_sequence=save_sequence+1,saved_at=now() WHERE id=%s RETURNING *''',
            (key, len(raw), digest, row['id'])).fetchone()
    return summary(updated, user['username'])


class NewFolder(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: UUID | None = None


class FolderChanges(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parent_id: UUID | None = None


class FileFolder(BaseModel):
    folder_id: UUID | None


@router.get('/folders')
def folders(user: dict = Depends(current_user)):
    ensure_schema()
    from buddy_office.office_folders import summary as folder_summary
    with job_queue._connect() as db:
        rows = db.execute('SELECT * FROM office.bob_office_folders WHERE username=%s ORDER BY lower(name),id',
                          (user['username'],)).fetchall()
    return {'items': [folder_summary(row) for row in rows]}


@router.post('/folders', dependencies=[Depends(same_origin)])
def create_folder(req: NewFolder, user: dict = Depends(current_user)):
    ensure_schema()
    from buddy_office.office_folders import create as create_metadata
    with job_queue._connect() as db:
        return create_metadata(db, user['username'], req.name, req.parent_id)


@router.patch('/folders/{folder_id}', dependencies=[Depends(same_origin)])
def update_folder(folder_id: UUID, req: FolderChanges, user: dict = Depends(current_user)):
    ensure_schema()
    from buddy_office.office_folders import update as update_metadata
    with job_queue._connect() as db:
        return update_metadata(db, user['username'], folder_id, req.model_dump(exclude_unset=True))


@router.delete('/folders/{folder_id}', dependencies=[Depends(same_origin)])
def delete_folder(folder_id: UUID, user: dict = Depends(current_user)):
    ensure_schema()
    from buddy_office.office_folders import delete as delete_metadata
    with job_queue._connect() as db:
        return delete_metadata(db, user['username'], folder_id)


@router.patch('/files/{file_id}/folder', dependencies=[Depends(same_origin)])
def move_file(file_id: UUID, req: FileFolder, user: dict = Depends(current_user)):
    ensure_schema()
    from buddy_office.office_folders import lock_owner, destination
    with job_queue._connect() as db:
        lock_owner(db, user['username'])
        _file(db, file_id, user['username'], lock=True, require_owner=True)
        destination(db, req.folder_id, user['username'])
        row = db.execute('''UPDATE office.bob_office_files SET folder_id=%s WHERE id=%s AND username=%s RETURNING *''',
            (str(req.folder_id) if req.folder_id else None, str(file_id), user['username'])).fetchone()
    return summary(row, user['username'])


class RenameFile(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch('/files/{file_id}', dependencies=[Depends(same_origin)])
@router.patch('/files/{file_id}/name', dependencies=[Depends(same_origin)])
def rename_file(file_id: UUID, req: RenameFile, user: dict = Depends(current_user)):
    ensure_schema()
    name = PurePath(req.name.replace('\\', '/')).name.strip()
    if not name or any(ord(c) < 32 for c in name):
        raise HTTPException(422, 'Enter a filename of 1 to 200 characters')
    with job_queue._connect() as db:
        file_row = _file(db, file_id, user['username'], lock=True, require_owner=True)
        ext = file_row['extension']
        if not name.lower().endswith('.' + ext.lower()):
            name = f"{name}.{ext}"
        if len(name) > 200:
            raise HTTPException(422, 'Enter a filename of 1 to 200 characters')
        row = db.execute('''UPDATE office.bob_office_files SET name=%s WHERE id=%s AND username=%s RETURNING *''',
            (name, str(file_id), user['username'])).fetchone()
    return summary(row, user['username'])


class ImportConversationFile(BaseModel):
    session_id: str = Field(pattern=r'^(legacy|[a-f0-9]{32})$')
    path: str = Field(min_length=1, max_length=500)
    folder_id: UUID | None = None


@router.post('/import-conversation', dependencies=[Depends(same_origin)])
def import_conversation_file(req: ImportConversationFile, user: dict = Depends(current_user)):
    from app.sessions import storage_scope
    from app import postgres_storage as storage
    try:
        scope = storage_scope(req.session_id, user['username'])
        storage.validate_path(req.path)
        saved = storage.get_file(user['username'], scope, req.path)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, 'Conversation file not found') from exc
    if not saved:
        raise HTTPException(404, 'Conversation file not found')
    # store_new validates content, format, destination ownership and storage availability.
    return store_new(user['username'], PurePath(req.path).name, saved['content'], req.folder_id)


class ChatContextRequest(BaseModel):
    file_ids: list[UUID] = Field(max_length=3)


@router.post('/chat-context', dependencies=[Depends(same_origin)])
async def office_chat_context(req: ChatContextRequest, user: dict = Depends(current_user)):
    from buddy_office.office_chat import chat_context
    context, references = await run_in_threadpool(chat_context, user['username'], req.file_ids)
    return {'context': context, 'references': references}
