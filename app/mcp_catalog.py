"""Administrator-curated MCP templates and owner-scoped credential connections."""
from __future__ import annotations

import os
import re
from threading import Lock
from typing import Literal
from urllib.parse import urlsplit, parse_qsl

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, model_validator
from psycopg.types.json import Jsonb
from starlette.concurrency import run_in_threadpool

from app.auth import _connect, current_user, knowledge_access
from app.a2a_client import validate_mcp_url as validate_url
from app.workspace_config import build_mcp_config

from app.auth import GROUP_ID_RE

router = APIRouter(prefix='/mcp-catalog', tags=['MCP catalog'])
NAME = r'^[a-z][a-z0-9_-]{0,47}$'
EVERYONE = 'company'
MAX_GRANTED_GROUPS = 100
_schema_lock = Lock()
_schema_database = None


class CredentialField(BaseModel):
    key: str = Field(pattern=r'^[A-Za-z][A-Za-z0-9_-]{0,63}$')
    label: str = Field(min_length=1, max_length=100)
    location: Literal['header', 'env'] = 'header'
    target: str = Field(min_length=1, max_length=100)
    prefix: str = Field(default='', max_length=100)
    required: bool = True

    @model_validator(mode='after')
    def valid_target(self):
        if self.location == 'env' and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', self.target):
            raise ValueError('Use a valid environment variable name')
        if self.location == 'header' and not re.fullmatch(r'[A-Za-z0-9!#$%&\'*+.^_`|~-]+', self.target):
            raise ValueError('Use a valid header name')
        if '\n' in self.prefix or '\r' in self.prefix:
            raise ValueError('Credential prefixes cannot contain newlines')
        return self


class Template(BaseModel):
    id: str = Field(pattern=NAME)
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default='', max_length=2000)
    icon: str = Field(default='plug', pattern=r'^[a-z][a-z0-9_-]{0,31}$')
    category: Literal['knowledge', 'productivity', 'development', 'search', 'data', 'payments', 'monitoring'] = 'productivity'
    docs_url: str = Field(default='', max_length=2000)
    setup_instructions: str = Field(default='', max_length=2000)
    requires_url: bool = False
    auth_mode: Literal['credentials', 'oauth', 'microsoft', 'keycloak', 'none'] = 'credentials'
    oauth_client_id: str = Field(default='', max_length=500)
    oauth_scopes: str = Field(default='', max_length=1000)
    oauth_client_secret_env: str = Field(default='', max_length=100, pattern=r'^(BOB_MCP_OAUTH_[A-Z0-9_]+)?$')
    oauth_token_auth_method: Literal['none', 'client_secret_post', 'client_secret_basic'] = 'none'
    transport: Literal['http', 'sse', 'stdio'] = 'http'
    url: str = Field(default='', max_length=2000)
    command: str = Field(default='', max_length=500)
    args: list[str] = Field(default_factory=list, max_length=30)
    fields: list[CredentialField] = Field(default_factory=list, max_length=12)
    knowledge_base: Literal['company'] = 'company'
    audience: str = Field(default='both', pattern=r'^(both|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')
    access_mode: Literal['groups', 'users', 'grants'] = 'grants'
    groups: list[str] = Field(default_factory=list, max_length=MAX_GRANTED_GROUPS)
    users: list[str] = Field(default_factory=list, max_length=200)
    enabled: bool = True

    @model_validator(mode='after')
    def valid_connection(self):
        if self.id == 'microsoft365' and self.auth_mode != 'microsoft':
            raise ValueError('Microsoft 365 uses the built-in account sign-in')
        if self.id == 'keycloak' and self.auth_mode != 'keycloak':
            raise ValueError('Keycloak uses the built-in read-only identity configuration connector')
        if self.auth_mode == 'keycloak':
            if self.id != 'keycloak' or self.transport != 'stdio' or self.command != 'python3' or self.args != ['-m', 'app.mcp_keycloak'] or self.fields:
                raise ValueError('Keycloak uses the built-in read-only configuration connector')
            if self.url:
                validate_url(self.url)
                parsed = urlsplit(self.url)
                parts = parsed.path.rstrip('/').split('/')
                if parsed.scheme != 'https' or len(parts) < 3 or parts[-2] != 'realms' or any(not re.fullmatch(r'[A-Za-z0-9._~-]+', part) or part in {'.', '..'} for part in parts[1:]) or parsed.query or parsed.fragment:
                    raise ValueError('Enter the HTTPS Keycloak issuer URL ending in /realms/your-realm')
        if self.oauth_token_auth_method != 'none' and not self.oauth_client_secret_env:
            raise ValueError('Enter the server-side environment variable for the OAuth client secret')
        if self.auth_mode == 'microsoft':
            if self.id != 'microsoft365' or self.transport != 'stdio' or self.command != 'python3' or self.args != ['-m', 'app.mcp_microsoft'] or self.fields:
                raise ValueError('Microsoft 365 uses the built-in delegated-account connection')
        if self.auth_mode in {'oauth', 'keycloak', 'none'} and self.fields:
            raise ValueError('Browser sign-in and public servers do not use credential fields')
        if self.auth_mode == 'oauth' and self.transport != 'http':
            raise ValueError('Browser sign-in requires Streamable HTTP')
        if self.auth_mode == 'oauth' and self.url and urlsplit(self.url).scheme != 'https':
            raise ValueError('Browser sign-in requires an HTTPS provider URL')
        if self.docs_url:
            validate_url(self.docs_url)
            if not self.docs_url.startswith('https://'):
                raise ValueError('Documentation links must use HTTPS')
        if self.transport == 'stdio':
            if not self.command.strip():
                raise ValueError('Enter the installed server command')
            from app.mcp_command_policy import validate_stdio_config
            validate_stdio_config({'command': self.command, 'args': self.args,
                                   'env': {field.target: '' for field in self.fields if field.location == 'env'}})
        elif self.url or not self.requires_url:
            validate_url(self.url)
            query = dict(parse_qsl(urlsplit(self.url).query, keep_blank_values=True))
            if '#' in self.url or query and not (self.auth_mode == 'oauth' and query == {'login': ''}):
                raise ValueError('Keep credentials and query parameters out of catalog URLs')
        if len({field.key for field in self.fields}) != len(self.fields):
            raise ValueError('Credential field keys must be unique')
        if len({(field.location, field.target.lower() if field.location == 'header' else field.target) for field in self.fields}) != len(self.fields):
            raise ValueError('Credential targets must be unique')
        if any(field.location != ('env' if self.transport == 'stdio' else 'header') for field in self.fields):
            raise ValueError('Local servers use environment credentials; remote servers use headers')
        if any(not re.fullmatch(r'[a-z][a-z0-9-]{2,63}', name) for name in self.users):
            raise ValueError('Enter valid account usernames')
        if any(group != EVERYONE and not GROUP_ID_RE.fullmatch(group) for group in self.groups):
            raise ValueError('Unknown MCP access group')
        return self


class AccessUpdate(BaseModel):
    groups: list[str] = Field(default_factory=list, max_length=MAX_GRANTED_GROUPS)
    users: list[str] = Field(default_factory=list, max_length=200)
    enabled: bool = True


class ConnectRequest(BaseModel):
    credentials: dict[str, str] = Field(default_factory=dict, max_length=12)


DEFAULTS = [
    Template(id='github', name='GitHub', icon='github', description='Search repositories, review issues and work with pull requests using GitHub’s official MCP server.', access_mode='groups', url='https://api.githubcopilot.com/mcp/', fields=[CredentialField(key='token', label='Personal access token', target='Authorization', prefix='Bearer ')]),
    Template(id='monday', name='Monday', icon='board', description='Work with boards, items and project tasks using the installed Monday MCP server.', access_mode='groups', transport='stdio', command='mcp-server-monday-api', fields=[CredentialField(key='token', label='Monday API token', location='env', target='MONDAY_TOKEN')]),
]
from app.mcp_catalog_templates import PROVIDERS
DEFAULTS.extend(Template.model_validate(provider) for provider in PROVIDERS)


def ensure_schema():
    global _schema_database
    database = os.getenv('DATABASE_URL')
    if database and _schema_database == database:
        return
    with _schema_lock:
        if database and _schema_database == database:
            return
        with _connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS bob_mcp_catalog (
                id TEXT PRIMARY KEY, definition JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS bob_mcp_catalog_connections (
                username TEXT NOT NULL REFERENCES users(username), template_id TEXT NOT NULL REFERENCES bob_mcp_catalog(id) ON DELETE CASCADE,
                credentials JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(username,template_id))''')
            for item in DEFAULTS:
                db.execute('INSERT INTO bob_mcp_catalog(id,definition) VALUES (%s,%s) ON CONFLICT DO NOTHING', (item.id, Jsonb(item.model_dump())))
        _schema_database = database


def permitted(item, profile, username):
    from app.mcp_access import permitted as groups_permitted
    if not item.get('enabled', True) or profile is None:
        return False
    # Administrators can connect and use every enabled catalog server.
    # Provider credentials remain scoped to the account making the request.
    if profile.get('is_admin'):
        return True
    if item.get('access_mode') == 'users':
        return username in item.get('users', [])
    if item.get('access_mode') == 'grants':
        memberships = {EVERYONE, *(profile.get('groups') or [])}
        return username in item.get('users', []) or bool(memberships.intersection(item.get('groups', [])))
    return groups_permitted(profile, item.get('knowledge_base', 'company'), item.get('audience', 'both'))


def access_groups(item):
    """Represent legacy audience rules exactly; opening the editor does not broaden them."""
    if item.get('access_mode') == 'grants':
        return item.get('groups', [])
    if item.get('access_mode') == 'users':
        return []
    audience = item.get('audience', 'both')
    return [EVERYONE if audience == 'both' else audience]


def assemble(item, credentials):
    template = Template.model_validate(item)
    if template.transport != 'stdio' and not template.url:
        raise ValueError('An administrator must configure this server URL first')
    if set(credentials) - {field.key for field in template.fields}:
        raise ValueError('Unknown credential field')
    headers, env = {}, {}
    for field in template.fields:
        value = credentials.get(field.key, '')
        if field.required and not value.strip():
            raise ValueError(f'Enter {field.label}')
        if len(value) > 8192 or (field.location == 'header' and ('\n' in value or '\r' in value)):
            raise ValueError('Invalid credential value')
        if value:
            (env if field.location == 'env' else headers)[field.target] = field.prefix + value
    return build_mcp_config(template.transport, template.url, template.command, template.args, {}, headers, env, '', '', '')


def microsoft_connected(username):
    import json
    from app.microsoft_auth import _user_token_file
    from app import postgres_storage as storage
    content = storage.read_user_file(_user_token_file(username))
    try:
        return bool(content and json.loads(content).get('access_token'))
    except (ValueError, TypeError):
        return False


def native_microsoft_config(username):
    from app.microsoft_auth import _user_token_file
    return {'command': 'python3', 'args': ['-m', 'app.mcp_microsoft'],
            '_catalog_native': 'microsoft365',
            'env': {'BOB_MICROSOFT_TOKEN_FILE': str(_user_token_file(username))}}


def native_policy_active():
    if not os.getenv('DATABASE_URL'):
        return False
    ensure_schema()
    with _connect() as db:
        row = db.execute("SELECT definition FROM bob_mcp_catalog WHERE id='microsoft365'").fetchone()
    return bool(row and row[0].get('native_policy_active'))


def allowed_connections(username, profile=None):
    # No catalog database exists in offline unit-test environments.
    if not os.getenv('DATABASE_URL'):
        return {}
    ensure_schema()
    profile = knowledge_access(username) if profile is None else profile
    with _connect() as db:
        rows = db.execute('''SELECT t.id,t.definition,c.credentials FROM bob_mcp_catalog t
            LEFT JOIN bob_mcp_catalog_connections c ON c.template_id=t.id AND c.username=%s''', (username,)).fetchall()
    result = {}
    oauth_ids = None
    for template_id, definition, credentials in rows:
        if permitted(definition, profile, username):
            try:
                mode = definition.get('auth_mode', 'credentials')
                if mode == 'microsoft':
                    if microsoft_connected(username):
                        result['microsoft365'] = native_microsoft_config(username)
                elif mode in {'oauth', 'keycloak'}:
                    from app.mcp_oauth import access_token, ensure_schema as oauth_schema
                    if oauth_ids is None:
                        oauth_schema()
                        with _connect() as db:
                            oauth_ids = {row[0] for row in db.execute('SELECT template_id FROM bob_mcp_oauth_tokens WHERE username=%s', (username,)).fetchall()}
                    if template_id not in oauth_ids:
                        continue
                    token = access_token(username, template_id, definition)
                    if token:
                        config = assemble(definition, {})
                        if mode == 'keycloak':
                            config['env'] = {'BOB_KEYCLOAK_MCP_TOKEN': token, 'BOB_KEYCLOAK_MCP_ISSUER': definition['url'], 'BOB_KEYCLOAK_MCP_CLIENT_ID': definition.get('oauth_client_id', '')}
                        else:
                            config['headers'] = {'Authorization': 'Bearer ' + token}
                        result['catalog-' + template_id] = config
                elif credentials is not None:
                    result['catalog-' + template_id] = assemble(definition, credentials)
            except ValueError:
                continue  # Changed credential requirements need the owner to reconnect.
    return result


def catalog(username, admin=False):
    from app.mcp_access import configured_providers
    shared_providers = configured_providers(username)
    ensure_schema()
    profile = knowledge_access(username)
    with _connect() as db:
        rows = db.execute('''SELECT t.definition,c.template_id FROM bob_mcp_catalog t
            LEFT JOIN bob_mcp_catalog_connections c ON c.template_id=t.id AND c.username=%s ORDER BY t.definition->>'name' ''', (username,)).fetchall()
    result = []
    for item, connected in rows:
        # Keep saved personal connections visible, but do not offer duplicate
        # setup when an accessible shared connection already supplies it.
        if item['id'] in shared_providers and not connected:
            continue
        allowed = permitted(item, profile, username)
        if allowed or admin:
            public = dict(item) if admin else {key: item[key] for key in ('id', 'name', 'description', 'icon', 'fields')}
            public.update({key: item.get(key, default) for key, default in [('auth_mode', 'credentials'), ('category', 'productivity'), ('docs_url', ''), ('setup_instructions', '')]})
            public['ready'] = item.get('transport') == 'stdio' or bool(item.get('url'))
            if admin:
                public['groups'] = access_groups(item)
            if item.get('auth_mode') == 'microsoft':
                connected = microsoft_connected(username)
                public['ready'] = bool(os.getenv('AZURE_CLIENT_ID'))
            elif item.get('auth_mode') in {'oauth', 'keycloak'}:
                from app.mcp_oauth import status
                connected = status(username, item['id'], item).get('connected', False)
                if item.get('auth_mode') == 'keycloak':
                    public['ready'] = bool(item.get('url') and item.get('oauth_client_id'))
            result.append({**public, 'connected': bool(connected), 'allowed': allowed})
    return result


def save_template(template, actor):
    ensure_schema()
    from app.mcp_oauth import ensure_schema as oauth_schema, invalidate_template
    oauth_schema()
    with _connect() as db:
        # Ensure usernames refer to real accounts rather than silently granting nobody access.
        if template.users:
            found = {row[0] for row in db.execute('SELECT username FROM users WHERE username=ANY(%s)', (template.users,)).fetchall()}
            if found != set(template.users):
                raise ValueError('One or more selected users do not exist')
        previous = db.execute('SELECT definition FROM bob_mcp_catalog WHERE id=%s FOR UPDATE', (template.id,)).fetchone()
        previous_config = Template.model_validate(previous[0]).model_dump() if previous else None
        if previous_config and any(previous_config.get(key) != template.model_dump().get(key) for key in ('transport', 'url', 'command', 'args', 'fields', 'auth_mode', 'oauth_client_id', 'oauth_scopes', 'oauth_client_secret_env', 'oauth_token_auth_method')):
            # Credentials must never silently follow a changed endpoint or command.
            db.execute('DELETE FROM bob_mcp_catalog_connections WHERE template_id=%s', (template.id,))
            invalidate_template(template.id, db=db)
        definition = template.model_dump()
        if template.auth_mode == 'microsoft':
            definition['native_policy_active'] = True
        db.execute('INSERT INTO bob_mcp_catalog(id,definition) VALUES (%s,%s) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,updated_at=now()', (template.id, Jsonb(definition)))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (actor, 'save-mcp-template', template.id, Jsonb({'name': template.name, 'access_mode': template.access_mode, 'groups': template.groups, 'users': template.users, 'enabled': template.enabled})))
    return {'id': template.id}


def save_access(template_id, body, actor):
    ensure_schema()
    with _connect() as db:
        previous = db.execute('SELECT definition FROM bob_mcp_catalog WHERE id=%s FOR UPDATE', (template_id,)).fetchone()
        if not previous:
            raise HTTPException(404, 'MCP server not found')
        updated = Template.model_validate({**previous[0], 'access_mode': 'grants', **body.model_dump()})
        if updated.users:
            found = {row[0] for row in db.execute('SELECT username FROM users WHERE username=ANY(%s)', (updated.users,)).fetchall()}
            if found != set(updated.users):
                raise ValueError('One or more selected users do not exist')
        definition = updated.model_dump()
        if updated.auth_mode == 'microsoft':
            definition['native_policy_active'] = True
        db.execute('UPDATE bob_mcp_catalog SET definition=%s,updated_at=now() WHERE id=%s', (Jsonb(definition), template_id))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (actor, 'access-mcp-catalog', template_id, Jsonb({'before': {'groups': access_groups(previous[0]), 'users': previous[0].get('users', []), 'enabled': previous[0].get('enabled', True)}, 'after': body.model_dump()})))
    return {'id': template_id}


def connect(username, template_id, credentials):
    ensure_schema()
    profile = knowledge_access(username)
    with _connect() as db:
        row = db.execute('SELECT definition FROM bob_mcp_catalog WHERE id=%s FOR SHARE', (template_id,)).fetchone()
        if not row or not permitted(row[0], profile, username):
            raise HTTPException(404, 'Catalog entry not available')
        old = db.execute('SELECT credentials FROM bob_mcp_catalog_connections WHERE username=%s AND template_id=%s', (username, template_id)).fetchone()
        if row[0].get('auth_mode') in {'oauth', 'keycloak'}:
            raise ValueError('Use browser sign-in for this server')
        if row[0].get('auth_mode') == 'microsoft':
            raise ValueError('Use Microsoft account sign-in for this server')
        # Blank credential fields preserve the caller’s existing secrets.
        keys = {field['key'] for field in row[0]['fields']}
        if set(credentials) - keys:
            raise ValueError('Unknown credential field')
        merged = {**{key: value for key, value in (old[0] if old else {}).items() if key in keys}, **{key: value for key, value in credentials.items() if value}}
        assemble(row[0], merged)
        db.execute('''INSERT INTO bob_mcp_catalog_connections(username,template_id,credentials) VALUES (%s,%s,%s)
            ON CONFLICT(username,template_id) DO UPDATE SET credentials=excluded.credentials,updated_at=now()''', (username, template_id, Jsonb(merged)))
    return {'connected': True, 'server_name': 'catalog-' + template_id}


@router.get('')
async def list_catalog(response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return await run_in_threadpool(catalog, user['username'], user['is_admin'])


@router.put('/{template_id}')
async def put_template(template_id: str, req: Template, user=Depends(current_user)):
    if not user['is_admin']:
        raise HTTPException(403, 'Only administrators can publish MCP templates')
    if template_id != req.id:
        raise HTTPException(422, 'Template identifiers must match')
    try:
        return await run_in_threadpool(save_template, req, user['username'])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post('/{template_id}/connect')
async def connect_template(template_id: str, req: ConnectRequest, user=Depends(current_user)):
    try:
        return await run_in_threadpool(connect, user['username'], template_id, req.credentials)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.put('/{template_id}/access')
async def assign_access(template_id: str, req: AccessUpdate, user=Depends(current_user)):
    if not user['is_admin']:
        raise HTTPException(403, 'Only administrators can assign MCP server access')
    try:
        return await run_in_threadpool(save_access, template_id, req, user['username'])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete('/{template_id}/connection', status_code=204)
async def disconnect_template(template_id: str, user=Depends(current_user)):
    from app.mcp_oauth import disconnect
    await run_in_threadpool(disconnect, user['username'], template_id)
    def remove():
        ensure_schema()
        if template_id == 'microsoft365':
            from app.microsoft_auth import _user_token_file
            from app import postgres_storage as storage
            storage.remove_user_file(_user_token_file(user['username']))
        with _connect() as db:
            db.execute('DELETE FROM bob_mcp_catalog_connections WHERE username=%s AND template_id=%s', (user['username'], template_id))
    await run_in_threadpool(remove)


@router.post('/{template_id}/check')
async def check_template(template_id: str, user=Depends(current_user)):
    from app.mcp_health import probe_mcp
    from app.workspace_config import _root
    configs = await run_in_threadpool(allowed_connections, user['username'])
    name = 'microsoft365' if template_id == 'microsoft365' else 'catalog-' + template_id
    config = configs.get(name)
    if config is None:
        raise HTTPException(404, 'Connect this catalog entry first')
    return await probe_mcp(config, cwd=str(_root()), server_name=name)
