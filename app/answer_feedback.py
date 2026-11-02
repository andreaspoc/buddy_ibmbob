"""Durable reports tied to the user's actual saved answer and accessible citations."""
from typing import Literal
from uuid import UUID
import re
import threading
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb
from app import job_queue, rag, sessions
from app.auth import current_user, _connect as auth_connect
from app.admin_users import administrator

router = APIRouter(tags=['answer feedback'])
_lock = threading.Lock()
_ready = False


def ensure_schema():
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        with job_queue._connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS bob_answer_feedback (
                id BIGSERIAL PRIMARY KEY,username TEXT NOT NULL,session_id TEXT NOT NULL,
                request_history_id BIGINT NOT NULL,answer_index INTEGER NOT NULL,
                answer_text TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('incorrect_answer','outdated_policy','other')),
                comment TEXT NOT NULL DEFAULT '',source_document_id UUID,source_filename TEXT,source_url TEXT,
                status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed','resolved')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(username,request_history_id))''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_feedback_status ON bob_answer_feedback(status,id DESC)')
        _ready = True


class Feedback(BaseModel):
    session_id: str = Field(min_length=1, max_length=32)
    answer_index: int = Field(ge=0, le=100000)
    category: Literal['incorrect_answer', 'outdated_policy', 'other']
    comment: str = Field(default='', max_length=4000)
    source_document_id: UUID | None = None


class Review(BaseModel):
    status: Literal['open', 'reviewed', 'resolved']


def saved_answer(username, session_id, answer_index):
    try:
        sessions.get_session(session_id, username)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, 'Conversation not found')
    with job_queue._connect() as db:
        request = db.execute("SELECT id FROM bob_conversation_history WHERE username=%s AND session_id=%s AND event->>'type'='request' ORDER BY id OFFSET %s LIMIT 1", (username, session_id, answer_index)).fetchone()
        if not request:
            raise HTTPException(404, 'Answer not found')
        rows = db.execute("SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s AND id>%s AND id<COALESCE((SELECT min(id) FROM bob_conversation_history WHERE username=%s AND session_id=%s AND id>%s AND event->>'type'='request'),9223372036854775807) ORDER BY id", (username, session_id, request['id'], username, session_id, request['id'])).fetchall()
    text = ''
    completed = False
    for row in rows:
        event = row['event']
        if event.get('type') == 'delta':
            text = str(event.get('text') or '') if event.get('replace') else text + str(event.get('text') or '')
        elif event.get('type') == 'done':
            completed = True
    if not completed or not text.strip():
        raise HTTPException(409, 'Feedback is available after an answer finishes')
    return request['id'], text


def answer_sources(username, text):
    # Only references actually appearing in the saved answer are eligible.
    ids = list(dict.fromkeys(str(UUID(value)) for value in re.findall(r'/knowledge/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/file', text)))
    if not ids:
        return []
    rag.ensure_schema()
    scope, params = rag.access_filter(username)
    with job_queue._connect() as db:
        rows = db.execute(f"SELECT id,filename FROM bob_knowledge_documents WHERE visibility='shared' AND id=ANY(%s::uuid[]) AND {scope}", (ids, *params)).fetchall()
    by_id = {str(row['id']): row for row in rows}
    return [{'id': identifier, 'filename': by_id[identifier]['filename'], 'url': f'/knowledge/{identifier}/file'} for identifier in ids if identifier in by_id]


@router.get('/feedback/answer')
def feedback_answer(session_id: str, answer_index: int = Query(ge=0, le=100000), user: dict = Depends(current_user)):
    ensure_schema()
    request_id, text = saved_answer(user['username'], session_id, answer_index)
    with job_queue._connect() as db:
        submitted = db.execute('SELECT id,status FROM bob_answer_feedback WHERE username=%s AND request_history_id=%s', (user['username'], request_id)).fetchone()
    return {'sources': answer_sources(user['username'], text), 'submitted': submitted}


@router.post('/feedback', status_code=201)
def submit_feedback(body: Feedback, user: dict = Depends(current_user)):
    ensure_schema()
    request_id, text = saved_answer(user['username'], body.session_id, body.answer_index)
    source = None
    if body.source_document_id:
        source = next((item for item in answer_sources(user['username'], text) if item['id'] == str(body.source_document_id)), None)
        if source is None:
            raise HTTPException(403, 'Select an accessible source cited in this answer')
    with job_queue._connect() as db:
        row = db.execute('''INSERT INTO bob_answer_feedback(username,session_id,request_history_id,answer_index,answer_text,category,comment,source_document_id,source_filename,source_url)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(username,request_history_id) DO NOTHING RETURNING id,status''',
            (user['username'], body.session_id, request_id, body.answer_index, text, body.category, body.comment.strip(), body.source_document_id, source['filename'] if source else None, source['url'] if source else None)).fetchone()
        if not row:
            raise HTTPException(409, 'Feedback has already been submitted for this answer')
    return row


@router.get('/admin/feedback')
def list_feedback(limit: int = Query(default=50, ge=1, le=100), before_id: int | None = Query(default=None, ge=1), status: Literal['open','reviewed','resolved'] | None = None, user: dict = Depends(administrator)):
    ensure_schema()
    filters = []
    params = []
    if before_id:
        filters.append('f.id<%s'); params.append(before_id)
    if status:
        filters.append('f.status=%s'); params.append(status)
    with job_queue._connect() as db:
        rows = db.execute("SELECT f.*,COALESCE(p.display_name,f.username) AS user_name FROM bob_answer_feedback f LEFT JOIN bob_user_profiles p ON p.username=f.username" + (' WHERE ' + ' AND '.join(filters) if filters else '') + ' ORDER BY f.id DESC LIMIT %s', (*params, limit + 1)).fetchall()
    items = rows[:limit]
    for row in items:
        for key in ('created_at','updated_at','source_document_id'):
            if row[key] is not None:
                row[key] = str(row[key])
    return {'items': items, 'next_before_id': items[-1]['id'] if len(rows) > limit else None}


@router.patch('/admin/feedback/{feedback_id}')
def review_feedback(feedback_id: int, body: Review, user: dict = Depends(administrator)):
    ensure_schema()
    # Same transaction as audit record: a review must never silently lose its history.
    with auth_connect() as db:
        previous = db.execute('SELECT status FROM bob_answer_feedback WHERE id=%s FOR UPDATE', (feedback_id,)).fetchone()
        if not previous:
            raise HTTPException(404, 'Feedback not found')
        db.execute('UPDATE bob_answer_feedback SET status=%s,updated_at=now() WHERE id=%s', (body.status, feedback_id))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'review-answer-feedback', str(feedback_id), Jsonb({'before': {'status': previous[0]}, 'after': {'status': body.status}})))
    return {'id': feedback_id, 'status': body.status}


@router.get('/admin/feedback/quality')
def answer_quality(days: int = Query(default=30, ge=1, le=365), user: dict = Depends(administrator)):
    """Observed feedback only: an unreported answer is not evidence of correctness."""
    ensure_schema()
    with job_queue._connect() as db:
        totals = db.execute("""SELECT count(*) AS reports,
            count(*) FILTER (WHERE status='open') AS open,
            count(*) FILTER (WHERE status='reviewed') AS reviewed,
            count(*) FILTER (WHERE status='resolved') AS resolved,
            count(DISTINCT username) AS reporters
            FROM bob_answer_feedback WHERE created_at >= now() - %s * interval '1 day'""", (days,)).fetchone()
        categories = db.execute("""SELECT category,count(*) AS reports FROM bob_answer_feedback
            WHERE created_at >= now() - %s * interval '1 day' GROUP BY category ORDER BY reports DESC,category""", (days,)).fetchall()
        sources = db.execute("""SELECT source_document_id,source_filename,count(*) AS reports,
            count(*) FILTER (WHERE status<>'resolved') AS unresolved
            FROM bob_answer_feedback WHERE created_at >= now() - %s * interval '1 day'
            AND source_document_id IS NOT NULL GROUP BY source_document_id,source_filename
            ORDER BY reports DESC,source_filename LIMIT 10""", (days,)).fetchall()
        trend = db.execute("""SELECT created_at::date AS day,count(*) AS reports,
            count(*) FILTER (WHERE status='resolved') AS resolved FROM bob_answer_feedback
            WHERE created_at >= now() - %s * interval '1 day' GROUP BY created_at::date ORDER BY day""", (days,)).fetchall()
    return {'days': days, 'totals': totals, 'categories': categories,
            'sources': [{**row, 'source_document_id': str(row['source_document_id'])} for row in sources],
            'trend': [{**row, 'day': str(row['day'])} for row in trend]}
