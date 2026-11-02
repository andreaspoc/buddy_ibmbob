"""Administrator-managed model profiles; credentials are encrypted and write-only."""
from __future__ import annotations

import json
import uuid
from typing import Literal
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from psycopg.types.json import Jsonb

from app.admin_users import administrator
from app.auth import _connect
from app.bob_key_settings import _cipher

router = APIRouter(prefix='/admin/buddy-profiles', tags=['administration'])
Provider = Literal['openai', 'azure', 'anthropic', 'watsonx', 'gemini', 'bedrock', 'openai_compatible']


class Profile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    provider: Provider
    model: str = Field(min_length=1, max_length=200)
    endpoint: str = Field(default='', max_length=2048)
    region: str = Field(default='', max_length=100)
    project_id: str = Field(default='', max_length=200)
    instructions: str = Field(default='', max_length=16000)
    allowed_tools: list[Literal['knowledge', 'mcp', 'files', 'commands', 'web']] = Field(default_factory=list, max_length=5)
    api_key: str = Field(default='', max_length=16384, repr=False)
    access_key_id: str = Field(default='', max_length=4096, repr=False)
    secret_access_key: str = Field(default='', max_length=16384, repr=False)
    session_token: str = Field(default='', max_length=16384, repr=False)

    @field_validator('name', 'model', 'endpoint', 'region', 'project_id', 'api_key', 'access_key_id', 'secret_access_key', 'session_token')
    @classmethod
    def clean(cls, value):
        value = value.strip()
        if any(c in value for c in ('\x00', '\r', '\n')):
            raise ValueError('Line breaks are not allowed')
        return value

    @model_validator(mode='after')
    def valid(self):
        if not self.name or not self.model:
            raise ValueError('Name and model are required')
        if self.endpoint:
            try:
                url = urlsplit(self.endpoint)
                if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or not (1 <= (url.port or 443) <= 65535):
                    raise ValueError()
            except ValueError:
                raise ValueError('Endpoint must be an HTTPS URL without credentials, query or fragment') from None
        if self.provider in {'azure', 'watsonx', 'openai_compatible'} and not self.endpoint:
            raise ValueError('Endpoint is required for this provider')
        if self.provider == 'watsonx' and not self.project_id:
            raise ValueError('watsonx project ID is required')
        if self.provider == 'bedrock' and not self.region:
            raise ValueError('AWS region is required')
        return self


SECRET_FIELDS = {'api_key', 'access_key_id', 'secret_access_key', 'session_token'}


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS buddy_model_profiles (
        id TEXT PRIMARY KEY, config JSONB NOT NULL, credentials TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('''CREATE TABLE IF NOT EXISTS buddy_active_model_profile (
        id INTEGER PRIMARY KEY CHECK (id=1), profile_id TEXT REFERENCES buddy_model_profiles(id), enabled BOOLEAN NOT NULL DEFAULT FALSE)''')
    db.execute('ALTER TABLE buddy_active_model_profile ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE')


def public_profile(profile_id, config, credential, active=False):
    return {'id': profile_id, **config, 'credentials_configured': bool(credential), 'active': active}


def decrypt_credentials(value):
    try:
        data = json.loads(_cipher().decrypt(value.encode()).decode())
        if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
            raise ValueError()
        return data
    except (InvalidToken, UnicodeError, ValueError, TypeError):
        raise RuntimeError('Provider credentials could not be decrypted; save them again') from None


def active_profile():
    with _connect() as db:
        ensure_schema(db)
        row = db.execute('''SELECT p.id,p.config,p.credentials FROM buddy_active_model_profile a
                            JOIN buddy_model_profiles p ON p.id=a.profile_id WHERE a.id=1 AND a.enabled''').fetchone()
    if not row:
        return {'id': 'bob', 'provider': 'bob'}
    return {'id': row[0], **row[1], 'credentials': decrypt_credentials(row[2])}


@router.get('')
def list_profiles(user=Depends(administrator)):
    with _connect() as db:
        ensure_schema(db)
        rows = db.execute('''SELECT p.id,p.config,p.credentials,(a.enabled AND a.profile_id=p.id) FROM buddy_model_profiles p
                            LEFT JOIN buddy_active_model_profile a ON a.id=1 ORDER BY p.config->>'name',p.id''').fetchall()
        active = db.execute('SELECT profile_id,enabled FROM buddy_active_model_profile WHERE id=1').fetchone()
    return {'enabled': bool(active and active[1]), 'active_id': active[0] if active and active[1] and active[0] else 'bob',
            'profiles': [public_profile(row[0], row[1], row[2], bool(row[3])) for row in rows]}


@router.post('')
def create_profile(body: Profile, user=Depends(administrator)):
    values = body.model_dump()
    credentials = {key: values.pop(key) for key in SECRET_FIELDS if values[key]}
    for key in SECRET_FIELDS:
        values.pop(key, None)
    if body.provider == 'bedrock':
        if not credentials.get('access_key_id') or not credentials.get('secret_access_key'):
            raise HTTPException(422, 'AWS access key ID and secret access key are required')
    elif not credentials.get('api_key'):
        raise HTTPException(422, 'API key is required')
    try:
        encrypted = _cipher().encrypt(json.dumps(credentials).encode()).decode()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    profile_id = str(uuid.uuid4())
    with _connect() as db:
        ensure_schema(db)
        db.execute('INSERT INTO buddy_model_profiles(id,config,credentials) VALUES (%s,%s,%s)', (profile_id, Jsonb(values), encrypted))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'create-buddy-profile', profile_id, Jsonb({'provider': body.provider})))
    return public_profile(profile_id, values, encrypted)


@router.delete('/{profile_id}')
def delete_profile(profile_id: str, user=Depends(administrator)):
    with _connect() as db:
        ensure_schema(db)
        db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_model_profiles'))")
        if db.execute('SELECT 1 FROM buddy_active_model_profile WHERE id=1 AND profile_id=%s', (profile_id,)).fetchone():
            raise HTTPException(409, 'Select another profile before deleting the active one')
        result = db.execute('DELETE FROM buddy_model_profiles WHERE id=%s', (profile_id,))
        if not result.rowcount:
            raise HTTPException(404, 'Profile not found')
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'delete-buddy-profile', profile_id, Jsonb({})))
    return {'deleted': True}


class RuntimeSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    profile_id: str = Field(default='bob', max_length=100)


@router.put('/selection')
def select_profile(body: RuntimeSelection, user=Depends(administrator)):
    if body.enabled:
        raise HTTPException(409, 'Provider activation is not available in this preview')
    with _connect() as db:
        ensure_schema(db)
        db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_model_profiles'))")
        profile_id = None
        if profile_id and not db.execute('SELECT 1 FROM buddy_model_profiles WHERE id=%s', (profile_id,)).fetchone():
            raise HTTPException(404, 'Profile not found')
        db.execute('INSERT INTO buddy_active_model_profile(id,profile_id,enabled) VALUES (1,%s,%s) ON CONFLICT(id) DO UPDATE SET profile_id=EXCLUDED.profile_id,enabled=EXCLUDED.enabled', (profile_id, body.enabled))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'select-buddy-profile', profile_id or 'bob', Jsonb({'enabled': body.enabled})))
    return {'enabled': body.enabled, 'active_id': profile_id or 'bob'}
