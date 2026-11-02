"""Projects plugin: shared Keycloak identity, durable portfolio, scoped impact analysis."""
from app.branding import brand_text
import os
import asyncio
import re
from contextlib import asynccontextmanager, contextmanager
from datetime import date
from typing import Literal
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from psycopg.types.json import Jsonb
from psycopg.errors import SerializationFailure
from psycopg.pq import TransactionStatus
from app.auth import current_user
from app import job_queue
from .impact import analyze

router = APIRouter(prefix='/api/projects', tags=['projects'])


def ensure_schema():
    with job_queue._connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_projects_schema'))")
        db.execute('CREATE SCHEMA IF NOT EXISTS projects')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.projects (
          id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planned',due_date DATE,priority TEXT NOT NULL DEFAULT 'medium',
          milestone TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.people (
          username TEXT PRIMARY KEY REFERENCES users(username),status TEXT NOT NULL DEFAULT 'active',departure_date DATE)''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.assignments (
          id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,
          person_id TEXT NOT NULL REFERENCES users(username),responsibility TEXT NOT NULL,role TEXT NOT NULL,
          backup_person_id TEXT REFERENCES users(username),allocation INTEGER NOT NULL CHECK(allocation BETWEEN 0 AND 100),
          CHECK(backup_person_id IS NULL OR backup_person_id<>person_id))''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.dependencies (
          id BIGSERIAL PRIMARY KEY,source_project_id BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,
          target_project_id BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,description TEXT NOT NULL,
          UNIQUE(source_project_id,target_project_id),CHECK(source_project_id<>target_project_id))''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.events (
          id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.work_items (
          id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',owner_id TEXT REFERENCES users(username),due_date DATE,
          priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
          status TEXT NOT NULL,resolution TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS start_date DATE')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS business_case TEXT NOT NULL DEFAULT \'\'')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS product_description TEXT NOT NULL DEFAULT \'\'')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT \'initiation\'')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS tolerance_days INTEGER NOT NULL DEFAULT 0')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS exception_status TEXT NOT NULL DEFAULT \'within_tolerance\'')
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS tailoring_level TEXT NOT NULL DEFAULT \'standard\'')
        db.execute('ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS start_date DATE')
        # Upgrade work_items check constraints to support PRINCE2 product deliverables and lessons log
        db.execute('ALTER TABLE projects.work_items DROP CONSTRAINT IF EXISTS work_items_kind_check')
        db.execute("ALTER TABLE projects.work_items ADD CONSTRAINT work_items_kind_check CHECK(kind IN ('task','risk','issue','decision','deliverable','lesson','milestone'))")
        db.execute('ALTER TABLE projects.work_items DROP CONSTRAINT IF EXISTS work_items_check')
        db.execute("""ALTER TABLE projects.work_items ADD CONSTRAINT work_items_check CHECK(
            (kind IN ('task','milestone') AND status IN ('todo','in_progress','blocked','done')) OR
            (kind='risk' AND status IN ('open','mitigating','resolved')) OR
            (kind='issue' AND status IN ('open','in_progress','resolved')) OR
            (kind='decision' AND status IN ('proposed','approved','declined')) OR
            (kind='deliverable' AND status IN ('draft','in_development','quality_review','accepted')) OR
            (kind='lesson' AND status IN ('identified','logged','applied')))""")
        db.execute('ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1')
        db.execute('ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1')
        db.execute('ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES projects.work_items(id) ON DELETE SET NULL')
        db.execute("ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS acceptance_evidence TEXT NOT NULL DEFAULT ''")
        db.execute('ALTER TABLE projects.work_items ADD COLUMN IF NOT EXISTS reviewer_id TEXT REFERENCES users(username)')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.work_predecessors (
            work_item_id BIGINT REFERENCES projects.work_items(id) ON DELETE CASCADE,
            predecessor_id BIGINT REFERENCES projects.work_items(id) ON DELETE CASCADE,
            PRIMARY KEY(work_item_id,predecessor_id), CHECK(work_item_id<>predecessor_id))''')
        db.execute('''CREATE TABLE IF NOT EXISTS projects.stage_approvals (
            id BIGSERIAL PRIMARY KEY,project_id BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,
            project_revision BIGINT NOT NULL,stage TEXT NOT NULL,approver_id TEXT NOT NULL REFERENCES users(username),
            decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),evidence TEXT NOT NULL,
            actor TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
        db.execute("CREATE INDEX IF NOT EXISTS projects_events_project_history ON projects.events (((payload->>'project_id')::bigint),id DESC) WHERE action='project.updated'")
        db.execute('CREATE INDEX IF NOT EXISTS projects_approval_project ON projects.stage_approvals(project_id)')
        db.execute('CREATE INDEX IF NOT EXISTS projects_assignment_backup ON projects.assignments(backup_person_id)')
        db.execute('CREATE INDEX IF NOT EXISTS projects_work_project ON projects.work_items(project_id)')
        db.execute('CREATE INDEX IF NOT EXISTS projects_work_owner ON projects.work_items(owner_id)')
        db.execute('CREATE INDEX IF NOT EXISTS projects_assignment_person ON projects.assignments(person_id)')



@contextmanager
def connection():
    # A consistent MVCC view keeps impact evidence and audit records aligned without
    # locking unrelated projects. Concurrent writes to the same row must be retried.
    try:
        with job_queue._connect() as db:
            if db.info.transaction_status == TransactionStatus.IDLE:
                db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            yield db
    except SerializationFailure:
        raise HTTPException(409, {'code': 'revision_conflict', 'message': 'Concurrent change detected. Refresh the portfolio and retry.'}) from None


def check_revision(record, expected):
    if expected is None:
        raise HTTPException(422, 'expected_revision is required')
    if record['revision'] != expected:
        raise HTTPException(409, {'code': 'revision_conflict', 'current_revision': record['revision']})

def issuer():
    return os.getenv('KEYCLOAK_ISSUER', '').strip().rstrip('/')


async def permitted(request: Request, response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if origin and urlsplit(origin).netloc != request.headers.get('host'):
            raise HTTPException(403, 'Cross-origin writes are not allowed')
        own_work_patch = request.method == 'PATCH' and re.fullmatch(r'/api/projects/work-items/[1-9][0-9]*', request.url.path)
        if not user.get('is_admin') and not own_work_patch:
            raise HTTPException(403, 'Project changes require an administrator')
    from app.project_agent_access import require_reader
    return await asyncio.to_thread(require_reader, user)


def directory(db, visible_ids=None):
    if issuer() and db.execute("SELECT to_regclass('public.bob_keycloak_identities') AS relation").fetchone()['relation']:
        return db.execute('''SELECT DISTINCT u.username AS id,COALESCE(NULLIF(p.display_name,''),i.username,u.username) AS name,
            p.email,COALESCE(s.status,'active') AS status,s.departure_date
            FROM users u
            LEFT JOIN bob_keycloak_identities i ON u.username=i.username AND i.issuer=%s
            LEFT JOIN bob_user_profiles p ON p.username=u.username
            LEFT JOIN projects.people s ON s.username=u.username
            WHERE (i.username IS NOT NULL OR u.is_admin=true) AND (%s::text[] IS NULL OR u.username=ANY(%s))
            ORDER BY name,id''', (issuer(), visible_ids, visible_ids)).fetchall()
    return db.execute('''SELECT DISTINCT u.username AS id,COALESCE(NULLIF(p.display_name,''),u.username) AS name,
        p.email,COALESCE(s.status,'active') AS status,s.departure_date
        FROM users u
        LEFT JOIN bob_user_profiles p ON p.username=u.username
        LEFT JOIN projects.people s ON s.username=u.username
        WHERE (%s::text[] IS NULL OR u.username=ANY(%s))
        ORDER BY name,id''', (visible_ids, visible_ids)).fetchall()


def snapshot(db, user):
    admin = bool(user.get('is_admin'))
    visible_sql = "SELECT id FROM projects.projects" if admin else """SELECT project_id FROM projects.assignments WHERE person_id=%s OR backup_person_id=%s
        UNION SELECT project_id FROM projects.work_items WHERE owner_id=%s"""
    params = () if admin else (user['username'],)*3
    ids = [r['id'] if admin else r['project_id'] for r in db.execute(visible_sql, params).fetchall()]
    projects = db.execute('SELECT * FROM projects.projects WHERE id=ANY(%s) ORDER BY id DESC', (ids,)).fetchall()
    assignments = db.execute('SELECT * FROM projects.assignments WHERE project_id=ANY(%s) ORDER BY id', (ids,)).fetchall()
    dependencies = db.execute('SELECT * FROM projects.dependencies WHERE source_project_id=ANY(%s) AND target_project_id=ANY(%s) ORDER BY id', (ids, ids)).fetchall()
    work_items = db.execute("""SELECT w.*,ARRAY(SELECT predecessor_id FROM projects.work_predecessors WHERE work_item_id=w.id ORDER BY predecessor_id) AS predecessor_ids
        FROM projects.work_items w WHERE project_id=ANY(%s) ORDER BY id""", (ids,)).fetchall()
    visible_people = {user['username']} | {a[k] for a in assignments for k in ('person_id','backup_person_id') if a[k]}
    visible_people |= {w[k] for w in work_items for k in ('owner_id','reviewer_id') if w[k]}
    approvals = db.execute('SELECT * FROM projects.stage_approvals WHERE project_id=ANY(%s) ORDER BY id DESC', (ids,)).fetchall()
    visible_people |= {a[k] for a in approvals for k in ('approver_id','actor')}
    people = directory(db, None if admin else list(visible_people))
    for item in work_items:
        item['can_update'] = admin or item['owner_id'] == user['username']
    # Dates are normalized for deterministic preview comparison and JSON audit payloads.
    for row in projects + people + work_items:
        for key, value in list(row.items()):
            if hasattr(value, 'isoformat'):
                row[key] = value.isoformat()
    result = dict(stage_approvals=approvals, projects=projects, work_items=work_items, assignments=assignments, dependencies=dependencies, people=people, can_manage=admin,
        events=db.execute('SELECT * FROM projects.events ORDER BY id DESC LIMIT 100').fetchall() if admin else [])
    allowed_ids = {p['id'] for p in projects}
    recent = db.execute("""SELECT DISTINCT ON ((payload->>'project_id')::bigint) id,created_at,payload
        FROM projects.events WHERE action='project.updated' AND payload ? 'impact' AND (payload->>'project_id')::bigint=ANY(%s)
        ORDER BY (payload->>'project_id')::bigint,id DESC""", (ids,)).fetchall()
    result['recent_change_impacts'] = []
    for record in recent:
        payload = record['payload']
        if payload['project_id'] not in allowed_ids:
            continue
        historical = dict(payload['impact'])
        historical['items'] = [item for item in historical['items'] if set(item['path']) <= allowed_ids]
        historical['summary'] = impact_summary(historical['items'])
        result['recent_change_impacts'].append({'event_id': record['id'], 'created_at': record['created_at'].isoformat(),
            'project_id': payload['project_id'], 'change': payload['changes'], 'impact': historical})
    result['impact'] = analyze(result)
    return result


def impact_summary(items):
    return {'confirmed': sum(i['level'] == 'confirmed' for i in items), 'risks': sum(i['level'] == 'risk' for i in items),
        'affected_projects': len({i['project_id'] for i in items})}


def event(db, user, action, payload):
    db.execute('INSERT INTO projects.events(actor,action,payload) VALUES (%s,%s,%s)', (user['username'], action, Jsonb(payload)))


_PROJECT_COLUMNS = frozenset({
    'name', 'description', 'business_case', 'product_description', 'stage', 'status',
    'start_date', 'due_date', 'priority', 'milestone', 'tolerance_days',
    'exception_status', 'tailoring_level',
})
_WORK_ITEM_COLUMNS = frozenset({
    'project_id', 'kind', 'title', 'description', 'owner_id', 'start_date', 'due_date',
    'priority', 'status', 'resolution', 'parent_id', 'predecessor_ids',
    'acceptance_criteria', 'acceptance_evidence', 'reviewer_id',
})


def _safe_update(table, values, where_clause, where_params):
    """Build a parameterised UPDATE, rejecting any column not in the table allowlist."""
    allowed = _PROJECT_COLUMNS if table == 'projects.projects' else _WORK_ITEM_COLUMNS
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f'Unknown columns for {table}: {unknown}')
    assignments = ','.join(f'{key}=%s' for key in values)
    return f'UPDATE {table} SET {assignments},{where_clause}', (*values.values(), *where_params)


class Project(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=10000)
    business_case: str = Field(default='', max_length=20000)
    product_description: str = Field(default='', max_length=20000)
    stage: Literal['initiation', 'planning', 'delivery', 'closing', 'operational'] = 'initiation'
    status: Literal['planned', 'active', 'paused', 'completed'] = 'planned'
    start_date: date | None = None
    due_date: date | None = None
    priority: Literal['low', 'medium', 'high'] = 'medium'
    milestone: str = Field(default='', max_length=500)
    tolerance_days: int = Field(default=0, ge=0, le=365)
    exception_status: Literal['within_tolerance', 'threatened', 'breached'] = 'within_tolerance'
    tailoring_level: Literal['simple', 'standard', 'corporate'] = 'standard'
    @model_validator(mode='after')
    def trim(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError('Start date must be on or before due date')
        self.name = self.name.strip()
        if not self.name:
            raise ValueError('Enter a project name')
        return self


class ProjectPatch(BaseModel):
    expected_revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)
    business_case: str | None = Field(default=None, max_length=20000)
    product_description: str | None = Field(default=None, max_length=20000)
    stage: Literal['initiation', 'planning', 'delivery', 'closing', 'operational'] | None = None
    status: Literal['planned', 'active', 'paused', 'completed'] | None = None
    start_date: date | None = None
    due_date: date | None = None
    priority: Literal['low', 'medium', 'high'] | None = None
    milestone: str | None = Field(default=None, max_length=500)
    tolerance_days: int | None = Field(default=None, ge=0, le=365)
    exception_status: Literal['within_tolerance', 'threatened', 'breached'] | None = None
    tailoring_level: Literal['simple', 'standard', 'corporate'] | None = None
    @model_validator(mode='after')
    def validate_fields(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError('Start date must be on or before due date')
        for key in self.model_fields_set - {'start_date', 'due_date'}:
            if getattr(self, key) is None:
                raise ValueError(f'{key} cannot be null')
        if self.name is not None:
            self.name = self.name.strip()
            if not self.name:
                raise ValueError('Enter a project name')
        return self


class PersonPatch(BaseModel):
    status: Literal['active', 'leaving', 'departed']
    departure_date: date | None = None


class Assignment(BaseModel):
    project_id: int = Field(gt=0)
    person_id: str = Field(min_length=1, max_length=200)
    responsibility: str = Field(min_length=1, max_length=500)
    role: Literal[
        'executive', 'senior_user', 'senior_supplier', 'project_manager',
        'team_manager', 'project_assurance', 'owner', 'contributor', 'approver'
    ] = 'contributor'
    backup_person_id: str | None = None
    allocation: int = Field(default=0, ge=0, le=100)
    @model_validator(mode='after')
    def validate_assignment(self):
        self.responsibility = self.responsibility.strip()
        if not self.responsibility:
            raise ValueError('Enter a responsibility')
        if self.person_id == self.backup_person_id:
            raise ValueError('Select a different backup person')
        return self


class Dependency(BaseModel):
    source_project_id: int = Field(gt=0)
    target_project_id: int = Field(gt=0)
    description: str = Field(default='', max_length=1000)


WORK_STATUSES = {
    'milestone': ('todo', 'in_progress', 'blocked', 'done'),
    'task': ('todo', 'in_progress', 'blocked', 'done'),
    'risk': ('open', 'mitigating', 'resolved'),
    'issue': ('open', 'in_progress', 'resolved'),
    'decision': ('proposed', 'approved', 'declined'),
    'deliverable': ('draft', 'in_development', 'quality_review', 'accepted'),
    'lesson': ('identified', 'logged', 'applied'),
}


class WorkItem(BaseModel):
    parent_id: int | None = Field(default=None, gt=0)
    predecessor_ids: list[int] = Field(default_factory=list, max_length=500)
    acceptance_criteria: str = Field(default='', max_length=20000)
    acceptance_evidence: str = Field(default='', max_length=20000)
    reviewer_id: str | None = Field(default=None, min_length=1, max_length=200)

    model_config = {'extra': 'forbid'}
    project_id: int = Field(gt=0)
    kind: Literal['task', 'risk', 'issue', 'decision', 'deliverable', 'lesson', 'milestone']
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default='', max_length=20000)
    owner_id: str | None = Field(default=None, min_length=1, max_length=200)
    start_date: date | None = None
    due_date: date | None = None
    priority: Literal['low', 'medium', 'high'] = 'medium'
    status: str | None = None
    resolution: str = Field(default='', max_length=10000)
    @model_validator(mode='after')
    def validate_item(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError('Start date must be on or before due date')
        self.title = self.title.strip()
        if not self.title:
            raise ValueError('Enter a work item title')
        if self.status is None:
            self.status = WORK_STATUSES[self.kind][0]
        if self.status not in WORK_STATUSES[self.kind]:
            raise ValueError('Invalid status for this work item kind')
        return self


class WorkItemPatch(BaseModel):
    expected_revision: int = Field(ge=1)
    parent_id: int | None = Field(default=None, gt=0)
    predecessor_ids: list[int] = Field(default_factory=list, max_length=500)
    acceptance_criteria: str | None = Field(default=None, max_length=20000)
    acceptance_evidence: str | None = Field(default=None, max_length=20000)
    reviewer_id: str | None = Field(default=None, min_length=1, max_length=200)

    model_config = {'extra': 'forbid'}
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=20000)
    owner_id: str | None = Field(default=None, min_length=1, max_length=200)
    start_date: date | None = None
    due_date: date | None = None
    priority: Literal['low', 'medium', 'high'] | None = None
    status: str | None = Field(default=None, max_length=30)
    resolution: str | None = Field(default=None, max_length=10000)
    @model_validator(mode='after')
    def validate_item(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError('Start date must be on or before due date')
        for key in self.model_fields_set - {'owner_id', 'reviewer_id', 'parent_id', 'start_date', 'due_date'}:
            if getattr(self, key) is None:
                raise ValueError(f'{key} cannot be null')
        if self.title is not None:
            self.title = self.title.strip()
            if not self.title:
                raise ValueError('Enter a work item title')
        return self


class Change(BaseModel):
    expected_revision: int | None = Field(default=None, ge=1)
    kind: Literal['person_departure', 'project_change']
    person_id: str | None = None
    project_id: int | None = Field(default=None, gt=0)
    status: str | None = None
    stage: Literal['initiation', 'planning', 'delivery', 'closing', 'operational'] | None = None
    start_date: date | None = None
    due_date: date | None = None
    departure_date: date | None = None
    tolerance_days: int | None = Field(default=None, ge=0, le=365)
    exception_status: Literal['within_tolerance', 'threatened', 'breached'] | None = None
    @model_validator(mode='after')
    def validate_change(self):
        for key in self.model_fields_set & {'status', 'stage', 'exception_status', 'tolerance_days'}:
            if getattr(self, key) is None:
                raise ValueError(f'{key} cannot be null')
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError('Start date must be on or before due date')
        if self.kind == 'person_departure':
            if not self.person_id or self.status not in ('leaving', 'departed'):
                raise ValueError('Select a person and leaving or departed status')
        elif not self.project_id or not ({'status', 'start_date', 'due_date', 'stage', 'exception_status', 'tolerance_days'} & self.model_fields_set):
            raise ValueError('Select a project and status, stage, exception or schedule change')
        elif self.status is not None and self.status not in ('planned', 'active', 'paused', 'completed'):
            raise ValueError('Invalid project status')
        elif 'status' in self.model_fields_set and self.status is None:
            raise ValueError('Project status cannot be null')
        return self


def validate_dates(record, updates):
    start = updates.get('start_date', record.get('start_date'))
    due = updates.get('due_date', record.get('due_date'))
    if isinstance(start, str):
        start = date.fromisoformat(start)
    if isinstance(due, str):
        due = date.fromisoformat(due)
    if start and due and start > due:
        raise HTTPException(422, 'Start date must be on or before due date')


def require_project(db, project_id):
    if not db.execute('SELECT 1 FROM projects.projects WHERE id=%s', (project_id,)).fetchone():
        raise HTTPException(404, 'Project not found')


def require_person(db, person_id):
    if not any(p['id'] == person_id for p in directory(db, [person_id])):
        raise HTTPException(422, 'Select a user who has signed in through the configured Keycloak realm')


@router.get('')
@router.get('/portfolio')
def portfolio(user=Depends(permitted)):
    with connection() as db:
        return snapshot(db, user)


@router.post('/projects', status_code=201)
def create_project(body: Project, user=Depends(permitted)):
    values = body.model_dump(mode='json')
    with connection() as db:
        row = db.execute('''INSERT INTO projects.projects(
          name,description,business_case,product_description,stage,status,
          start_date,due_date,priority,milestone,tolerance_days,exception_status,tailoring_level)
          VALUES (
          %(name)s,%(description)s,%(business_case)s,%(product_description)s,%(stage)s,%(status)s,
          %(start_date)s,%(due_date)s,%(priority)s,%(milestone)s,%(tolerance_days)s,%(exception_status)s,%(tailoring_level)s)
          RETURNING *''', values).fetchone()
        event(db, user, 'project.created', {'project_id': row['id'], **values})
        return row


@router.patch('/projects/{project_id}')
def update_project(project_id: int, body: ProjectPatch, user=Depends(permitted)):
    values = body.model_dump(mode='json', exclude_unset=True, exclude={'expected_revision'})
    with connection() as db:
        original = db.execute('SELECT * FROM projects.projects WHERE id=%s FOR UPDATE', (project_id,)).fetchone()
        if not original:
            raise HTTPException(404, 'Project not found')
        check_revision(original, body.expected_revision)
        before = snapshot(db, user)
        original = next(p for p in before['projects'] if p['id'] == project_id)
        validate_dates(original, values)
        changes = {key: {'before': original.get(key), 'after': value}
            for key, value in values.items() if original.get(key) != value}
        change = {'kind': 'project_change', 'project_id': project_id, **values}
        impact = analyze(before, change)
        if changes:
            sql, params = _safe_update('projects.projects', values, 'revision=revision+1,updated_at=now() WHERE id=%s', (project_id,))
            db.execute(sql, params)
            event(db, user, 'project.updated', {'project_id': project_id, 'changes': changes, 'impact': impact})
        row = db.execute('SELECT * FROM projects.projects WHERE id=%s', (project_id,)).fetchone()
        return {**row, 'impact': impact}


@router.patch('/people/{person_id}')
def update_person(person_id: str, body: PersonPatch, user=Depends(permitted)):
    with connection() as db:
        require_person(db, person_id)
        db.execute('INSERT INTO projects.people(username,status,departure_date) VALUES (%s,%s,%s) ON CONFLICT(username) DO UPDATE SET status=excluded.status,departure_date=excluded.departure_date', (person_id, body.status, body.departure_date))
        event(db, user, 'person.updated', {'person_id': person_id, **body.model_dump(mode='json')})
        return next(p for p in directory(db) if p['id'] == person_id)


@router.post('/assignments', status_code=201)
def create_assignment(body: Assignment, user=Depends(permitted)):
    with connection() as db:
        require_project(db, body.project_id)
        require_person(db, body.person_id)
        if body.backup_person_id:
            require_person(db, body.backup_person_id)
        row = db.execute('''INSERT INTO projects.assignments(project_id,person_id,responsibility,role,backup_person_id,allocation)
          VALUES (%(project_id)s,%(person_id)s,%(responsibility)s,%(role)s,%(backup_person_id)s,%(allocation)s) RETURNING *''', body.model_dump()).fetchone()
        event(db, user, 'assignment.created', dict(row))
        return row


@router.post('/dependencies', status_code=201)
def create_dependency(body: Dependency, user=Depends(permitted)):
    with connection() as db:
        require_project(db, body.source_project_id)
        require_project(db, body.target_project_id)
        if body.source_project_id == body.target_project_id:
            raise HTTPException(422, 'A project cannot depend on itself')
        row = db.execute('''INSERT INTO projects.dependencies(source_project_id,target_project_id,description)
          VALUES (%(source_project_id)s,%(target_project_id)s,%(description)s)
          ON CONFLICT(source_project_id,target_project_id) DO NOTHING RETURNING *''', body.model_dump()).fetchone()
        if not row:
            raise HTTPException(409, 'This dependency already exists')
        event(db, user, 'dependency.created', dict(row))
        return row


@router.delete('/assignments/{entity_id}')
def delete_assignment(entity_id: int, user=Depends(permitted)):
    return delete_entity('assignments', entity_id, user)


@router.delete('/dependencies/{entity_id}')
def delete_dependency(entity_id: int, user=Depends(permitted)):
    return delete_entity('dependencies', entity_id, user)


def delete_entity(table, entity_id, user):
    with connection() as db:
        row = db.execute(f'DELETE FROM projects.{table} WHERE id=%s RETURNING *', (entity_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Record not found')
        event(db, user, f'{table}.deleted', dict(row))
        return {'ok': True}


def validate_change(db, body):
    if body.kind == 'person_departure':
        require_person(db, body.person_id)
    else:
        require_project(db, body.project_id)
        original = db.execute('SELECT start_date,due_date,revision FROM projects.projects WHERE id=%s', (body.project_id,)).fetchone()
        if body.expected_revision is not None:
            check_revision(original, body.expected_revision)
        validate_dates(original, body.model_dump(exclude_unset=True))



def validate_work(db, record, item_id=None):
    if record['kind'] == 'milestone' and not record.get('due_date'):
        raise HTTPException(422, 'Milestones require a due date')
    if record['kind'] == 'deliverable' and record['status'] == 'accepted':
        if not all(str(record.get(k) or '').strip() for k in ('acceptance_criteria', 'reviewer_id', 'acceptance_evidence')):
            raise HTTPException(422, 'Acceptance requires criteria, reviewer and evidence')
    for key in ('owner_id','reviewer_id'):
        if record.get(key):
            require_person(db, record[key])
    links = record.get('predecessor_ids', [])
    if len(set(links)) != len(links) or any(i <= 0 for i in links):
        raise HTTPException(422, 'Predecessors must be unique positive work item IDs')
    related = set(links) | ({record['parent_id']} if record.get('parent_id') else set())
    rows = db.execute('SELECT id FROM projects.work_items WHERE project_id=%s AND id=ANY(%s)', (record['project_id'], list(related))).fetchall()
    if related != {r['id'] for r in rows} or item_id in related:
        raise HTTPException(422, 'Planning relationships must reference other work items in this project')
    if item_id:
        # Follow both hierarchy and predecessor edges to reject mixed cycles too.
        reachable = db.execute("""WITH RECURSIVE edges AS (
            SELECT id AS source,parent_id AS target FROM projects.work_items WHERE project_id=%s AND parent_id IS NOT NULL
            UNION SELECT p.work_item_id,p.predecessor_id FROM projects.work_predecessors p
                JOIN projects.work_items w ON w.id=p.work_item_id WHERE w.project_id=%s
        ), walk(id) AS (
            SELECT unnest(%s::bigint[]) UNION SELECT e.target FROM edges e JOIN walk w ON e.source=w.id
        ) SELECT 1 FROM walk WHERE id=%s LIMIT 1""", (record['project_id'], record['project_id'], list(related), item_id)).fetchone()
        if reachable:
            raise HTTPException(422, 'Planning relationships cannot form a cycle')


def work_record(db, item_id):
    return db.execute("""SELECT w.*,ARRAY(SELECT predecessor_id FROM projects.work_predecessors WHERE work_item_id=w.id ORDER BY predecessor_id) AS predecessor_ids
        FROM projects.work_items w WHERE id=%s""", (item_id,)).fetchone()


def save_predecessors(db, item_id, links):
    db.execute('DELETE FROM projects.work_predecessors WHERE work_item_id=%s', (item_id,))
    for predecessor in links:
        db.execute('INSERT INTO projects.work_predecessors(work_item_id,predecessor_id) VALUES (%s,%s)', (item_id, predecessor))


@router.post('/work-items', status_code=201)
def create_work_item(body: WorkItem, user=Depends(permitted)):
    with connection() as db:
        # Touching this row serializes relationship edits within one project only.
        if not db.execute('UPDATE projects.projects SET updated_at=updated_at WHERE id=%s RETURNING id', (body.project_id,)).fetchone():
            raise HTTPException(404, 'Project not found')
        values = body.model_dump(mode='json')
        validate_work(db, values)
        links = values.pop('predecessor_ids')
        row = db.execute('''INSERT INTO projects.work_items
            (parent_id, acceptance_criteria, acceptance_evidence, reviewer_id, project_id,
             kind, title, description, owner_id, start_date, due_date, priority, status, resolution)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
            (values['parent_id'], values['acceptance_criteria'], values['acceptance_evidence'],
             values['reviewer_id'], values['project_id'], values['kind'], values['title'],
             values['description'], values['owner_id'], values['start_date'], values['due_date'],
             values['priority'], values['status'], values['resolution'])).fetchone()
        save_predecessors(db, row['id'], links)
        event(db, user, 'work_item.created', {'work_item_id': row['id'], **body.model_dump(mode='json')})
        return work_record(db, row['id'])


@router.patch('/work-items/{item_id}')
def update_work_item(item_id: int, body: WorkItemPatch, user=Depends(permitted)):
    values = body.model_dump(mode='json', exclude_unset=True, exclude={'expected_revision'})
    with connection() as db:
        original = work_record(db, item_id)
        if not original:
            raise HTTPException(404, 'Work item not found')
        if not user.get('is_admin'):
            if original['owner_id'] != user['username']:
                raise HTTPException(403, 'Only the assigned owner can update this work item')
            if set(values) - {'status', 'resolution'}:
                raise HTTPException(403, 'Work owners can update status and resolution only')
        db.execute('UPDATE projects.projects SET updated_at=updated_at WHERE id=%s', (original['project_id'],))
        db.execute('SELECT id FROM projects.work_items WHERE id=%s FOR UPDATE', (item_id,))
        check_revision(original, body.expected_revision)
        validate_dates(original, values)
        if 'status' in values and values['status'] not in WORK_STATUSES[original['kind']]:
            raise HTTPException(422, 'Invalid status for this work item kind')
        validate_work(db, {**original, **values}, item_id)
        changes = {key: {'before': original[key].isoformat() if hasattr(original[key], 'isoformat') else original[key], 'after': value}
            for key,value in values.items() if (original[key].isoformat() if hasattr(original[key], 'isoformat') else original[key]) != value}
        if changes:
            links = values.pop('predecessor_ids', None)
            if values:
                sql, params = _safe_update('projects.work_items', values, 'revision=revision+1,updated_at=now() WHERE id=%s', (item_id,))
                db.execute(sql, params)
            else:
                db.execute('UPDATE projects.work_items SET revision=revision+1,updated_at=now() WHERE id=%s', (item_id,))
            if links is not None:
                save_predecessors(db, item_id, links)
            event(db, user, 'work_item.updated', {'work_item_id': item_id, 'project_id': original['project_id'], 'changes': changes})
        return work_record(db, item_id)


class StageApproval(BaseModel):
    model_config = {'extra': 'forbid'}
    expected_revision: int = Field(ge=1)
    stage: Literal['initiation', 'planning', 'delivery', 'closing', 'operational']
    approver_id: str = Field(min_length=1, max_length=200)
    decision: Literal['approved', 'rejected']
    evidence: str = Field(min_length=1, max_length=20000)


@router.post('/projects/{project_id}/stage-approvals', status_code=201)
def create_stage_approval(project_id: int, body: StageApproval, user=Depends(permitted)):
    with connection() as db:
        project = db.execute('SELECT * FROM projects.projects WHERE id=%s FOR UPDATE', (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, 'Project not found')
        check_revision(project, body.expected_revision)
        if body.stage != project['stage']:
            raise HTTPException(422, 'Approval stage must match the current project stage')
        require_person(db, body.approver_id)
        if not body.evidence.strip():
            raise HTTPException(422, 'Approval evidence is required')
        row = db.execute("""INSERT INTO projects.stage_approvals(project_id,project_revision,stage,approver_id,decision,evidence,actor)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *""", (project_id, project['revision'], body.stage, body.approver_id, body.decision, body.evidence.strip(), user['username'])).fetchone()
        event(db, user, 'stage_approval.created', {k:v.isoformat() if hasattr(v,'isoformat') else v for k,v in row.items()})
        return row

@router.delete('/work-items/{item_id}')
def delete_work_item(item_id: int, user=Depends(permitted)):
    with connection() as db:
        existing = db.execute('SELECT project_id FROM projects.work_items WHERE id=%s', (item_id,)).fetchone()
        if existing:
            db.execute('UPDATE projects.projects SET updated_at=updated_at WHERE id=%s', (existing['project_id'],))
        original = work_record(db, item_id)
        if not original:
            raise HTTPException(404, 'Work item not found')
        affected = db.execute("""SELECT w.id FROM projects.work_items w WHERE w.project_id=%s AND
            (w.parent_id=%s OR EXISTS (SELECT 1 FROM projects.work_predecessors p WHERE p.work_item_id=w.id AND p.predecessor_id=%s))
            ORDER BY w.id FOR UPDATE""", (original['project_id'], item_id, item_id)).fetchall()
        previous = {r['id']:work_record(db, r['id']) for r in affected}
        db.execute('DELETE FROM projects.work_items WHERE id=%s', (item_id,))
        for affected_id, before in previous.items():
            db.execute('UPDATE projects.work_items SET revision=revision+1,updated_at=now() WHERE id=%s', (affected_id,))
            after = work_record(db, affected_id)
            changes = {key: {'before': before[key], 'after': after[key]}
                for key in ('parent_id','predecessor_ids') if before[key] != after[key]}
            event(db, user, 'work_item.updated', {'work_item_id': affected_id, 'project_id': original['project_id'],
                'changes': changes, 'reason': 'related_work_item_deleted', 'deleted_work_item_id': item_id})
        payload = {key: value.isoformat() if hasattr(value, 'isoformat') else value for key,value in original.items()}
        event(db, user, 'work_item.deleted', payload)
        return {'ok': True}


@router.post('/impact/preview')
def preview(body: Change, user=Depends(permitted)):
    with connection() as db:
        validate_change(db, body)
        return analyze(snapshot(db, user), body.model_dump(mode='json', exclude_unset=True))


@router.post('/impact/apply')
def apply(body: Change, user=Depends(permitted)):
    with connection() as db:
        if body.kind == 'project_change':
            record = db.execute('SELECT * FROM projects.projects WHERE id=%s FOR UPDATE', (body.project_id,)).fetchone()
            if not record:
                raise HTTPException(404, 'Project not found')
            check_revision(record, body.expected_revision)
        validate_change(db, body)
        change = body.model_dump(mode='json', exclude_unset=True)
        snapshot_before = snapshot(db, user)
        impact = analyze(snapshot_before, change)
        if body.kind == 'person_departure':
            db.execute('INSERT INTO projects.people(username,status,departure_date) VALUES (%s,%s,%s) ON CONFLICT(username) DO UPDATE SET status=excluded.status,departure_date=excluded.departure_date', (body.person_id, body.status, body.departure_date))
        else:
            values = {k: v for k, v in change.items() if k in ('status', 'start_date', 'due_date', 'stage', 'exception_status', 'tolerance_days')}
            original = next(p for p in snapshot_before['projects'] if p['id'] == body.project_id)
            if any(original.get(k) != v for k, v in values.items()):
                sql, params = _safe_update('projects.projects', values, 'revision=revision+1,updated_at=now() WHERE id=%s', (body.project_id,))
                db.execute(sql, params)
        if body.kind == 'project_change':
            original = next(p for p in snapshot_before['projects'] if p['id'] == body.project_id)
            changes = {k: {'before': original.get(k), 'after': v} for k, v in change.items()
                if k in ('status', 'start_date', 'due_date', 'stage', 'exception_status', 'tolerance_days') and original.get(k) != v}
            if changes:
                event(db, user, 'project.updated', {'project_id': body.project_id, 'changes': changes, 'impact': impact})
        event(db, user, 'impact.applied', {'change': change, 'impact': impact})
        return {'impact': impact, 'portfolio': snapshot(db, user)}


@router.get('/context')
def context(project_id: int | None = None, user=Depends(permitted)):
    with connection() as db:
        data = snapshot(db, user)
        if project_id is not None:
            if not any(p['id'] == project_id for p in data['projects']):
                raise HTTPException(404, 'Project not found')
            data['projects'] = [p for p in data['projects'] if p['id'] == project_id]
            data['stage_approvals'] = [a for a in data['stage_approvals'] if a['project_id'] == project_id]
            data['assignments'] = [a for a in data['assignments'] if a['project_id'] == project_id]
            data['work_items'] = [w for w in data['work_items'] if w['project_id'] == project_id]
            data['dependencies'] = [d for d in data['dependencies'] if project_id in (d['source_project_id'], d['target_project_id'])]
            data['impact']['items'] = [i for i in data['impact']['items'] if i['project_id'] == project_id]
            items = data['impact']['items']
            data['impact']['summary'] = {'confirmed': sum(i['level'] == 'confirmed' for i in items), 'risks': sum(i['level'] == 'risk' for i in items), 'affected_projects': len({i['project_id'] for i in items})}
            data['recent_change_impacts'] = [r for r in data['recent_change_impacts'] if r['project_id'] == project_id]
            for record in data['recent_change_impacts']:
                record['impact']['items'] = [i for i in record['impact']['items'] if i['project_id'] == project_id]
                record['impact']['summary'] = impact_summary(record['impact']['items'])
            people_ids = {a[k] for a in data['assignments'] for k in ('person_id', 'backup_person_id') if a[k]}
            people_ids |= {w[k] for w in data['work_items'] for k in ('owner_id','reviewer_id') if w[k]}
            people_ids |= {a[k] for a in data['stage_approvals'] for k in ('approver_id','actor')}
            data['people'] = [p for p in data['people'] if p['id'] in people_ids]
        data.pop('events', None)
        return {'portfolio': data, 'instructions': 'Use only these recorded facts. Explain dependency evidence. Distinguish confirmed gaps from risks. Do not invent dates, progress, workload, replacements or delays. Changes require review in Projects.'}


@router.post('/agent-context')
async def agent_context(request: Request):
    # Only a body-bound service capability can select an owner here.
    from app.app_agent_capabilities import verify
    from app.app_agents import user_record
    from app.project_agent_access import require_reader
    from starlette.concurrency import run_in_threadpool
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 1024:
            raise HTTPException(413, 'Collaboration context request too large')
    username = verify(request.headers.get('authorization', ''), raw)
    class ContextRequest(BaseModel):
        model_config = {'extra': 'forbid'}
        project_id: int | None = Field(default=None, ge=1)
    args = ContextRequest.model_validate_json(raw)
    user = await run_in_threadpool(user_record, username)
    await run_in_threadpool(require_reader, user)
    return await run_in_threadpool(context, args.project_id, user)


def create_app():
    import asyncio
    from fastapi import FastAPI
    from app.access_boundary import AccessBoundaryMiddleware
    @asynccontextmanager
    async def lifespan(app):
        await asyncio.to_thread(ensure_schema)
        yield
    app = FastAPI(title=brand_text('Buddy Projects plugin'), version='1.1.0', lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(AccessBoundaryMiddleware)
    app.include_router(router)
    @app.get('/health')
    def health():
        return {'ok': True}
    @app.get('/ready')
    def ready():
        try:
            with connection() as db:
                db.execute('SELECT 1 FROM projects.projects LIMIT 1')
        except Exception:
            raise HTTPException(503, 'Projects database unavailable') from None
        return {'ok': True}
    @app.get('/plugins/manifest')
    def manifest():
        return {'id': 'projects', 'version': '1.1.0', 'runtime_api': 1, 'schema': 'projects', 'api_prefix': '/api/projects'}
    return app
