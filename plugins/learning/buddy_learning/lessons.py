"""Human-authored lessons with versioned publication and private learner progress."""
from app.branding import brand_name, brand_text
import asyncio
import logging
import os
import hashlib
import json
import re
from html.parser import HTMLParser
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from psycopg.types.json import Jsonb
from starlette.concurrency import run_in_threadpool
from app import job_queue
from app.auth import current_user
from app.s3_client import client as s3
from . import store
from .documents import parse_document
from .epub import render_chapter, _raster_type
from .service import same_origin, teacher, MAX_UPLOAD, _is_real_db
from .lesson_models import LessonInput, Step, Progress, Check, BuddyDraftRequest, LessonEditInput, LessonPublishInput

router = APIRouter(prefix='/api/learning')
logger = logging.getLogger(__name__)


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS learning.lessons (
        id UUID PRIMARY KEY, folder_id UUID NOT NULL REFERENCES learning.folders(id),
        title TEXT NOT NULL, draft JSONB NOT NULL, published JSONB,
        version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','closed')), created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('CREATE INDEX IF NOT EXISTS learning_lessons_folder ON learning.lessons(folder_id)')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.lesson_progress (
        lesson_id UUID REFERENCES learning.lessons(id) ON DELETE CASCADE,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        version INTEGER NOT NULL, step INTEGER NOT NULL DEFAULT 0, completed BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(lesson_id,username,version))''')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.lesson_assets (
        id UUID PRIMARY KEY, folder_id UUID NOT NULL REFERENCES learning.folders(id),
        created_by TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL)''')
    db.execute('ALTER TABLE learning.lessons ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL DEFAULT 0')
    db.execute('CREATE INDEX IF NOT EXISTS learning_lessons_folder_ordinal ON learning.lessons(folder_id, ordinal, created_at)')
    db.execute('ALTER TABLE learning.quizzes ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES learning.lessons(id)')
    db.execute('CREATE INDEX IF NOT EXISTS learning_quizzes_lesson ON learning.quizzes(lesson_id)')


def lesson_plain_excerpts(spec: dict, max_chars: int = 35000) -> tuple[list[dict], bool]:
    """Extract structured, plain-text sections from a lesson specification."""
    if not isinstance(spec, dict):
        return [], False
    steps = spec.get('steps', [])
    desc = spec.get('description', '')
    excerpts = []
    remaining = max_chars
    truncated = False

    if desc and isinstance(desc, str) and desc.strip():
        text = f"Overview:\n{desc.strip()}"
        if len(text) > remaining:
            excerpts.append({'section': 'Introduction', 'text': text[:remaining]})
            return excerpts, True
        excerpts.append({'section': 'Introduction', 'text': text})
        remaining -= len(text)

    for step in steps:
        if not isinstance(step, dict):
            continue
        step_title = (step.get('title') or 'Section').strip() or 'Section'
        parts = []
        if step.get('text') and isinstance(step['text'], str) and step['text'].strip():
            parts.append(step['text'].strip())
        if step.get('options') and isinstance(step['options'], list):
            opt_strs = [f"- {opt}" for opt in step['options'] if isinstance(opt, str) and opt.strip()]
            if opt_strs:
                parts.append("Key Concepts / Choices:\n" + "\n".join(opt_strs))
        if step.get('feedback') and isinstance(step['feedback'], str) and step['feedback'].strip():
            parts.append(f"Explanation: {step['feedback'].strip()}")
        if step.get('board') and isinstance(step['board'], dict):
            cards = step['board'].get('cards', [])
            card_texts = []
            for c in cards:
                if isinstance(c, dict):
                    c_title = c.get('title', '').strip()
                    c_body = c.get('body', '').strip()
                    if c_title or c_body:
                        card_texts.append(f"• {c_title}: {c_body}" if c_title else f"• {c_body}")
            if card_texts:
                parts.append("Interactive Board:\n" + "\n".join(card_texts))

        section_text = "\n\n".join(parts)
        if not section_text:
            continue

        if len(section_text) > remaining:
            excerpts.append({'section': step_title, 'text': section_text[:remaining]})
            truncated = True
            break
        excerpts.append({'section': step_title, 'text': section_text})
        remaining -= len(section_text)
        if remaining <= 0:
            truncated = True
            break

    return excerpts, truncated


def lookup(db, lesson_id, user, *, edit=False, lock=False):
    row = db.execute('SELECT * FROM learning.lessons WHERE id=%s' + (' FOR UPDATE' if lock else ''), (str(lesson_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Lesson not found')
    store.folder(db, row['folder_id'], user)
    creator = row['created_by'] == user['username'] and store.can_create(db, user)
    if edit and not creator:
        raise HTTPException(403, 'Only the lesson creator can edit or publish it')
    if not creator and row['status'] == 'draft':
        raise HTTPException(404, 'Lesson not found')
    return row, creator


def check_assets(db, folder_id, spec):
    for step in spec.steps:
        if step.asset_id:
            asset = db.execute('SELECT * FROM learning.lesson_assets WHERE id=%s AND folder_id=%s', (str(step.asset_id), str(folder_id))).fetchone()
            if not asset or not asset['mime'].startswith('image/' if step.kind == 'image' else 'video/'):
                raise HTTPException(422, 'Select media from this lesson folder with the correct type')


def public_spec(spec):
    def _strip(step):
        return {k: v for k, v in step.items() if k not in {'answer', 'feedback', 'teacher_notes'}}
    out = {**spec, 'steps': [_strip(step) for step in spec['steps']]}
    if isinstance(spec.get('translations'), dict):
        out['translations'] = {
            lang: {
                **tr,
                'steps': [_strip(s) for s in tr.get('steps', [])]
            }
            for lang, tr in spec['translations'].items()
            if isinstance(tr, dict)
        }
    return out


def clean_lesson_dump(spec: LessonInput) -> dict:
    d = spec.model_dump(mode='json')
    for k in ('language', 'translations', 'approved_languages'):
        if d.get(k) is None:
            d.pop(k, None)
    return d


def draft_digest(spec):
    return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def check_draft(row, expected):
    if expected is not None and expected != draft_digest(row['draft']):
        raise HTTPException(409, 'This lesson draft changed in another session. Reopen it before saving or publishing.')


class ReorderLessons(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lesson_ids: list[UUID] = Field(min_length=1, max_length=500)


@router.get('/folders/{folder_id}/lessons')
def listing(folder_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        create = store.can_create(db, user)
        rows = db.execute('''SELECT id,CASE WHEN created_by=%s AND %s THEN title ELSE published->>'title' END AS title,
            status,version,(created_by=%s AND %s) AS is_creator,ordinal FROM learning.lessons
            WHERE folder_id=%s AND (status<>'draft' OR (created_by=%s AND %s)) ORDER BY ordinal ASC, created_at ASC''',
            (user['username'], create, user['username'], create, str(folder_id), user['username'], create)).fetchall()
        if _is_real_db(db) and rows:
            tr_rows = db.execute('''SELECT id,
                COALESCE(CASE WHEN created_by=%s AND %s THEN draft->'translations' ELSE published->'translations' END, published->'translations', draft->'translations') AS translations
                FROM learning.lessons WHERE folder_id=%s''',
                (user['username'], create, str(folder_id))).fetchall()
            tr_map = {str(r['id']): r.get('translations') for r in tr_rows}
            rows = [{
                **r,
                **(
                    {'translations': {k: {'title': v.get('title', ''), 'description': v.get('description', '')} for k, v in tr_map[str(r['id'])].items() if isinstance(v, dict)}}
                    if isinstance(tr_map.get(str(r['id'])), dict) else {}
                )
            } for r in rows]
    return {'items': rows}


@router.put('/folders/{folder_id}/lessons/order', dependencies=[Depends(same_origin)])
def reorder_lessons(folder_id: UUID, req: ReorderLessons, user=Depends(teacher)):
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        if not store.can_create(db, user):
            raise HTTPException(403, 'Reordering lessons requires teacher access')
        for idx, lid in enumerate(req.lesson_ids):
            db.execute('UPDATE learning.lessons SET ordinal=%s WHERE id=%s AND folder_id=%s', (idx, str(lid), str(folder_id)))
    return {'reordered': True}


def insert_draft(db, folder_id, dumped, username, *, title=None):
    row = db.execute('SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ord FROM learning.lessons WHERE folder_id=%s', (str(folder_id),)).fetchone()
    next_ord = row['next_ord'] if row else 0
    return db.execute('INSERT INTO learning.lessons(id,folder_id,title,draft,created_by,ordinal) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id',
        (str(uuid4()), str(folder_id), title or dumped['title'], Jsonb(dumped), username, next_ord)).fetchone()


@router.post('/folders/{folder_id}/lessons', dependencies=[Depends(same_origin)])
def create(folder_id: UUID, req: LessonInput, user=Depends(teacher)):
    dumped = clean_lesson_dump(req)
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        check_assets(db, folder_id, req)
        created = insert_draft(db, folder_id, dumped, user['username'], title=req.title)
    return {**created, 'draft_digest': draft_digest(dumped)}


@router.get('/lessons/{lesson_id}')
def info(lesson_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        row, creator = lookup(db, lesson_id, user)
        progress = db.execute('SELECT step,completed FROM learning.lesson_progress WHERE lesson_id=%s AND username=%s AND version=%s',
            (str(lesson_id), user['username'], row['version'])).fetchone()
    spec = row['draft'] if creator else public_spec(row['published'])
    return {**spec, 'id': row['id'], 'status': row['status'], 'version': row['version'], 'is_creator': creator, 'progress': progress, **({'draft_digest': draft_digest(row['draft'])} if creator else {})}


@router.put('/lessons/{lesson_id}', dependencies=[Depends(same_origin)])
def edit(lesson_id: UUID, req: LessonEditInput, user=Depends(teacher)):
    with job_queue._connect() as db:
        row, _ = lookup(db, lesson_id, user, edit=True, lock=True)
        check_draft(row, req.expected_digest)
        spec = LessonInput.model_validate(req.model_dump(exclude={'expected_digest'}))
        check_assets(db, row['folder_id'], spec)
        dumped = clean_lesson_dump(spec)
        # Keep the published snapshot available until the teacher publishes the revision.
        db.execute('UPDATE learning.lessons SET title=%s,draft=%s WHERE id=%s',
                   (spec.title, Jsonb(dumped), str(lesson_id)))
    return {'saved': True, 'draft_digest': draft_digest(dumped)}


@router.post('/lessons/{lesson_id}/publish', dependencies=[Depends(same_origin)])
def publish(lesson_id: UUID, req: LessonPublishInput = LessonPublishInput(), user=Depends(teacher)):
    with job_queue._connect() as db:
        row, _ = lookup(db, lesson_id, user, edit=True, lock=True)
        check_draft(row, req.expected_digest)
        spec = LessonInput.model_validate(row['draft'])
        check_assets(db, row['folder_id'], spec)
        from .translation_check import require_translated
        require_translated(row['draft'], 'steps')
        db.execute("UPDATE learning.lessons SET published=draft,status='published',version=version+1 WHERE id=%s", (str(lesson_id),))
    if not row.get('published'):
        from .classrooms import notify_new_module
        notify_new_module(spec.title, folder_id=row['folder_id'], exclude=user['username'])
    return {'published': True}


@router.delete('/lessons/{lesson_id}', dependencies=[Depends(same_origin)])
def delete_lesson(lesson_id: UUID, user=Depends(teacher)):
    with job_queue._connect() as db:
        row, _ = lookup(db, lesson_id, user, edit=True, lock=True)
        db.execute('DELETE FROM learning.lesson_progress WHERE lesson_id=%s', (str(lesson_id),))
        db.execute('DELETE FROM learning.lessons WHERE id=%s', (str(lesson_id),))
    return {'deleted': True}


@router.post('/lessons/{lesson_id}/close', dependencies=[Depends(same_origin)])
def close(lesson_id: UUID, user=Depends(teacher)):
    with job_queue._connect() as db:
        row, _ = lookup(db, lesson_id, user, edit=True, lock=True)
        if row['status'] != 'published':
            raise HTTPException(409, 'Only a published lesson can be closed')
        db.execute("UPDATE learning.lessons SET status='closed' WHERE id=%s", (str(lesson_id),))
    return {'closed': True}


@router.put('/lessons/{lesson_id}/progress', dependencies=[Depends(same_origin)])
def progress(lesson_id: UUID, req: Progress, user=Depends(current_user)):
    with job_queue._connect() as db:
        row, creator = lookup(db, lesson_id, user)
        if row['status'] != 'published' or req.version != row['version']:
            raise HTTPException(409, 'Lesson has changed or is closed. Reload it.')
        active_spec = row['draft'] if (creator and row.get('draft')) else row['published']
        steps = (active_spec or row['published'] or {}).get('steps', [])
        if req.step >= len(steps) or (req.completed and req.step != len(steps) - 1):
            raise HTTPException(422, 'Invalid lesson position')
        db.execute('''INSERT INTO learning.lesson_progress(lesson_id,username,version,step,completed) VALUES(%s,%s,%s,%s,%s)
            ON CONFLICT(lesson_id,username,version) DO UPDATE SET step=EXCLUDED.step,
            completed=learning.lesson_progress.completed OR EXCLUDED.completed,updated_at=now()''',
            (str(lesson_id), user['username'], req.version, req.step, req.completed))
        if req.completed:
            from .course_completion import check_and_issue_for_folder
            check_and_issue_for_folder(db, row['folder_id'], user['username'])
    return {'saved': True}


@router.post('/lessons/{lesson_id}/check', dependencies=[Depends(same_origin)])
def check(lesson_id: UUID, req: Check, request: Request, user=Depends(current_user)):
    with job_queue._connect() as db:
        row, creator = lookup(db, lesson_id, user)
        if row['status'] != 'published' or req.version != row['version']:
            raise HTTPException(409, 'Lesson has changed or is closed. Reload it.')
        active_spec = row['draft'] if (creator and row.get('draft')) else row['published']
        steps = (active_spec or row['published'] or {}).get('steps', [])
        step = next((s for s in steps if s['id'] == req.step_id and s['kind'] == 'question'), None)
        if not step or req.answer >= len(step['options']):
            raise HTTPException(422, 'Invalid question or answer')
        feedback = step.get('feedback', '')
        lang = (request.headers.get('x-learning-language') or '').strip().lower().split('-')[0]
        translations = (active_spec or {}).get('translations')
        if lang and isinstance(translations, dict) and isinstance(translations.get(lang), dict):
            tr_step = next((s for s in translations[lang].get('steps', []) if isinstance(s, dict) and s.get('id') == req.step_id), None)
            if tr_step and tr_step.get('feedback'):
                feedback = tr_step['feedback']
    return {'correct': req.answer == step['answer'], 'feedback': feedback}


MAX_DOCUMENT_STEPS = 100
MAX_REFERENCE_CHARACTERS = 40000


async def upload_bytes(file):
    raw = bytearray()
    try:
        while chunk := await file.read(1024 * 1024):
            raw.extend(chunk)
            if len(raw) > MAX_UPLOAD:
                raise HTTPException(413, 'Lesson uploads must be 50 MB or smaller')
    finally:
        await file.close()
    if not raw:
        raise HTTPException(422, 'Upload a non-empty file')
    return bytes(raw)


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def document_sections(raw, filename):
    parsed = parse_document(raw, filename)
    steps = []
    for chapter in parsed['chapters']:
        plain = _PlainText()
        plain.feed(render_chapter(parsed, chapter['id'], 'source'))
        text = '\n'.join(plain.parts).strip()
        for start in range(0, len(text), 20000):
            steps.append(Step(id=str(uuid4()), title=chapter['title'][:200] or 'Section', text=text[start:start+20000]))
    return parsed['title'][:200], steps


def document_lesson(raw, filename):
    """Convert a whole uploaded document into lesson sections."""
    title, steps = document_sections(raw, filename)
    return LessonInput(title=title, steps=steps)


def reference_lesson(raw, filename):
    """Keep only what Buddy can read, so a long reference is not rejected by lesson size limits."""
    title, steps = document_sections(raw, filename)
    kept, characters = [], 0
    for step in steps[:MAX_DOCUMENT_STEPS]:
        if characters >= MAX_REFERENCE_CHARACTERS:
            break
        kept.append(step)
        characters += len(step.text)
    return LessonInput(title=title, steps=kept), len(kept) < len(steps)


@router.post('/folders/{folder_id}/lesson-import', dependencies=[Depends(same_origin)])
async def import_document(folder_id: UUID, file: UploadFile = File(...), user=Depends(teacher)):
    def authorize():
        with job_queue._connect() as db:
            store.folder(db, folder_id, user)
    await run_in_threadpool(authorize)
    raw = await upload_bytes(file)
    def convert():
        try:
            return document_lesson(raw, file.filename or '').model_dump(mode='json')
        except ValueError as exc:
            raise HTTPException(422, f'Unable to import this lesson: {exc}') from None
    return await run_in_threadpool(convert)


@router.post('/folders/{folder_id}/lesson-assets', dependencies=[Depends(same_origin)])
async def upload_asset(folder_id: UUID, file: UploadFile = File(...), user=Depends(teacher)):
    def authorize():
        with job_queue._connect() as db:
            store.folder(db, folder_id, user)
    await run_in_threadpool(authorize)
    raw = await upload_bytes(file)
    mime = _raster_type(raw)
    if not mime and len(raw) >= 12 and raw[4:8] == b'ftyp':
        mime = 'video/mp4'
    if not mime and raw.startswith(b'\x1aE\xdf\xa3') and b'webm' in raw[:4096]:
        mime = 'video/webm'
    if not mime:
        raise HTTPException(422, 'Upload a PNG, JPEG, GIF, WebP, MP4 or WebM file')
    asset_id = uuid4(); key = f'learning/lessons/{folder_id}/{asset_id}'
    def save():
        with job_queue._connect() as db:
            store.folder(db, folder_id, user)
            s3().put_object(Bucket=os.environ['BOB_S3_BUCKET'], Key=key, Body=raw, ContentType=mime)
            try:
                db.execute('INSERT INTO learning.lesson_assets(id,folder_id,created_by,object_key,filename,mime,size) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                    (str(asset_id), str(folder_id), user['username'], key, (file.filename or 'media')[:200], mime, len(raw)))
            except Exception:
                s3().delete_object(Bucket=os.environ['BOB_S3_BUCKET'], Key=key)
                raise
        return {'id': str(asset_id), 'mime': mime}
    return await run_in_threadpool(save)


@router.get('/lessons/{lesson_id}/assets/{asset_id}')
def media(lesson_id: UUID, asset_id: UUID, request: Request, user=Depends(current_user)):
    with job_queue._connect() as db:
        row, creator = lookup(db, lesson_id, user)
        spec = row['draft'] if creator else row['published']
        if not any(step.get('asset_id') == str(asset_id) for step in spec['steps']):
            raise HTTPException(404, 'Media not found')
        asset = db.execute('SELECT * FROM learning.lesson_assets WHERE id=%s AND folder_id=%s', (str(asset_id), str(row['folder_id']))).fetchone()
        if not asset:
            raise HTTPException(404, 'Media not found')
    start, end = 0, asset['size'] - 1
    status = 200
    headers = {'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; sandbox"}
    if request.headers.get('range'):
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', request.headers['range'])
        if not match:
            return Response(status_code=416, headers={'Content-Range': f"bytes */{asset['size']}"})
        start = int(match[1]); end = min(int(match[2]) if match[2] else end, end)
        if start > end:
            return Response(status_code=416, headers={'Content-Range': f"bytes */{asset['size']}"})
        status = 206; headers['Content-Range'] = f"bytes {start}-{end}/{asset['size']}"
    obj = s3().get_object(Bucket=os.environ['BOB_S3_BUCKET'], Key=asset['object_key'], Range=f'bytes={start}-{end}')
    try:
        raw = obj['Body'].read(MAX_UPLOAD + 1)
    finally:
        obj['Body'].close()
    return Response(raw, status_code=status, media_type=asset['mime'], headers=headers)


async def translated_entry(language, dumped, username):
    """Translate one language; on failure keep the source text and report it so the author can see."""
    from .service import _translate_json_payload
    source = {'title': dumped['title'], 'description': dumped.get('description', ''), 'steps': dumped['steps']}
    try:
        result = await _translate_json_payload('lesson', language, source, username)
    except (ValueError, RuntimeError, TimeoutError, PermissionError):
        logger.warning('Lesson draft translation to %s failed', language, exc_info=True)
        return {**source, 'approved': False}, False
    steps = result.get('steps')
    complete = isinstance(steps, list) and len(steps) == len(dumped['steps'])
    return {'title': str(result.get('title') or dumped['title'])[:200],
            'description': str(result.get('description') if result.get('description') is not None else source['description'])[:2000],
            'steps': steps if complete else dumped['steps'],
            'approved': False}, complete


def _authorize_drafting(folder_id, user):
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        if not store.can_create(db, user):
            raise HTTPException(403, 'Lesson creation requires teacher or administrator access')
        return _is_real_db(db)


async def _buddy_proposal(folder_id, req, user):
    """Draft and translate for an authorized author; returns (dump, truncated, untranslated)."""
    real_db = await run_in_threadpool(_authorize_drafting, folder_id, user)
    from .lesson_ai import draft
    from app.agent_budget import BudgetExceeded, RunBudget
    untranslated = []
    try:
        proposal, truncated = await draft(req, budget=RunBudget(user['username']))
    except BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from None
    except TimeoutError:
        raise HTTPException(504, brand_text('Buddy took too long. Try a shorter lesson or request.')) from None
    except (ValueError, RuntimeError):
        raise HTTPException(502, brand_text('Buddy could not produce a valid lesson draft. Your content has not changed.')) from None
    await run_in_threadpool(_authorize_drafting, folder_id, user)
    dumped = clean_lesson_dump(proposal)
    if real_db:
        from .service import _norm_lang
        primary = _norm_lang(req.language)
        base_entry = {'title': dumped['title'], 'description': dumped.get('description', ''), 'steps': dumped['steps'], 'approved': False}
        translations: dict[str, dict] = {primary: base_entry}
        others = [code for code in ('en', 'el', 'hi') if code != primary]
        entries = await asyncio.gather(*(translated_entry(other, dumped, user['username']) for other in others))
        translations.update((code, entry) for code, (entry, _) in zip(others, entries))
        untranslated = [code for code, (_, translated) in zip(others, entries) if not translated]
        dumped['language'] = primary
        dumped['translations'] = translations
        dumped['approved_languages'] = []
    return dumped, truncated, untranslated


@router.post('/folders/{folder_id}/lesson-draft', dependencies=[Depends(same_origin)])
async def buddy_draft(folder_id: UUID, req: BuddyDraftRequest, user=Depends(teacher)):
    dumped, truncated, untranslated = await _buddy_proposal(folder_id, req, user)
    return {'draft': dumped, 'source_truncated': truncated, 'untranslated': untranslated}


DOCUMENT_DRAFT_BRIEF = 'Create an engaging lesson for this class that teaches the key points of the supplied reference document.'


@router.post('/folders/{folder_id}/lesson-document-draft', dependencies=[Depends(same_origin)])
async def document_draft(folder_id: UUID, file: UploadFile = File(...), brief: str = Form(default='', max_length=6000),
                         language: str = Form(default='en', max_length=80), user=Depends(teacher)):
    """Save Buddy's lesson from a reference document as a private draft; the file itself is not kept."""
    await run_in_threadpool(_authorize_drafting, folder_id, user)
    raw = await upload_bytes(file)
    def read_document():
        try:
            return reference_lesson(raw, file.filename or '')
        except ValueError as exc:
            raise HTTPException(422, f'{brand_name()} could not read this document: {exc}') from None
    source, clipped = await run_in_threadpool(read_document)
    req = BuddyDraftRequest(message=brief.strip() or DOCUMENT_DRAFT_BRIEF, language=language.strip() or 'en', current=source)
    dumped, truncated, untranslated = await _buddy_proposal(folder_id, req, user)
    def save():
        with job_queue._connect() as db:
            store.folder(db, folder_id, user)
            return insert_draft(db, folder_id, dumped, user['username'])
    created = await run_in_threadpool(save)
    return {'id': created['id'], 'title': dumped['title'], 'source_truncated': truncated or clipped, 'untranslated': untranslated}
