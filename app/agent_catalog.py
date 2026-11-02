"""Shared A2A definitions, independent grants, and private user activations."""
from __future__ import annotations
import os
import re
from threading import Lock
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb
from app.auth import _connect, current_user, knowledge_access
from app.admin_users import administrator
from app.a2a_client import discover_agent
from app.safe_http import origin

from app.auth import GROUP_ID_RE

router = APIRouter(tags=['A2A catalog'])
_lock = Lock()
_database = None
MAX_GRANTED_GROUPS = 100
PREFIX = 'catalog-'

def ensure_schema():
    global _database
    database = os.getenv('DATABASE_URL')
    if database and _database == database:
        return
    with _lock:
        if database and _database == database:
            return
        with _connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS bob_agent_catalog (
                id TEXT PRIMARY KEY, definition JSONB NOT NULL,
                groups JSONB NOT NULL DEFAULT '[]', users JSONB NOT NULL DEFAULT '[]',
                enabled BOOLEAN NOT NULL DEFAULT true, updated TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS bob_agent_activations (
                username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                agent_id TEXT NOT NULL REFERENCES bob_agent_catalog(id) ON DELETE CASCADE,
                credentials JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(username,agent_id))''')
        _database = database

def permitted(username, profile, groups, users):
    if not profile:
        return False
    memberships = set(profile.get('groups') or [])
    return username in users or bool(memberships.intersection(groups))

def safe_definition(definition):
    return {key: value for key, value in definition.items() if key not in {'api_key', 'auth_token', 'headers', 'credentials'}}

def summary(row, username, profile):
    agent_id, definition, groups, users, enabled, activated = row
    return {**safe_definition(definition), 'id': agent_id, 'slug': PREFIX + agent_id,
            'groups': groups if profile.get('is_admin') else [], 'users': users if profile.get('is_admin') else [],
            'enabled': enabled, 'allowed': enabled and permitted(username, profile, groups, users),
            'activated': bool(activated), 'can_manage': bool(profile.get('is_admin')), 'catalog': True}

def catalog(username):
    ensure_schema()
    profile = knowledge_access(username) or {}
    with _connect() as db:
        rows = db.execute('''SELECT c.id,c.definition,c.groups,c.users,c.enabled,a.agent_id
            FROM bob_agent_catalog c LEFT JOIN bob_agent_activations a ON a.agent_id=c.id AND a.username=%s
            ORDER BY lower(c.definition->>'name'),c.id''', (username,)).fetchall()
    return [summary(row, username, profile) for row in rows
            if profile.get('is_admin') or row[4] and permitted(username, profile, row[2], row[3])]

def activated_agents(username):
    return [{key: value for key, value in entry.items() if key not in {'groups', 'users', 'can_manage'}}
            for entry in catalog(username) if entry['activated'] and entry['allowed']]

def get_authorized_agent(username, slug):
    """Check live grants again at execution, never trust a previously loaded list."""
    if not slug.startswith(PREFIX):
        return None
    ensure_schema()
    profile = knowledge_access(username)
    with _connect() as db:
        row = db.execute('''SELECT c.definition,c.groups,c.users,c.enabled,a.credentials
            FROM bob_agent_catalog c JOIN bob_agent_activations a ON a.agent_id=c.id AND a.username=%s
            WHERE c.id=%s''', (username, slug[len(PREFIX):])).fetchone()
    if not row or not row[3] or not permitted(username, profile, row[1], row[2]):
        return None
    return {**safe_definition(row[0]), **row[4], 'catalog': True}

class Template(BaseModel):
    id: str = Field(pattern=r'^[a-z][a-z0-9-]{0,47}$')
    card_url: str = Field(min_length=1, max_length=2000)
    discovery_auth_token: str = Field(default='', max_length=8000, repr=False, exclude=True)
    discovery_api_key: str = Field(default='', max_length=8000, repr=False, exclude=True)
    name: str = Field(default='', max_length=200)
    description: str = Field(default='', max_length=4000)
    icon: str = Field(default='', max_length=2000)
    groups: list[str] = Field(default_factory=list, max_length=MAX_GRANTED_GROUPS)
    users: list[str] = Field(default_factory=list, max_length=1000)
    enabled: bool = True

class AccessUpdate(BaseModel):
    groups: list[str] = Field(default_factory=list, max_length=MAX_GRANTED_GROUPS)
    users: list[str] = Field(default_factory=list, max_length=1000)
    enabled: bool = True

class Activation(BaseModel):
    api_key: str = Field(default='', max_length=8000)
    auth_token: str = Field(default='', max_length=8000)
    clear_credentials: bool = False

def validate_grants(groups, users):
    if any(not GROUP_ID_RE.fullmatch(group) for group in groups):
        raise HTTPException(422, 'Unknown A2A access group')
    if any(not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', username) for username in users):
        raise HTTPException(422, 'Invalid selected username')
    if users:
        with _connect() as db:
            found = {row[0] for row in db.execute('SELECT username FROM users WHERE username=ANY(%s)', (users,)).fetchall()}
        if set(users) != found:
            raise HTTPException(422, 'Selected users must exist')

def clean_icon(icon):
    if not icon:
        return ''
    if len(icon) <= 8 and ':' not in icon and '/' not in icon:
        return icon
    parsed = urlsplit(icon)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(422, 'Use an emoji or HTTPS icon URL without credentials')
    return icon

def audit(db, actor, action, target, details):
    db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)',
               (actor, action, target, Jsonb(details)))

@router.get('/agent-catalog')
def list_catalog(response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return catalog(user['username'])

def discovery_error_detail(exc):
    """Actionable categories without reflecting URLs, response bodies or secrets."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in {401, 403}:
            return f'Agent Card returned HTTP {status}. Check the credentials required by the remote server.'
        if status == 404:
            return 'Agent Card returned HTTP 404. Check the complete Agent Card URL.'
        return f'Agent Card returned HTTP {status}.'
    if isinstance(exc, httpx.TimeoutException):
        return 'Agent Card request timed out. Check that the server and port are reachable.'
    if isinstance(exc, httpx.HTTPError):
        return 'Could not connect securely to the Agent Card server. Check connectivity and its TLS certificate.'
    message = str(exc)
    if message == 'Private, loopback, or reserved destinations are blocked':
        return 'The Agent Card or endpoint resolves to a private or restricted address. Add its trusted host to BOB_A2A_ALLOWED_ORIGINS and recreate the API and worker services.'
    if message.startswith('Nonstandard web ports require an approved origin'):
        return 'The Agent Card or endpoint port is not approved. Check BOB_A2A_ALLOWED_ORIGINS or enable BOB_A2A_ALLOW_PUBLIC_PORTS for public agents.'
    if message in {'Agent Card has no JSON-RPC interface', 'Agent Card does not prefer JSON-RPC',
                   'Agent Card must be a JSON object', 'Bearer token cannot contain line breaks',
                   'Agent response exceeds download limit', 'Too many Agent Card redirects'}:
        return message
    return 'Could not discover a supported Agent Card. The server must return valid Agent Card JSON with a supported JSON-RPC interface.'


@router.put('/admin/agent-catalog/{agent_id}')
async def save_template(agent_id: str, body: Template, user=Depends(administrator)):
    if agent_id != body.id:
        raise HTTPException(422, 'Agent identifier cannot change')
    validate_grants(body.groups, body.users)
    try:
        definition = await discover_agent(body.card_url, bearer_token=body.discovery_auth_token,
                                         api_key=body.discovery_api_key)
    except (ValueError, httpx.HTTPError, TypeError) as exc:
        raise HTTPException(422, discovery_error_detail(exc)) from exc
    token = body.discovery_auth_token.strip()
    api_key = body.discovery_api_key.strip()
    if (token or api_key) and origin(definition['endpoint']) != origin(body.card_url):
        raise HTTPException(422, 'The authenticated Agent Card advertises a different endpoint origin. Define it without credentials, then activate it with credentials for that endpoint.')
    header = definition.get('api_key_header', 'x-api-key')
    if not re.fullmatch(r'[!#$%&\x27*+.^_`|~0-9A-Za-z-]+', header) or header.lower() in {'host', 'cookie', 'content-length', 'authorization'}:
        raise HTTPException(422, 'Agent Card declares an unsupported API key header')
    definition.update(name=body.name.strip() or definition['name'],
                      description=body.description.strip() or definition['description'], icon=clean_icon(body.icon or definition.get('icon', '')))
    ensure_schema()
    with _connect() as db:
        old = db.execute('SELECT definition FROM bob_agent_catalog WHERE id=%s FOR UPDATE', (agent_id,)).fetchone()
        # Credentials belong to one target; never forward them after target changes.
        if old and (old[0].get('endpoint') != definition['endpoint'] or old[0].get('card_url') != definition['card_url']):
            db.execute('DELETE FROM bob_agent_activations WHERE agent_id=%s', (agent_id,))
        db.execute('''INSERT INTO bob_agent_catalog(id,definition,groups,users,enabled) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,groups=excluded.groups,users=excluded.users,enabled=excluded.enabled,updated=now()''',
            (agent_id, Jsonb(definition), Jsonb(body.groups), Jsonb(body.users), body.enabled))
        credentials = {key: value for key, value in {'auth_token': token, 'api_key': api_key}.items() if value}
        if credentials:
            # Private activation never grants access; execution still checks live grants.
            db.execute('''INSERT INTO bob_agent_activations(username,agent_id,credentials) VALUES (%s,%s,%s)
                ON CONFLICT(username,agent_id) DO UPDATE SET credentials=bob_agent_activations.credentials || excluded.credentials''',
                (user['username'], agent_id, Jsonb(credentials)))
        audit(db, user['username'], 'save-a2a-catalog', agent_id, {'groups': body.groups, 'users': body.users, 'enabled': body.enabled})
    return next(entry for entry in catalog(user['username']) if entry['id'] == agent_id)

@router.put('/admin/agent-catalog/{agent_id}/access')
def update_access(agent_id: str, body: AccessUpdate, user=Depends(administrator)):
    validate_grants(body.groups, body.users)
    ensure_schema()
    with _connect() as db:
        if not db.execute('UPDATE bob_agent_catalog SET groups=%s,users=%s,enabled=%s,updated=now() WHERE id=%s RETURNING id',
                          (Jsonb(body.groups), Jsonb(body.users), body.enabled, agent_id)).fetchone():
            raise HTTPException(404, 'Agent not found')
        audit(db, user['username'], 'access-a2a-catalog', agent_id, body.model_dump())
    return {'ok': True}

@router.delete('/admin/agent-catalog/{agent_id}', status_code=204)
def delete_template(agent_id: str, user=Depends(administrator)):
    ensure_schema()
    with _connect() as db:
        db.execute('DELETE FROM bob_agent_catalog WHERE id=%s', (agent_id,))
        audit(db, user['username'], 'delete-a2a-catalog', agent_id, {})

@router.put('/agent-catalog/{agent_id}/activation')
def activate(agent_id: str, body: Activation, user=Depends(current_user)):
    ensure_schema()
    username = user['username']
    profile = knowledge_access(username)
    with _connect() as db:
        template = db.execute('SELECT groups,users,enabled FROM bob_agent_catalog WHERE id=%s FOR SHARE', (agent_id,)).fetchone()
        if not template or not template[2] or not permitted(username, profile, template[0], template[1]):
            raise HTTPException(403, 'You do not have access to this A2A agent')
        old = db.execute('SELECT credentials FROM bob_agent_activations WHERE username=%s AND agent_id=%s', (username, agent_id)).fetchone()
        credentials = {} if body.clear_credentials else dict(old[0] if old else {})
        for key in ('api_key', 'auth_token'):
            value = getattr(body, key).strip()
            if '\n' in value or '\r' in value:
                raise HTTPException(422, 'Credentials cannot contain line breaks')
            if value:
                credentials[key] = value
        db.execute('''INSERT INTO bob_agent_activations(username,agent_id,credentials) VALUES (%s,%s,%s)
            ON CONFLICT(username,agent_id) DO UPDATE SET credentials=excluded.credentials''', (username, agent_id, Jsonb(credentials)))
    return {'activated': True, 'slug': PREFIX + agent_id}

@router.delete('/agent-catalog/{agent_id}/activation', status_code=204)
def deactivate(agent_id: str, user=Depends(current_user)):
    ensure_schema()
    with _connect() as db:
        db.execute('DELETE FROM bob_agent_activations WHERE username=%s AND agent_id=%s', (user['username'], agent_id))
