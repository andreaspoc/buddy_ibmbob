"""Owner-scoped workflows and calendar schedules, dispatched atomically to Buddy jobs."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from threading import Lock
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool

from app import job_queue, postgres_storage as storage
from app.auth import current_user

router = APIRouter(prefix='/workflows', tags=['workflows'])
_schema_lock = Lock()
_schema_urls: set[str] = set()
logger = logging.getLogger(__name__)


class WorkflowSpec(BaseModel):
    ui_language: str = Field(default="en", pattern=r"^(en|el|hi|mt)$")
    name: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=20000)
    project_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    skill_name: str | None = Field(default=None, pattern=r'^[a-z][a-z0-9-]{0,63}$')
    roles: list[str] = Field(default_factory=list, max_length=3)
    max_iterations: int = Field(default=1, ge=1, le=3, strict=True)
    completion_criteria: str = Field(default='', max_length=2000)
    timeout_seconds: int = Field(default=900, ge=60, le=3600, strict=True)
    web_search: bool = False
    presentation_format: str | None = Field(default=None, pattern=r'^(pptx|html)$')
    template_id: str | None = Field(default=None, pattern=r'^[a-z0-9-]+$')
    slide_count: int | None = Field(default=None, ge=1, le=50, strict=True)
    frequency: str | None = Field(default=None, pattern=r'^(daily|weekly)$')
    timezone: str = Field(default='UTC', max_length=100)
    time: str = Field(default='09:00', pattern=r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
    weekday: int = Field(default=0, ge=0, le=6, strict=True)

    @model_validator(mode='after')
    def validate_spec(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('Use an IANA timezone such as Europe/London')
        self.name, self.prompt = self.name.strip(), self.prompt.strip()
        if not self.name or not self.prompt:
            raise ValueError('Name and prompt cannot be blank')
        self.roles = [role.strip() for role in self.roles]
        if any(not role or len(role) > 1000 for role in self.roles):
            raise ValueError('Each team role must contain 1–1000 characters')
        if self.max_iterations > 1 and not self.completion_criteria.strip():
            raise ValueError('Agent loops require completion criteria')
        if self.presentation_format and (not self.template_id or self.slide_count is None):
            raise ValueError('Presentations require a template and slide count')
        return self


def next_run(spec: WorkflowSpec, after: datetime) -> datetime | None:
    """Calendar schedules: first fold on fall-back; skip nonexistent spring times."""
    if not spec.frequency:
        return None
    zone = ZoneInfo(spec.timezone)
    hour, minute = map(int, spec.time.split(':'))
    local_date = after.astimezone(zone).date()
    for offset in range(15):
        day = local_date + timedelta(days=offset)
        if spec.frequency == 'weekly' and day.weekday() != spec.weekday:
            continue
        candidate = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)
        utc = candidate.astimezone(timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) != candidate.replace(tzinfo=None):
            continue
        if utc > after:
            return utc
    raise ValueError('Could not calculate next scheduled run')


def ensure_schema():
    storage.ensure_schema()
    from app.projects import database
    with database():
        pass
    with _schema_lock:
        url = os.environ['DATABASE_URL']
        if url in _schema_urls:
            return
        with job_queue._connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_workflows_schema'))")
            db.execute('''CREATE TABLE IF NOT EXISTS bob_workflows (
                id UUID PRIMARY KEY, username TEXT NOT NULL, spec JSONB NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT true, next_run TIMESTAMPTZ,
                last_job_id UUID, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS bob_workflows_due ON bob_workflows(next_run) WHERE enabled')
        _schema_urls.add(url)


def public(row):
    return {'id': str(row['id']), **row['spec'], 'enabled': row['enabled'],
            'next_run': row['next_run'].isoformat() if row['next_run'] else None,
            'last_job_id': str(row['last_job_id']) if row['last_job_id'] else None,
            'last_error': row['last_error']}


def validate_resources(spec, username=None):
    from app.workspace_config import list_skills
    from app.presentation import get_presentation_template
    if spec.skill_name and spec.skill_name not in {s['name'] for s in list_skills()}:
        raise ValueError('Skill not found')
    if spec.web_search and not os.getenv('BRAVE_API_KEY', '').strip():
        raise ValueError('Web search requires BRAVE_API_KEY in the server environment')
    if spec.web_search and username:
        from app.workspace_config import ensure_brave_mcp
        from app.mcp_access import get_authorized_server
        ensure_brave_mcp()
        if not get_authorized_server(username, 'brave_search'):
            raise ValueError('Your groups do not have access to the web search connection')
    if spec.presentation_format:
        get_presentation_template(spec.template_id)


def _dispatch(db, username, spec, workflow_id=None):
    """Queue + conversation + history commit together; never supersede an active job."""
    session_id, job_id = uuid.uuid4().hex, str(uuid.uuid4())
    scope = 'project:' + spec.project_id if spec.project_id else 'session:' + session_id
    storage._lock(db, username, scope)
    if not db.execute('SELECT 1 FROM users WHERE username=%s', (username,)).fetchone():
        raise ValueError('Account no longer exists')
    if spec.project_id and not db.execute('SELECT 1 FROM projects WHERE username=%s AND id=%s',
                                         (username, spec.project_id)).fetchone():
        raise ValueError('Project no longer exists')
    key = username + ':' + scope
    if db.execute("SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running')", (key,)).fetchone():
        raise ValueError('Project has an active task; retry after it finishes')
    # One outstanding run per saved workflow, even for personal workspaces.
    if workflow_id and db.execute("SELECT 1 FROM bob_jobs WHERE username=%s AND payload->>'workflow_id'=%s AND status IN ('queued','running')",
                                  (username, str(workflow_id))).fetchone():
        raise ValueError('This workflow already has an active run')
    mode, prompt = 'agent', spec.prompt
    if spec.presentation_format:
        from app.presentation import build_presentation_prompt, build_html_presentation_prompt
        mode = 'presentation'
        prompt = (build_html_presentation_prompt(spec.prompt, template_id=spec.template_id, slide_count=spec.slide_count)
                  if spec.presentation_format == 'html' else
                  build_presentation_prompt(spec.template_id, spec.prompt, slide_count=spec.slide_count))
    if spec.skill_name:
        prompt = f'${spec.skill_name} {prompt}'
    if spec.web_search:
        prompt += '\nUse the Brave web search tool for current evidence and cite source URLs.'
    payload = {'ui_language': spec.ui_language, 'prompt': spec.prompt, 'bob_prompt': prompt, 'mode': mode,
               'skill_name': spec.skill_name, 'template_id': spec.template_id,
               'workflow': spec.model_dump(), 'workflow_id': str(workflow_id) if workflow_id else None}
    record = {'id': session_id, 'title': spec.name, 'updated': datetime.now(timezone.utc).isoformat()}
    if spec.project_id:
        record['project_id'] = spec.project_id
    db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)',
               (username, session_id, json.dumps(record)))
    db.execute('''INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status,max_attempts)
                  VALUES (%s,%s,%s,%s,%s::jsonb,'queued',1)''',
               (job_id, username, session_id, key, json.dumps(payload)))
    db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
               (username, session_id, json.dumps({'type': 'request', 'prompt': spec.prompt, 'display_prompt': spec.name + ': ' + spec.prompt, 'mode': mode})))
    db.execute('INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb)',
               (job_id, json.dumps({'type': 'status', 'message': 'Workflow queued', 'job_id': job_id})))
    db.execute("SELECT pg_notify('bob_jobs_ready',%s)", (job_id,))
    return {'job_id': job_id, 'session_id': session_id}


def list_workflows(username):
    ensure_schema()
    with job_queue._connect() as db:
        return [public(r) for r in db.execute('SELECT * FROM bob_workflows WHERE username=%s ORDER BY created_at DESC', (username,))]


def save_workflow(username, spec):
    ensure_schema()
    validate_resources(spec, username)
    with job_queue._connect() as db:
        # Serialize the per-account cap against simultaneous creates.
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('workflows:' + username,))
        if db.execute('SELECT count(*) AS n FROM bob_workflows WHERE username=%s', (username,)).fetchone()['n'] >= 50:
            raise ValueError('Limit of 50 saved workflows reached')
        if spec.project_id and not db.execute('SELECT 1 FROM projects WHERE username=%s AND id=%s', (username, spec.project_id)).fetchone():
            raise ValueError('Project not found')
        row = db.execute('''INSERT INTO bob_workflows(id,username,spec,next_run) VALUES (%s,%s,%s::jsonb,%s) RETURNING *''',
                         (str(uuid.uuid4()), username, spec.model_dump_json(), next_run(spec, datetime.now(timezone.utc)))).fetchone()
    return public(row)


def run_now(username, spec=None, workflow_id=None, ui_language=None):
    ensure_schema()
    with job_queue._connect() as db:
        if workflow_id:
            row = db.execute('SELECT * FROM bob_workflows WHERE username=%s AND id=%s FOR UPDATE', (username, workflow_id)).fetchone()
            if not row:
                return None
            spec = WorkflowSpec(**row['spec'])
        if ui_language is not None:
            spec = spec.model_copy(update={'ui_language': ui_language})
        validate_resources(spec, username)
        result = _dispatch(db, username, spec, workflow_id)
        if workflow_id:
            db.execute('UPDATE bob_workflows SET last_job_id=%s,last_error=NULL WHERE id=%s', (result['job_id'], workflow_id))
        return result


def change_workflow(username, workflow_id, enabled=None, delete=False):
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('SELECT * FROM bob_workflows WHERE username=%s AND id=%s FOR UPDATE', (username, workflow_id)).fetchone()
        if not row:
            return None
        if delete:
            db.execute('DELETE FROM bob_workflows WHERE id=%s', (workflow_id,))
            return {'deleted': True}
        due = next_run(WorkflowSpec(**row['spec']), datetime.now(timezone.utc)) if enabled else None
        row = db.execute('UPDATE bob_workflows SET enabled=%s,next_run=%s,last_error=NULL WHERE id=%s RETURNING *',
                         (enabled, due, workflow_id)).fetchone()
        return public(row)


def dispatch_due():
    ensure_schema()
    # Each occurrence and its queue insert share a transaction and row lock.
    # On downtime we coalesce missed occurrences into one run, never a backlog.
    with job_queue._connect() as db:
        rows = db.execute('''SELECT * FROM bob_workflows WHERE enabled AND next_run<=now()
                             ORDER BY next_run LIMIT 20 FOR UPDATE SKIP LOCKED''').fetchall()
        for row in rows:
            spec = WorkflowSpec(**row['spec'])
            try:
                with db.transaction():
                    result = _dispatch(db, row['username'], spec, row['id'])
                db.execute('UPDATE bob_workflows SET next_run=%s,last_job_id=%s,last_error=NULL WHERE id=%s',
                           (next_run(spec, datetime.now(timezone.utc)), result['job_id'], row['id']))
            except ValueError as exc:
                # Keep the occurrence pending while a project/workflow is busy.
                permanent = 'no longer exists' in str(exc)
                db.execute('UPDATE bob_workflows SET enabled=%s,next_run=%s,last_error=%s WHERE id=%s',
                           (not permanent, None if permanent else datetime.now(timezone.utc) + timedelta(minutes=1), str(exc), row['id']))


async def scheduler_loop():
    while True:
        try:
            await asyncio.to_thread(dispatch_due)
        except Exception:
            logger.exception('Workflow scheduler tick failed')
        await asyncio.sleep(15)


@router.get('/capabilities')
async def capabilities(user=Depends(current_user)):
    from app.workspace_config import ensure_brave_mcp
    from app.mcp_access import get_authorized_server
    await run_in_threadpool(ensure_brave_mcp)
    available = await run_in_threadpool(get_authorized_server, user['username'], 'brave_search')
    return {'web_search': bool(os.getenv('BRAVE_API_KEY', '').strip()) and bool(available), 'team_execution': 'sequential',
            'max_roles': 3, 'max_iterations': 3}


@router.get('')
async def get_workflows(response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return await run_in_threadpool(list_workflows, user['username'])


@router.post('', status_code=201)
async def create_workflow(spec: WorkflowSpec, user=Depends(current_user)):
    try:
        return await run_in_threadpool(save_workflow, user['username'], spec)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/run', status_code=202)
async def start_workflow(spec: WorkflowSpec, user=Depends(current_user)):
    try:
        return await run_in_threadpool(run_now, user['username'], spec)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/{workflow_id}/run', status_code=202)
async def start_saved(workflow_id: uuid.UUID, ui_language: str | None = Body(default=None, embed=True, pattern=r'^(en|el|hi|mt)$'), user=Depends(current_user)):
    try:
        result = await run_in_threadpool(run_now, user['username'], None, workflow_id, ui_language)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(409, str(exc)) from exc
    if result is None:
        raise HTTPException(404, 'Workflow not found')
    return result


class EnabledRequest(BaseModel):
    enabled: bool


@router.patch('/{workflow_id}')
async def toggle_saved(workflow_id: uuid.UUID, req: EnabledRequest, user=Depends(current_user)):
    result = await run_in_threadpool(change_workflow, user['username'], workflow_id, req.enabled)
    if result is None:
        raise HTTPException(404, 'Workflow not found')
    return result


@router.delete('/{workflow_id}')
async def delete_saved(workflow_id: uuid.UUID, user=Depends(current_user)):
    result = await run_in_threadpool(change_workflow, user['username'], workflow_id, delete=True)
    if result is None:
        raise HTTPException(404, 'Workflow not found')
    return result
