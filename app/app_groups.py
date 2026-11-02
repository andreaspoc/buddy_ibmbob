"""Application-managed groups and explicit roles; external identity claims grant neither."""
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from app.origin_policy import same_origin

router = APIRouter(prefix='/admin', tags=['application groups'])
ROLE = 'learning_teacher'
MAX_GROUPS = 500


def schema(db):
    """Additive DDL also works on auth's ordinary tuple-returning connection."""
    db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_app_groups_schema'))")
    db.execute('''CREATE TABLE IF NOT EXISTS bob_app_groups (
        id UUID PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS bob_app_groups_name ON bob_app_groups(lower(name))')
    db.execute('''CREATE TABLE IF NOT EXISTS bob_app_group_members (
        group_id UUID REFERENCES bob_app_groups(id) ON DELETE CASCADE,
        username TEXT REFERENCES users(username) ON DELETE CASCADE,
        PRIMARY KEY(group_id,username))''')
    db.execute('CREATE INDEX IF NOT EXISTS bob_app_group_members_user ON bob_app_group_members(username)')
    db.execute('''CREATE TABLE IF NOT EXISTS bob_app_roles (
        username TEXT REFERENCES users(username) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('learning_teacher')),
        created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(username,role))''')
    db.execute('''CREATE TABLE IF NOT EXISTS bob_app_role_revisions (
        role TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1)''')
    db.execute("INSERT INTO bob_app_role_revisions(role) VALUES('learning_teacher') ON CONFLICT DO NOTHING")
    db.execute('''CREATE TABLE IF NOT EXISTS bob_app_group_audit (
        id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')


def has_role(db, username, role=ROLE):
    if role != ROLE:
        return False
    identity = username.get('username') if isinstance(username, dict) else username
    return bool(identity and db.execute('SELECT 1 FROM bob_app_roles WHERE username=%s AND role=%s', (identity, role)).fetchone())


def member_of(db, username, group_id):
    identity = username.get('username') if isinstance(username, dict) else username
    return bool(identity and db.execute('SELECT 1 FROM bob_app_group_members WHERE group_id=%s AND username=%s', (str(group_id), identity)).fetchone())


async def _verified_user(request: Request):
    # Lazy import avoids an auth bootstrap -> schema -> auth import cycle.
    from app.auth import current_user
    return await current_user(request)


def administrator(user=Depends(_verified_user)):
    if not user.get('is_admin'):
        raise HTTPException(403, 'Administrator access required')
    return user


def _connect():
    from app import job_queue
    return job_queue._connect()


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class GroupInput(Strict):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default='', max_length=2000)

    @field_validator('name')
    @classmethod
    def actual_name(cls, value):
        value = ' '.join(value.split())
        if not value:
            raise ValueError('Enter a group name')
        return value


class GroupUpdate(GroupInput):
    expected_revision: int = Field(ge=1, strict=True)


class RosterInput(Strict):
    usernames: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=1000)
    expected_revision: int = Field(ge=1, strict=True)

    @field_validator('usernames')
    @classmethod
    def exact_unique(cls, value):
        if len(set(value)) != len(value) or any(not name.strip() or name != name.strip() for name in value):
            raise ValueError('Select unique existing user accounts')
        return value


def _group(db, group_id, lock=False):
    row = db.execute('SELECT * FROM bob_app_groups WHERE id=%s' + (' FOR UPDATE' if lock else ''), (str(group_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Application group not found')
    return row


def _revision(row, expected):
    if row['revision'] != expected:
        raise HTTPException(409, 'This roster or group changed. Refresh before saving.')


def _existing_users(db, usernames):
    if usernames:
        users = db.execute('SELECT username FROM users WHERE username=ANY(%s)', (usernames,)).fetchall()
        if {row['username'] for row in users} != set(usernames):
            raise HTTPException(422, 'One or more selected user accounts no longer exist')


def _audit(db, user, action, target, details=None):
    db.execute('INSERT INTO bob_app_group_audit(actor,action,target,details) VALUES(%s,%s,%s,%s)',
               (user['username'], action, str(target), Jsonb(details or {})))


def _display(row):
    """Profile text is for display; the exact stored username remains the ACL key."""
    name = (row.get('display_name') or '').strip()
    if not name or name == row['username'] and row['username'].startswith('kc-'):
        name = 'User' if row['username'].startswith('kc-') else row['username']
    return {**row, 'display_name': name}


@router.get('/app-groups/directory')
def user_directory(user=Depends(administrator)):
    with _connect() as db:
        rows = db.execute('''SELECT u.username,u.is_admin,p.display_name,p.email FROM users u
            LEFT JOIN bob_user_profiles p ON p.username=u.username ORDER BY COALESCE(NULLIF(p.display_name,''),u.username),u.username LIMIT 5001''').fetchall()
    return {'items': [_display(row) for row in rows[:5000]], 'truncated': len(rows) > 5000}


@router.get('/app-groups')
def groups(user=Depends(administrator)):
    with _connect() as db:
        rows = db.execute('''SELECT g.*,count(m.username)::int AS member_count FROM bob_app_groups g
            LEFT JOIN bob_app_group_members m ON m.group_id=g.id GROUP BY g.id ORDER BY lower(g.name),g.id''').fetchall()
    return {'items': rows}


@router.post('/app-groups', dependencies=[Depends(same_origin)])
def create_group(req: GroupInput, user=Depends(administrator)):
    try:
        with _connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_app_group_creation'))")
            if db.execute('SELECT count(*) AS count FROM bob_app_groups').fetchone()['count'] >= MAX_GROUPS:
                raise HTTPException(422, 'Use at most 500 application groups')
            row = db.execute('INSERT INTO bob_app_groups(id,name,description,created_by) VALUES(%s,%s,%s,%s) RETURNING *',
                             (str(uuid4()), req.name, req.description, user['username'])).fetchone()
            _audit(db, user, 'create-group', row['id'], {'name': req.name})
            return {**row, 'member_count': 0}
    except UniqueViolation:
        raise HTTPException(409, 'An application group with this name already exists') from None


@router.get('/app-groups/{group_id}')
def group(group_id: UUID, user=Depends(administrator)):
    with _connect() as db:
        row = _group(db, group_id)
        people = db.execute('''SELECT u.username,u.is_admin,p.display_name,p.email FROM bob_app_group_members m
            JOIN users u ON u.username=m.username LEFT JOIN bob_user_profiles p ON p.username=m.username
            WHERE m.group_id=%s ORDER BY COALESCE(NULLIF(p.display_name,''),u.username),u.username''', (str(group_id),)).fetchall()
    return {**row, 'members': [_display(person) for person in people]}


@router.put('/app-groups/{group_id}', dependencies=[Depends(same_origin)])
def edit_group(group_id: UUID, req: GroupUpdate, user=Depends(administrator)):
    try:
        with _connect() as db:
            row = _group(db, group_id, lock=True)
            _revision(row, req.expected_revision)
            updated = db.execute('UPDATE bob_app_groups SET name=%s,description=%s,revision=revision+1 WHERE id=%s RETURNING *',
                                 (req.name, req.description, str(group_id))).fetchone()
            _audit(db, user, 'edit-group', group_id, {'before_name': row['name'], 'name': req.name})
            return updated
    except UniqueViolation:
        raise HTTPException(409, 'An application group with this name already exists') from None


@router.put('/app-groups/{group_id}/members', dependencies=[Depends(same_origin)])
def replace_members(group_id: UUID, req: RosterInput, user=Depends(administrator)):
    with _connect() as db:
        row = _group(db, group_id, lock=True)
        _revision(row, req.expected_revision)
        _existing_users(db, req.usernames)
        db.execute('DELETE FROM bob_app_group_members WHERE group_id=%s', (str(group_id),))
        for username in req.usernames:
            db.execute('INSERT INTO bob_app_group_members(group_id,username) VALUES(%s,%s)', (str(group_id), username))
        if db.execute("SELECT to_regclass('learning.folder_app_groups') AS relation").fetchone()['relation'] and db.execute("SELECT to_regclass('learning.class_members') AS relation").fetchone()['relation']:
            db.execute('''INSERT INTO learning.class_members(class_id,username)
                SELECT c.id, gm.username FROM learning.classes c
                JOIN learning.folder_app_groups fg ON fg.folder_id=c.folder_id
                JOIN bob_app_group_members gm ON gm.group_id=fg.group_id
                WHERE fg.group_id=%s
                ON CONFLICT (class_id,username) DO NOTHING''', (str(group_id),))
        updated = db.execute('UPDATE bob_app_groups SET revision=revision+1 WHERE id=%s RETURNING *', (str(group_id),)).fetchone()
        _audit(db, user, 'replace-group-members', group_id, {'usernames': req.usernames})
    return {**updated, 'member_count': len(req.usernames)}


@router.delete('/app-groups/{group_id}', dependencies=[Depends(same_origin)])
def delete_group(group_id: UUID, expected_revision: int = Query(ge=1), user=Depends(administrator)):
    with _connect() as db:
        row = _group(db, group_id, lock=True)
        _revision(row, expected_revision)
        _audit(db, user, 'delete-group', group_id, {'name': row['name']})
        db.execute('DELETE FROM bob_app_groups WHERE id=%s', (str(group_id),))
    return {'deleted': True}


@router.get('/learning-teachers')
def teachers(user=Depends(administrator)):
    with _connect() as db:
        revision = db.execute('SELECT revision FROM bob_app_role_revisions WHERE role=%s', (ROLE,)).fetchone()['revision']
        rows = db.execute('''SELECT u.username,u.is_admin,p.display_name,p.email FROM bob_app_roles r
            JOIN users u ON u.username=r.username LEFT JOIN bob_user_profiles p ON p.username=r.username
            WHERE r.role=%s ORDER BY COALESCE(NULLIF(p.display_name,''),u.username),u.username''', (ROLE,)).fetchall()
    return {'role': ROLE, 'revision': revision, 'items': [_display(row) for row in rows]}


@router.put('/learning-teachers', dependencies=[Depends(same_origin)])
def replace_teachers(req: RosterInput, user=Depends(administrator)):
    with _connect() as db:
        row = db.execute('SELECT revision FROM bob_app_role_revisions WHERE role=%s FOR UPDATE', (ROLE,)).fetchone()
        if not row:
            raise HTTPException(503, 'Application roles are not initialized')
        _revision(row, req.expected_revision)
        _existing_users(db, req.usernames)
        db.execute('DELETE FROM bob_app_roles WHERE role=%s', (ROLE,))
        for username in req.usernames:
            db.execute('INSERT INTO bob_app_roles(username,role,created_by) VALUES(%s,%s,%s)', (username, ROLE, user['username']))
        updated = db.execute('UPDATE bob_app_role_revisions SET revision=revision+1 WHERE role=%s RETURNING revision', (ROLE,)).fetchone()
        _audit(db, user, 'replace-learning-teachers', ROLE, {'usernames': req.usernames})
    return {'role': ROLE, 'revision': updated['revision'], 'usernames': req.usernames}
