"""Private sticky notes saved independently of their source conversations."""
from threading import Lock
from typing import Literal
from datetime import datetime, timezone
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator, model_validator, HttpUrl
from psycopg.types.json import Jsonb
from app import job_queue, sessions
from app.auth import current_user

router = APIRouter(prefix='/api/notes', tags=['notes'])
_lock = Lock()
_ready = False
NoteColor = Literal['butter', 'rose', 'lavender', 'mint', 'sky']


def ensure_schema():
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        with job_queue._connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_notes_schema'))")
            db.execute('''CREATE TABLE IF NOT EXISTS bob_notes (
                id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL,
                title TEXT NOT NULL, body TEXT NOT NULL,
                color TEXT NOT NULL CHECK(color IN ('butter','rose','lavender','mint','sky')),
                source_session_id TEXT, source_message_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_notes_owner ON bob_notes(username,id DESC)')
            db.execute("ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT ''")
            db.execute('ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS source_note_index INTEGER CHECK(source_note_index BETWEEN 0 AND 11)')
            db.execute("ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb")
            db.execute('ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false')
            db.execute("ALTER TABLE bob_notes ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb")
            db.execute('''CREATE TABLE IF NOT EXISTS bob_note_versions (
                id BIGSERIAL PRIMARY KEY, note_id BIGINT NOT NULL REFERENCES bob_notes(id) ON DELETE CASCADE,
                snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_note_versions_note ON bob_note_versions(note_id,id DESC)')
            db.execute('''CREATE TABLE IF NOT EXISTS bob_note_attachments (
                id BIGSERIAL PRIMARY KEY, note_id BIGINT NOT NULL REFERENCES bob_notes(id) ON DELETE CASCADE,
                filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
                content BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_note_attachments_note ON bob_note_attachments(note_id,id)')
        _ready = True


class NoteSource(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    url: HttpUrl = Field(max_length=2048)

    @field_validator('title')
    @classmethod
    def clean_title(cls, value):
        if not value.strip(): raise ValueError('Enter a source title')
        return value.strip()


class NoteContent(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=20000)
    color: NoteColor = 'butter'
    collection: str = Field(default='', max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=20)
    favorite: bool = False
    sources: list[NoteSource] = Field(default_factory=list, max_length=20)

    @field_validator('tags')
    @classmethod
    def normalize_tags(cls, values):
        tags = []
        seen = set()
        for value in values:
            value = value.strip().lstrip('#').strip()
            if not value or len(value) > 40:
                raise ValueError('Tags must contain 1 to 40 characters')
            if value.casefold() not in seen:
                tags.append(value); seen.add(value.casefold())
        return tags

    @field_validator('collection')
    @classmethod
    def clean_collection(cls, value):
        return value.strip()

    @field_validator('title', 'body')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Enter a note title and content')
        return value.strip()


class NoteCreate(NoteContent):
    source_session_id: str | None = Field(default=None, min_length=1, max_length=32)
    source_message_id: str | None = Field(default=None, min_length=1, max_length=200)
    source_note_index: int | None = Field(default=None, ge=0, le=11)


class NotePatch(NoteContent):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    body: str | None = Field(default=None, min_length=1, max_length=20000)
    color: NoteColor | None = None
    collection: str | None = Field(default=None, max_length=80)
    tags: list[str] | None = Field(default=None, max_length=20)
    favorite: bool | None = None
    sources: list[NoteSource] | None = Field(default=None, max_length=20)

    @model_validator(mode='before')
    @classmethod
    def no_null_fields(cls, values):
        if isinstance(values, dict) and any(value is None for value in values.values()):
            raise ValueError('Note fields cannot be null')
        return values


def default_collection():
    try:
        zone = ZoneInfo(os.environ.get('DEFAULT_TIMEZONE', 'UTC'))
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    return datetime.now(zone).date().isoformat()


def serialize(row):
    # Never expose the ownership column in API payloads.
    result = {key: (row[key].isoformat() if key in ('created_at', 'updated_at') else row[key])
            for key in ('id', 'title', 'body', 'color', 'collection', 'source_session_id', 'source_message_id', 'source_note_index', 'created_at', 'updated_at')}
    return {**result, 'tags':row.get('tags', []), 'favorite':row.get('favorite', False), 'sources':row.get('sources', [])}


EDITABLE_FIELDS = ('title', 'body', 'color', 'collection', 'tags', 'favorite', 'sources')
_NOTE_COLUMNS = frozenset(EDITABLE_FIELDS)


def owned_note(db, note_id, username, *, lock=False):
    row = db.execute('SELECT * FROM bob_notes WHERE username=%s AND id=%s' + (' FOR UPDATE' if lock else ''), (username, note_id)).fetchone()
    if not row: raise HTTPException(404, 'Note not found')
    return row


def save_version(db, row):
    snapshot = {key: serialize(row)[key] for key in EDITABLE_FIELDS}
    latest = db.execute('SELECT snapshot FROM bob_note_versions WHERE note_id=%s ORDER BY id DESC LIMIT 1', (row['id'],)).fetchone()
    if not latest or latest['snapshot'] != snapshot:
        db.execute('INSERT INTO bob_note_versions(note_id,snapshot) VALUES (%s,%s)', (row['id'], Jsonb(snapshot)))


def apply_changes(db, note_id, username, values):
    unknown = set(values) - _NOTE_COLUMNS
    if unknown:
        raise ValueError(f'Unknown note fields: {unknown}')
    params = []
    for key in EDITABLE_FIELDS:
        value = values.get(key)
        params.extend((key in values, Jsonb(value) if key in values and key in ('tags', 'sources') else value))
    return db.execute('''UPDATE bob_notes SET
        title=CASE WHEN %s THEN %s ELSE title END,
        body=CASE WHEN %s THEN %s ELSE body END,
        color=CASE WHEN %s THEN %s ELSE color END,
        collection=CASE WHEN %s THEN %s ELSE collection END,
        tags=CASE WHEN %s THEN %s ELSE tags END,
        favorite=CASE WHEN %s THEN %s ELSE favorite END,
        sources=CASE WHEN %s THEN %s ELSE sources END,
        updated_at=now() WHERE username=%s AND id=%s RETURNING *''',
                      (*params, username, note_id)).fetchone()


@router.get('')
def list_notes(limit: int = Query(default=100, ge=1, le=200), before_id: int | None = Query(default=None, ge=1), user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        rows = db.execute('SELECT * FROM bob_notes WHERE username=%s' + (' AND id<%s' if before_id else '') + ' ORDER BY id DESC LIMIT %s',
                          (user['username'], *((before_id,) if before_id else ()), limit + 1)).fetchall()
    items = rows[:limit]
    return {'items': [serialize(row) for row in items], 'next_before_id': items[-1]['id'] if len(rows) > limit else None,
            'default_collection': default_collection()}


@router.post('/workspace', status_code=201)
def create_enrichment_workspace(user: dict = Depends(current_user)):
    return sessions.create_session(user['username'], purpose='note_enrichment')


@router.post('', status_code=201)
def create_note(body: NoteCreate, user: dict = Depends(current_user)):
    collection = body.collection if 'collection' in body.model_fields_set else default_collection()
    if body.source_session_id:
        try:
            sessions.get_session(body.source_session_id, user['username'])
        except (ValueError, FileNotFoundError):
            raise HTTPException(404, 'Source conversation not found')
    ensure_schema()
    with job_queue._connect() as db:
        if body.source_session_id and body.source_message_id:
            # Serialize retries for this user's source before checking exact content.
            # The transaction lock makes concurrent saves observe the first insert.
            import json
            source_key = json.dumps([user['username'], body.source_session_id, body.source_message_id])
            db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ('sticky-note:' + source_key,))
            if body.source_note_index is not None:
                existing = db.execute('''SELECT * FROM bob_notes WHERE username=%s AND source_session_id=%s
                    AND source_message_id=%s AND source_note_index=%s ORDER BY id LIMIT 1''',
                    (user['username'], body.source_session_id, body.source_message_id, body.source_note_index)).fetchone()
            else:
                existing = None
            if not existing:
                existing = db.execute('''SELECT * FROM bob_notes WHERE username=%s AND source_session_id=%s
                    AND source_message_id=%s AND title=%s AND body=%s AND color=%s
                    AND source_note_index IS NULL ORDER BY id LIMIT 1''',
                    (user['username'], body.source_session_id, body.source_message_id, body.title, body.body, body.color)).fetchone()
                if existing and body.source_note_index is not None:
                    existing = db.execute('UPDATE bob_notes SET source_note_index=%s WHERE username=%s AND id=%s RETURNING *',
                                          (body.source_note_index, user['username'], existing['id'])).fetchone()
            if existing:
                return serialize(existing)
        row = db.execute('''INSERT INTO bob_notes(username,title,body,color,source_session_id,source_message_id,collection,source_note_index,tags,favorite,sources)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
            (user['username'], body.title, body.body, body.color, body.source_session_id, body.source_message_id, collection, body.source_note_index,
             Jsonb(body.tags), body.favorite, Jsonb([source.model_dump(mode='json') for source in body.sources]))).fetchone()
    return serialize(row)


@router.patch('/{note_id}')
def update_note(note_id: int, body: NotePatch, user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        row = owned_note(db, note_id, user['username'], lock=True)
        values = body.model_dump(mode='json', exclude_unset=True)
        if values and any(row.get(key) != value for key, value in values.items()):
            save_version(db, row)
            row = apply_changes(db, note_id, user['username'], values)
    return serialize(row)


@router.delete('/{note_id}', status_code=204)
def delete_note(note_id: int, user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('DELETE FROM bob_notes WHERE username=%s AND id=%s RETURNING id', (user['username'], note_id)).fetchone()
    if not row:
        raise HTTPException(404, 'Note not found')
    return Response(status_code=204)


from app.note_details import router as details_router
router.include_router(details_router)

from app.note_integration import router as integration_router
router.include_router(integration_router)
