"""Administrator-managed account assignments, independent of email domain."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from psycopg.types.json import Jsonb
from app.auth import _connect, current_user, list_users, user_profile

router = APIRouter(prefix='/admin', tags=['administration'])


async def administrator(user: dict = Depends(current_user)):
    if not user['is_admin']:
        raise HTTPException(403, 'Administrator access required')
    return user


class Assignment(BaseModel):
    is_admin: bool


class AdminEmail(BaseModel):
    email: str


class AssignmentChanges(BaseModel):
    model_config = ConfigDict(extra='forbid')
    is_admin: StrictBool = False

    @model_validator(mode='after')
    def require_changes(self):
        if not self.model_fields_set:
            raise ValueError('Select at least one assignment to change')
        return self


class BulkAssignment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    usernames: list[str] = Field(min_length=1, max_length=100)
    changes: AssignmentChanges

    @model_validator(mode='after')
    def unique_usernames(self):
        if len(set(self.usernames)) != len(self.usernames) or any(not name.strip() for name in self.usernames):
            raise ValueError('Select unique, nonempty usernames')
        return self


def normalized_email(value: str) -> str:
    email = value.strip().lower()
    local, separator, domain = email.partition('@')
    if (len(email) > 320 or not local or not separator or '@' in domain
            or '.' not in domain[1:-1] or any(char.isspace() for char in email)):
        raise HTTPException(422, 'Enter a valid email address')
    return email


@router.get('/users')
def users(user: dict = Depends(administrator)):
    with _connect() as db:
        pending = db.execute('SELECT email FROM bob_admin_email_grants ORDER BY email').fetchall()
    return {'users': list_users(), 'pending_admins': [row[0] for row in pending]}


@router.put('/users/bulk')
def update_users(body: BulkAssignment, user: dict = Depends(administrator)):
    changes = body.changes.model_dump(exclude_unset=True)
    updated = 0
    assignments = {}
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('administrator_assignments'))")
        rows = db.execute('SELECT username,is_admin FROM users WHERE username=ANY(%s) ORDER BY username FOR UPDATE', (body.usernames,)).fetchall()
        if len(rows) != len(body.usernames):
            raise HTTPException(404, 'One or more users were not found')
        for username, is_admin in rows:
            before = {'is_admin': bool(is_admin)}
            assignments[username] = (before, before | changes)
        admin_delta = sum(int(after['is_admin']) - int(before['is_admin']) for before, after in assignments.values())
        if db.execute('SELECT count(*) FROM users WHERE is_admin=TRUE').fetchone()[0] + admin_delta < 1:
            raise HTTPException(409, 'At least one administrator must remain')
        for username, (before, after) in assignments.items():
            if before == after:
                continue
            if before['is_admin'] != after['is_admin']:
                db.execute('UPDATE users SET is_admin=%s WHERE username=%s', (after['is_admin'], username))
            db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'update-user-assignment', username, Jsonb({'before': before, 'after': after, 'bulk': True})))
            updated += 1
    return {'users': [user_profile(username, assignments[username][1]['is_admin']) for username in body.usernames], 'updated': updated}


@router.put('/users/{username}')
def update_user(username: str, body: Assignment, user: dict = Depends(administrator)):
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('administrator_assignments'))")
        target = db.execute('SELECT is_admin FROM users WHERE username=%s FOR UPDATE', (username,)).fetchone()
        if not target:
            raise HTTPException(404, 'User not found')
        if target[0] and not body.is_admin and db.execute('SELECT count(*) FROM users WHERE is_admin=TRUE').fetchone()[0] <= 1:
            raise HTTPException(409, 'At least one administrator must remain')
        before = {'is_admin': bool(target[0])}
        db.execute('UPDATE users SET is_admin=%s WHERE username=%s', (body.is_admin, username))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'update-user-assignment', username, Jsonb({'before': before, 'after': body.model_dump()})))
    return user_profile(username, body.is_admin)


@router.post('/administrators')
def add_administrator(body: AdminEmail, user: dict = Depends(administrator)):
    email = normalized_email(body.email)
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('administrator_assignments'))")
        targets = db.execute('SELECT username FROM bob_user_profiles WHERE email=%s AND email_verified=TRUE', (email,)).fetchall()
        if len(targets) > 1:
            raise HTTPException(409, 'Multiple verified accounts use this email; select an account from the user list')
        if targets:
            db.execute('UPDATE users SET is_admin=TRUE WHERE username=%s', (targets[0][0],))
            db.execute('DELETE FROM bob_admin_email_grants WHERE email=%s', (email,))
        else:
            db.execute('INSERT INTO bob_admin_email_grants(email,created_by) VALUES (%s,%s) ON CONFLICT DO NOTHING', (email, user['username']))
        db.execute('INSERT INTO bob_access_audit(actor,action,target) VALUES (%s,%s,%s)', (user['username'], 'grant-administrator' if targets else 'invite-administrator', email))
    return {'email': email, 'pending': not bool(targets)}


@router.delete('/administrators/{email}')
def remove_pending_administrator(email: str, user: dict = Depends(administrator)):
    email = normalized_email(email)
    with _connect() as db:
        db.execute('DELETE FROM bob_admin_email_grants WHERE email=%s', (email,))
        db.execute('INSERT INTO bob_access_audit(actor,action,target) VALUES (%s,%s,%s)', (user['username'], 'remove-pending-administrator', email))
    return {'ok': True}
