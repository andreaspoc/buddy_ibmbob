"""Shared Bob provider credential, encrypted at rest and write-only in the API."""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from psycopg.types.json import Jsonb

from app.admin_users import administrator
from app.auth import _connect

router = APIRouter(prefix='/admin/bob-key', tags=['administration'])


def _cipher():
    secret = os.getenv('BUDDY_CP4D_ENCRYPTION_KEY') or os.getenv('BUDDY_MEMORY_SIGNING_KEY', '')
    if len(secret) < 32:
        raise RuntimeError('Bob key encryption is unavailable. Configure a service-only encryption key.')
    digest = hashlib.sha256(b'buddy-bob-key-v1\0' + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS bob_provider_key (id INTEGER PRIMARY KEY CHECK(id=1), credential TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())')


def saved_key():
    with _connect() as db:
        _schema(db)
        row = db.execute('SELECT credential FROM bob_provider_key WHERE id=1').fetchone()
    if not row:
        return ''
    try:
        return _cipher().decrypt(row[0].encode()).decode()
    except (InvalidToken, UnicodeError, ValueError):
        raise RuntimeError('The saved Bob key cannot be decrypted. Ask an administrator to save it again.') from None


def effective_key():
    return saved_key() or os.getenv('BOB_API_KEY') or os.getenv('BOBSHELL_API_KEY') or ''


def provider_configured():
    """Whether any key is available; a database outage must not fail health checks."""
    if os.getenv('BOB_API_KEY') or os.getenv('BOBSHELL_API_KEY'):
        return True
    try:
        with _connect() as db:
            _schema(db)
            return db.execute('SELECT 1 FROM bob_provider_key WHERE id=1').fetchone() is not None
    except Exception:
        return False


class KeyInput(BaseModel):
    api_key: str = Field(min_length=1, max_length=16384, repr=False)

    @field_validator('api_key')
    @classmethod
    def validate_key(cls, value):
        value = value.strip()
        if not value or any(c in value for c in ('\r', '\n', '\x00')):
            raise ValueError('Enter a key without line breaks')
        return value


@router.get('')
def get_key(user=Depends(administrator)):
    with _connect() as db:
        _schema(db)
        configured = bool(db.execute('SELECT 1 FROM bob_provider_key WHERE id=1').fetchone())
    try:
        _cipher()
        available = True
    except RuntimeError:
        available = False
    return {'saved': configured, 'environment_configured': bool(os.getenv('BOB_API_KEY') or os.getenv('BOBSHELL_API_KEY')), 'encryption_available': available}


@router.put('')
def put_key(body: KeyInput, user=Depends(administrator)):
    try:
        encrypted = _cipher().encrypt(body.api_key.encode()).decode()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    with _connect() as db:
        _schema(db)
        db.execute('INSERT INTO bob_provider_key(id,credential) VALUES (1,%s) ON CONFLICT(id) DO UPDATE SET credential=EXCLUDED.credential,updated_at=now()', (encrypted,))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'configure-bob-key', 'bob', Jsonb({})))
    return {'saved': True}


@router.delete('')
def delete_key(user=Depends(administrator)):
    with _connect() as db:
        _schema(db)
        db.execute('DELETE FROM bob_provider_key WHERE id=1')
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'remove-bob-key', 'bob', Jsonb({})))
    return {'saved': False}
