"""Owner-only note history and bounded private binary attachments."""
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from app.auth import current_user
from app import job_queue

router = APIRouter()
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


def notes_module():
    from app import notes
    notes.ensure_schema()
    return notes


@router.get('/{note_id}/versions')
def list_versions(note_id: int, limit: int = Query(default=100, ge=1, le=200), user: dict = Depends(current_user)):
    notes = notes_module()
    with job_queue._connect() as db:
        notes.owned_note(db, note_id, user['username'])
        rows = db.execute('SELECT id,note_id,snapshot,created_at FROM bob_note_versions WHERE note_id=%s ORDER BY id DESC LIMIT %s', (note_id, limit)).fetchall()
    return {'items': [{**row, 'created_at': row['created_at'].isoformat()} for row in rows]}


@router.post('/{note_id}/versions/{version_id}/restore')
def restore_version(note_id: int, version_id: int, user: dict = Depends(current_user)):
    notes = notes_module()
    with job_queue._connect() as db:
        current = notes.owned_note(db, note_id, user['username'], lock=True)
        version = db.execute('SELECT snapshot FROM bob_note_versions WHERE note_id=%s AND id=%s', (note_id, version_id)).fetchone()
        if not version: raise HTTPException(404, 'Note version not found')
        # Revalidate stored snapshots before restoring; provenance stays immutable.
        snapshot = notes.NoteContent(**version['snapshot']).model_dump(mode='json')
        notes.save_version(db, current)
        row = notes.apply_changes(db, note_id, user['username'], snapshot)
    return notes.serialize(row)


def attachment_metadata(row):
    return {key: row[key].isoformat() if key == 'created_at' else row[key]
            for key in ('id', 'filename', 'content_type', 'size', 'created_at')}


def safe_filename(value):
    value = re.split(r'[/\\]', value or 'attachment')[-1]
    value = re.sub(r'[\x00-\x1f\x7f]', '', value).strip().strip('.')[:180]
    return value or 'attachment'


@router.get('/{note_id}/attachments')
def list_attachments(note_id: int, user: dict = Depends(current_user)):
    notes = notes_module()
    with job_queue._connect() as db:
        notes.owned_note(db, note_id, user['username'])
        rows = db.execute('SELECT id,filename,content_type,size,created_at FROM bob_note_attachments WHERE note_id=%s ORDER BY id', (note_id,)).fetchall()
    return {'items': [attachment_metadata(row) for row in rows]}


@router.post('/{note_id}/attachments', status_code=201)
def upload_attachment(note_id: int, file: UploadFile = File(...), user: dict = Depends(current_user)):
    notes = notes_module()
    try:
        with job_queue._connect() as db:
            # Lock the parent so concurrent uploads cannot exceed the per-note cap.
            notes.owned_note(db, note_id, user['username'], lock=True)
            count = db.execute('SELECT count(*) AS count FROM bob_note_attachments WHERE note_id=%s', (note_id,)).fetchone()['count']
            if count >= 20: raise HTTPException(409, 'Each note supports up to 20 attachments')
            content = file.file.read(MAX_ATTACHMENT_BYTES + 1)
            if len(content) > MAX_ATTACHMENT_BYTES: raise HTTPException(413, 'Attachments must be 10 MB or smaller')
            filename = safe_filename(file.filename)
            # Downloads always use octet-stream; provided types are descriptive only.
            content_type = re.sub(r'[^a-zA-Z0-9.+/;= -]', '', file.content_type or 'application/octet-stream')[:120]
            row = db.execute('''INSERT INTO bob_note_attachments(note_id,filename,content_type,size,content)
                VALUES (%s,%s,%s,%s,%s) RETURNING id,filename,content_type,size,created_at''',
                (note_id, filename, content_type, len(content), content)).fetchone()
        return attachment_metadata(row)
    finally:
        file.file.close()


@router.get('/{note_id}/attachments/{attachment_id}')
def download_attachment(note_id: int, attachment_id: int, user: dict = Depends(current_user)):
    notes = notes_module()
    with job_queue._connect() as db:
        notes.owned_note(db, note_id, user['username'])
        row = db.execute('SELECT filename,content FROM bob_note_attachments WHERE note_id=%s AND id=%s', (note_id, attachment_id)).fetchone()
    if not row: raise HTTPException(404, 'Attachment not found')
    return Response(bytes(row['content']), media_type='application/octet-stream', headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(row['filename'], safe=''),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control':'private, no-store'})


@router.delete('/{note_id}/attachments/{attachment_id}', status_code=204)
def delete_attachment(note_id: int, attachment_id: int, user: dict = Depends(current_user)):
    notes = notes_module()
    with job_queue._connect() as db:
        notes.owned_note(db, note_id, user['username'], lock=True)
        row = db.execute('DELETE FROM bob_note_attachments WHERE note_id=%s AND id=%s RETURNING id', (note_id, attachment_id)).fetchone()
    if not row: raise HTTPException(404, 'Attachment not found')
    return Response(status_code=204)
