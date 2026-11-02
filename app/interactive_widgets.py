"""Owner-scoped interactive answer state and explicitly invoked note actions."""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from psycopg.types.json import Jsonb

from app import email_review, job_queue, notes, sessions, smtp_settings
from app.auth import current_user

router = APIRouter(prefix='/api/interactive', tags=['interactive'])
_HASH = r'^[a-f0-9]{64}$'


class CalculatorValues(BaseModel):
    model_config = ConfigDict(extra='forbid')
    total: str = Field(default='', max_length=64)
    people: str = Field(default='', max_length=64)
    tip: str = Field(default='', max_length=64)


class WidgetState(BaseModel):
    model_config = ConfigDict(extra='forbid')
    selected: int | None = Field(default=None, ge=0, le=10000)
    done: list[int] = Field(default_factory=list, max_length=1000)
    values: CalculatorValues | None = None
    filters: str = Field(default='', max_length=2000)

    @field_validator('done')
    @classmethod
    def valid_indices(cls, value):
        if any(index < 0 or index > 10000 for index in value):
            raise ValueError('Invalid checklist index')
        return sorted(set(value))


class StateUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_hash: str = Field(pattern=_HASH)
    state: WidgetState


class NoteAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(min_length=1, max_length=32)
    action: Literal['save_note', 'email_note']
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=20000)
    recipient: str | None = Field(default=None, max_length=254)
    personal_data_confirmed: bool = False

    @field_validator('title', 'body')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Enter a note title and content')
        return value.strip()

    @field_validator('title')
    @classmethod
    def safe_subject(cls, value):
        if any(char in value for char in ('\r', '\n', '\x00')):
            raise ValueError('Title cannot contain line breaks')
        return value

    @model_validator(mode='after')
    def email_recipient(self):
        if self.action == 'email_note':
            if not self.recipient:
                raise ValueError('Enter a recipient')
            self.recipient = smtp_settings.address(self.recipient)
        return self


def owned_session(session_id, user):
    try:
        sessions.get_session(session_id, user['username'])
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, 'Conversation not found') from None


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS bob_interactive_widgets (
        username TEXT NOT NULL, session_id TEXT NOT NULL,
        widget_key TEXT NOT NULL, source_hash TEXT NOT NULL, state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(username,session_id,widget_key))''')


@router.post('/actions')
def execute_action(body: NoteAction, user=Depends(current_user)):
    owned_session(body.session_id, user)
    if body.action == 'save_note':
        note = notes.create_note(notes.NoteCreate(title=body.title, body=body.body,
                                                source_session_id=body.session_id), user)
        return {'ok': True, 'message': 'Note saved.', 'note': note}
    config = smtp_settings.load_config()
    if not config.get('enabled'):
        raise HTTPException(400, 'SMTP sending is disabled. Ask an administrator to enable it.')
    filename = re.sub(r'[^\w .-]', '', body.title).strip(' .')[:120] or 'note'
    try:
        message = email_review.send_reviewed(user['username'], config, body.recipient, body.title, body.body,
                                             confirmed=body.personal_data_confirmed, markdown_attachment=(filename + '.md', '# ' + body.title + '\n\n' + body.body))
    except ValueError:
        raise HTTPException(400, 'SMTP could not complete sending. Check SMTP settings and server logs before retrying; delivery may be uncertain.') from None
    return {'ok': True, 'message': message}


@router.get('/{session_id}/{widget_key}')
def get_state(session_id: str, widget_key: str, source_hash: str = Query(pattern=_HASH),
              user=Depends(current_user)):
    owned_session(session_id, user)
    if not re.fullmatch(_HASH, widget_key):
        raise HTTPException(422, 'Invalid widget key')
    with job_queue._connect() as db:
        ensure_schema(db)
        row = db.execute('''SELECT state FROM bob_interactive_widgets
            WHERE username=%s AND session_id=%s AND widget_key=%s AND source_hash=%s''',
                         (user['username'], session_id, widget_key, source_hash)).fetchone()
    return {'state': row['state'] if row else None}


@router.put('/{session_id}/{widget_key}')
def put_state(session_id: str, widget_key: str, body: StateUpdate, user=Depends(current_user)):
    owned_session(session_id, user)
    if not re.fullmatch(_HASH, widget_key):
        raise HTTPException(422, 'Invalid widget key')
    state = body.state.model_dump(exclude_none=True)
    with job_queue._connect() as db:
        ensure_schema(db)
        db.execute('''INSERT INTO bob_interactive_widgets(username,session_id,widget_key,source_hash,state)
            VALUES (%s,%s,%s,%s,%s) ON CONFLICT(username,session_id,widget_key)
            DO UPDATE SET source_hash=EXCLUDED.source_hash,state=EXCLUDED.state,updated_at=now()''',
                   (user['username'], session_id, widget_key, body.source_hash, Jsonb(state)))
    return {'state': state}
