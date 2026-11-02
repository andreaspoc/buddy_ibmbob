"""First-run wizard and administrator settings for the instance name, logo and provider choice."""
import base64
import binascii
import re

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from app.admin_users import administrator
from app.auth import _connect
from app.bob_key_settings import provider_configured
from app.branding import invalidate_brand_cache

router = APIRouter(tags=['administration'])

MAX_LOGO_BYTES = 1024 * 1024
# Letters, digits and light punctuation only: this text is placed in system prompts.
_LABEL = re.compile(r"^[^\W_][\w '.&-]*$")
_SIGNATURES = ((b'\x89PNG\r\n\x1a\n', 'image/png'), (b'\xff\xd8\xff', 'image/jpeg'))


def _label(value):
    value = value.strip()
    if '_' in value or not _LABEL.fullmatch(value) or any(c.isspace() and c != ' ' for c in value):
        raise ValueError("Use letters, numbers, spaces and . ' & - only")
    return value


class BrandInput(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    organization: str = Field(default='', max_length=80)

    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        return _label(value)

    @field_validator('organization')
    @classmethod
    def valid_organization(cls, value):
        return _label(value) if value.strip() else ''


class LogoInput(BaseModel):
    content_base64: str = Field(min_length=1, max_length=2 * MAX_LOGO_BYTES)


class CompleteInput(BaseModel):
    skip_provider: bool = False


def logo_media_type(content):
    """Trust the bytes, not the upload. SVG is refused because it can carry script."""
    if len(content) > MAX_LOGO_BYTES:
        raise ValueError('The logo must be 1 MB or smaller')
    for signature, media_type in _SIGNATURES:
        if content.startswith(signature):
            return media_type
    if content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        return 'image/webp'
    raise ValueError('Use a PNG, JPEG or WebP image')


def _audit(db, user, action):
    db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)',
               (user['username'], action, 'instance', Jsonb({})))


@router.get('/branding')
def get_branding():
    """Public: the sign-in page needs the name and logo before anyone is authenticated."""
    with _connect() as db:
        row = db.execute('SELECT name,organization,logo_version,logo IS NOT NULL,setup_complete,provider_choice '
                         'FROM bob_instance_brand WHERE id=1').fetchone()
    return {'name': row[0], 'organization': row[1], 'logo_version': row[2], 'has_logo': row[3],
            'setup_complete': row[4], 'provider_choice': row[5]}


@router.get('/branding/logo')
def get_logo():
    with _connect() as db:
        row = db.execute('SELECT logo,logo_media_type FROM bob_instance_brand WHERE id=1').fetchone()
    if not row or row[0] is None:
        raise HTTPException(404, 'No logo has been added')
    return Response(bytes(row[0]), media_type=row[1], headers={
        'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff'})


@router.put('/admin/branding')
def put_branding(body: BrandInput, user=Depends(administrator)):
    with _connect() as db:
        db.execute('UPDATE bob_instance_brand SET name=%s,organization=%s,updated_at=now() WHERE id=1', (body.name, body.organization))
        _audit(db, user, 'update-instance-brand')
    invalidate_brand_cache()
    return {'name': body.name, 'organization': body.organization}


@router.put('/admin/branding/logo')
def put_logo(body: LogoInput, user=Depends(administrator)):
    try:
        content = base64.b64decode(body.content_base64, validate=True)
        media_type = logo_media_type(content)
    except binascii.Error:
        raise HTTPException(422, 'The logo could not be read') from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    with _connect() as db:
        version = db.execute('UPDATE bob_instance_brand SET logo=%s,logo_media_type=%s,logo_version=logo_version+1,updated_at=now() WHERE id=1 RETURNING logo_version',
                             (content, media_type)).fetchone()[0]
        _audit(db, user, 'update-instance-logo')
    return {'has_logo': True, 'logo_version': version}


@router.delete('/admin/branding/logo')
def delete_logo(user=Depends(administrator)):
    with _connect() as db:
        db.execute('UPDATE bob_instance_brand SET logo=NULL,logo_media_type=NULL,logo_version=logo_version+1,updated_at=now() WHERE id=1')
        _audit(db, user, 'remove-instance-logo')
    return {'has_logo': False}


@router.post('/admin/setup/complete')
def complete_setup(body: CompleteInput, user=Depends(administrator)):
    """The wizard finishes only on an explicit choice: a working key, or a deliberate skip."""
    configured = provider_configured()
    if not configured and not body.skip_provider:
        raise HTTPException(422, 'Add a Bob API key or choose to skip this step')
    choice = 'configured' if configured else 'skipped'
    with _connect() as db:
        db.execute('UPDATE bob_instance_brand SET setup_complete=TRUE,provider_choice=%s,updated_at=now() WHERE id=1', (choice,))
        _audit(db, user, 'complete-instance-setup')
    return {'setup_complete': True, 'provider_choice': choice}
