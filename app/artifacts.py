"""Editable workspace artifacts with atomic, owned, bounded revision history."""
from __future__ import annotations
import hashlib
import json
from datetime import datetime, timezone
from pathlib import PurePosixPath
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from app.auth import current_user
from app import postgres_storage as storage
from app.sessions import storage_scope
from app.presentation import artifact_role
from app.artifact_provenance import generated_provenance

router = APIRouter(prefix='/sessions/{session_id}/artifacts', tags=['artifacts'])
EXTENSIONS = {'.bobdeck': 'bobdeck', '.html': 'html', '.htm': 'html', '.jsx': 'react', '.tsx': 'react', '.mmd': 'mermaid', '.mermaid': 'mermaid', '.md': 'markdown', '.txt': 'text', '.css': 'text', '.js': 'text', '.ts': 'text', '.json': 'text', '.svg': 'html'}
LIMIT = 2_000_000

class ArtifactSave(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=LIMIT)
    expected_sha256: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')

class ArtifactRestore(BaseModel):
    path: str
    revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')

def scope_for(username, session_id):
    try: return storage_scope(session_id, username)
    except (ValueError, FileNotFoundError) as exc: raise HTTPException(404, 'Conversation not found') from exc

def validate(path):
    storage.validate_path(path)
    if PurePosixPath(path).suffix.lower() not in EXTENSIONS: raise ValueError('Unsupported artifact format')

def history_path(path):
    return '.bob/artifacts/' + hashlib.sha256(path.encode()).hexdigest() + '.json'

def read(username, session_id, path):
    scope = scope_for(username, session_id)
    validate(path)
    row = storage.get_file(username, scope, path)
    if not row: raise HTTPException(404, 'Artifact not found')
    if len(row['content']) > LIMIT: raise HTTPException(413, 'Artifact exceeds 2 MB')
    versions = history(username, session_id, path)
    match = next((v for v in reversed(versions) if v['id'] == row['sha256']), None)
    provenance = match.get('provenance') if match else None
    if provenance is None:
        provenance = generated_provenance(username, session_id, path, row['sha256'])
    return {'provenance': provenance, 'path': path, 'content': row['content'].decode('utf-8'), 'sha256': row['sha256'], 'kind': EXTENSIONS[PurePosixPath(path).suffix.lower()], **artifact_role(path, row['content'])}

def history(username, session_id, path):
    scope = scope_for(username, session_id)
    validate(path)
    row = storage.get_file(username, scope, history_path(path), internal=True)
    versions = json.loads(row['content']) if row else []
    for version in versions:
        if 'provenance' not in version:
            version['provenance'] = generated_provenance(username, session_id, path, version['id'])
    return versions

def save(username, session_id, req, revision=None):
    scope = scope_for(username, session_id)
    validate(req.path)
    with storage.mutation(username, scope, session_id) as db:
        row = db.execute('SELECT content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s', (username, scope, req.path)).fetchone()
        if row and row['sha256'] != req.expected_sha256: raise HTTPException(409, 'Artifact changed. Reload before saving.')
        if not row and req.expected_sha256: raise HTTPException(409, 'Artifact no longer exists.')
        saved = db.execute('SELECT content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s', (username, scope, history_path(req.path))).fetchone()
        versions = json.loads(storage.blob_storage.read(saved)) if saved else []
        content = req.content
        if revision:
            match = next((v for v in reversed(versions) if v['id'] == revision), None)
            if not match: raise HTTPException(404, 'Revision not found')
            content = match['content']
        raw = content.encode('utf-8')
        if len(raw) > LIMIT: raise HTTPException(413, 'Artifact exceeds 2 MB')
        def append(data, provenance=None):
            digest = hashlib.sha256(data).hexdigest()
            if not versions or versions[-1]['id'] != digest:
                versions.append({'id': digest, 'created': provenance.get('created_at') if provenance else datetime.now(timezone.utc).isoformat(), 'content': data.decode('utf-8'), 'provenance': provenance})
        if row:
            row['content'] = storage.blob_storage.read(row)
            if len(row['content']) > LIMIT: raise HTTPException(413, 'Artifact exceeds 2 MB')
            existing_provenance = generated_provenance(username, session_id, req.path, row['sha256'], db=db) if not versions or versions[-1]['id'] != row['sha256'] else versions[-1].get('provenance')
            append(bytes(row['content']), existing_provenance)
        provenance = {'origin': 'restored' if revision else 'manual', 'workspace_id': session_id, 'chat_id': session_id, 'path': req.path, 'sha256': hashlib.sha256(raw).hexdigest(), 'created_at': datetime.now(timezone.utc).isoformat()}
        if revision:
            source_provenance = match.get('provenance') or generated_provenance(username, session_id, req.path, revision, db=db)
            provenance.update(restored_from=revision, source_provenance={key: value for key, value in source_provenance.items() if key != 'source_provenance'} if source_provenance else None)
        append(raw, provenance)
        storage._upsert(db, username, scope, req.path, raw)
        storage._upsert(db, username, scope, history_path(req.path), json.dumps(versions[-40:]).encode())
    return {'provenance': versions[-1].get('provenance'), 'path': req.path, 'content': content, 'sha256': hashlib.sha256(raw).hexdigest(), 'kind': EXTENSIONS[PurePosixPath(req.path).suffix.lower()], **artifact_role(req.path, content)}

def live_artifacts(username, session_id):
    from app import job_queue
    scope_for(username,session_id)
    with job_queue._connect() as db:
        rows=db.execute("""SELECT DISTINCT ON (e.event->>'path') e.event FROM bob_job_events e
            JOIN bob_jobs j ON j.id=e.job_id WHERE j.username=%s AND j.workspace_id=%s
            AND j.status='running' AND e.event->>'type'='artifact'
            ORDER BY e.event->>'path',e.id DESC LIMIT 25""",(username,session_id)).fetchall()
    return [row['event'] for row in rows]


async def invoke(fn, *args):
    try: return await run_in_threadpool(fn, *args)
    except UnicodeDecodeError as exc: raise HTTPException(400, 'Artifact must contain UTF-8 text') from exc
    except ValueError as exc: raise HTTPException(409 if 'active' in str(exc) or 'deleted' in str(exc) else 400, str(exc)) from exc
    except FileNotFoundError as exc: raise HTTPException(404, str(exc)) from exc

@router.get('')
async def list_artifacts(session_id: str, user: dict = Depends(current_user)):
    rows = await invoke(storage.list_files, user['username'], scope_for(user['username'], session_id))
    live = await invoke(live_artifacts, user['username'], session_id)
    saved = [{**row, 'kind': EXTENSIONS[PurePosixPath(row['path']).suffix.lower()]} for row in rows if not row['path'].startswith('document-text/') and PurePosixPath(row['path']).name != 'AGENTS.md' and PurePosixPath(row['path']).suffix.lower() in EXTENSIONS and row['size'] <= LIMIT]
    for row in saved:
        source = await invoke(read, user['username'], session_id, row['path'])
        row.update({key: source[key] for key in ('is_presentation', 'role')})
    by_path={row['path']:row for row in saved}
    by_path.update({item['path']:{'path':item['path'],'kind':item['kind'],'live':True,**artifact_role(item['path'],item.get('content',''))} for item in live})
    return [row for row in by_path.values() if not row.get('is_presentation')]

@router.get('/source')
async def source(session_id: str, path: str, user: dict = Depends(current_user)):
    validate(path)
    live = await invoke(live_artifacts, user['username'], session_id)
    item = next((item for item in live if item['path']==path),None)
    return item or await invoke(read, user['username'], session_id, path)

@router.get('/history')
async def revisions(session_id: str, path: str, user: dict = Depends(current_user)):
    rows = await invoke(history, user['username'], session_id, path)
    return [{key: row[key] for key in ('id', 'created', 'provenance') if key in row} for row in reversed(rows)]

@router.get('/revision')
async def revision_source(session_id: str, path: str, revision: str = Query(pattern=r'^[a-f0-9]{64}$'), user: dict = Depends(current_user)):
    rows = await invoke(history, user['username'], session_id, path)
    match = next((row for row in reversed(rows) if row['id'] == revision), None)
    if not match:
        raise HTTPException(404, 'Revision not found')
    if len(match['content'].encode('utf-8')) > LIMIT:
        raise HTTPException(413, 'Artifact exceeds 2 MB')
    return {**match, 'path': path}

@router.put('/source')
async def update(session_id: str, req: ArtifactSave, user: dict = Depends(current_user)):
    return await invoke(save, user['username'], session_id, req)

@router.post('/restore')
async def restore(session_id: str, req: ArtifactRestore, user: dict = Depends(current_user)):
    return await invoke(save, user['username'], session_id, ArtifactSave(path=req.path, content='', expected_sha256=req.expected_sha256), req.revision)


def capture_generated_revisions(username, session_id, scope, db):
    """Called inside the leased workspace persistence transaction, after save_tree.

    Only final stored bytes with an exact durable artifact event become revisions.
    Draft snapshots and unattributed existing files are excluded.
    """
    rows = db.execute("SELECT path,content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path NOT LIKE '.%%'", (username, scope)).fetchall()
    for row in rows:
        path = row['path']
        if PurePosixPath(path).suffix.lower() not in EXTENSIONS or (row.get('size') or 0) > LIMIT:
            continue
        provenance = generated_provenance(username, session_id, path, row['sha256'], db=db)
        if not provenance:
            continue
        saved = db.execute('SELECT content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s', (username, scope, history_path(path))).fetchone()
        versions = json.loads(storage.blob_storage.read(saved)) if saved else []
        if versions and versions[-1]['id'] == row['sha256']:
            continue
        raw = storage.blob_storage.read(row)
        if len(raw) > LIMIT:
            continue
        try:
            content = raw.decode('utf-8')
        except UnicodeDecodeError:
            continue
        versions.append({'id': row['sha256'], 'created': provenance['created_at'], 'content': content, 'provenance': provenance})
        storage._upsert(db, username, scope, history_path(path), json.dumps(versions[-40:]).encode())
