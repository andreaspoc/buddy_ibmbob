"""Administrator-owned CPD connections; credentials are encrypted and write-only."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
from typing import Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, model_validator

PROVIDERS = ('ikc', 'wxdi')


class GovernanceError(ValueError):
    """Only public-safe diagnostics belong in this exception."""


def provider_name(provider):
    if provider not in PROVIDERS:
        raise GovernanceError('Choose IBM Knowledge Catalog or watsonx.data intelligence')
    return provider


# Cloud metadata literals below are SSRF denylist entries, never request targets.
def validate_origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port or 443
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment
                or any(c.isspace() for c in value) or '\\' in value or '%' in parsed.hostname
                or '*' in parsed.hostname or not 1 <= port <= 65535):
            raise ValueError()
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            address = None
        if address and (address.is_loopback or address.is_link_local or address.is_unspecified
                        or address.is_multicast or address.is_reserved
                        or str(address) in {'100.100.100.200', 'fd00:ec2::254'}):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise GovernanceError('Use an HTTPS server origin without credentials, paths or local/metadata addresses') from None
    return value.rstrip('/')


class ConnectorSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    base_url: str = Field(default='', max_length=2048)
    version: str = Field(default='', max_length=80)
    api_profile: Literal['cpd_common_core_v2'] = 'cpd_common_core_v2'
    catalog_id: str = Field(default='', max_length=200)
    asset_type: str = Field(default='data_asset', pattern=r'^[a-z][a-z0-9_]{0,63}$')
    auth_mode: Literal['api_key', 'bearer'] = 'api_key'
    username: str = Field(default='', max_length=320)
    api_key: str = Field(default='', max_length=16384, repr=False)
    bearer_token: str = Field(default='', max_length=16384, repr=False)
    ca_certificate: str = Field(default='', max_length=65536)
    expected_revision: int = Field(default=0, ge=0)

    @model_validator(mode='after')
    def validate_configuration(self):
        if self.base_url:
            self.base_url = validate_origin(self.base_url)
        for value in (self.username, self.api_key, self.bearer_token, self.catalog_id, self.version):
            if any(c in value for c in ('\r', '\n', '\x00')):
                raise ValueError('Line breaks are not allowed in connection fields')
        if self.enabled and (not self.base_url or not self.version):
            raise ValueError('Server origin and installed version are required to enable a connection')
        return self


def encryption():
    value = os.getenv('BUDDY_CP4D_ENCRYPTION_KEY') or os.getenv('BUDDY_MEMORY_SIGNING_KEY', '')
    if len(value) < 32:
        raise GovernanceError('Connection credential encryption is unavailable. Configure a service-only key.')
    key = hashlib.sha256(b'buddy-cp4d-credentials-v1\0' + value.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def ensure_settings_schema(conn):
    conn.execute('CREATE SCHEMA IF NOT EXISTS decisions')
    conn.execute('''CREATE TABLE IF NOT EXISTS decisions.integration_settings (
        provider TEXT PRIMARY KEY CHECK(provider IN ('ikc','wxdi')),
        config JSONB NOT NULL,credentials TEXT NOT NULL DEFAULT '',revision BIGINT NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_test JSONB NOT NULL DEFAULT '{}'::jsonb)''')


def _connection():
    from .db import get_connection
    return get_connection()


def public_settings(provider, row=None):
    row = row or {}
    config = row.get('config') or {}
    defaults = ConnectorSettings().model_dump(exclude={'api_key', 'bearer_token', 'expected_revision'})
    return {**defaults, **config, 'provider': provider, 'revision': row.get('revision', 0),
            'credential_configured': bool(row.get('credentials')), 'last_test': row.get('last_test') or {}}


def get_public_settings():
    with _connection() as conn:
        ensure_settings_schema(conn)
        rows = conn.execute('SELECT * FROM decisions.integration_settings').fetchall()
    by_provider = {row['provider']: row for row in rows}
    try:
        encryption()
        available = True
    except GovernanceError:
        available = False
    return {'providers': {p: public_settings(p, by_provider.get(p)) for p in PROVIDERS},
            'encryption_available': available}


def load_connection(provider):
    provider_name(provider)
    with _connection() as conn:
        ensure_settings_schema(conn)
        row = conn.execute('SELECT * FROM decisions.integration_settings WHERE provider=%s', (provider,)).fetchone()
    if not row or not row['config'].get('enabled'):
        raise GovernanceError('The governance connection is not configured or is disabled')
    try:
        credentials = json.loads(encryption().decrypt(row['credentials'].encode()))
    except (InvalidToken, ValueError, TypeError, AttributeError):
        raise GovernanceError('Stored connection credentials could not be decrypted; save them again') from None
    return {**row['config'], **credentials, 'provider': provider, 'revision': row['revision']}


def update_admin_settings(provider, body, actor):
    provider_name(provider)
    body = ConnectorSettings.model_validate(body)
    config = body.model_dump(exclude={'api_key', 'bearer_token', 'expected_revision'})
    with _connection() as conn:
        ensure_settings_schema(conn)
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('decisions-integration-settings'))")
        row = conn.execute('SELECT * FROM decisions.integration_settings WHERE provider=%s FOR UPDATE', (provider,)).fetchone()
        if (row['revision'] if row else 0) != body.expected_revision:
            raise GovernanceError('Connection settings changed. Reload before saving.')
        supplied = body.api_key if body.auth_mode == 'api_key' else body.bearer_token
        if supplied:
            credentials = encryption().encrypt(json.dumps({body.auth_mode: supplied}).encode()).decode()
        elif row and all(row['config'].get(k) == config.get(k) for k in ('base_url', 'auth_mode', 'username')):
            credentials = row['credentials']
        else:
            credentials = ''
        if body.enabled and (not credentials or body.auth_mode == 'api_key' and not body.username):
            raise GovernanceError('Supply credentials for this server and account before enabling the connection')
        conn.execute('''INSERT INTO decisions.integration_settings(provider,config,credentials,revision,updated_by)
            VALUES(%s,%s::jsonb,%s,1,%s) ON CONFLICT(provider) DO UPDATE SET config=EXCLUDED.config,
            credentials=EXCLUDED.credentials,revision=decisions.integration_settings.revision+1,
            updated_by=EXCLUDED.updated_by,updated_at=now(),last_test='{}'::jsonb''',
            (provider, json.dumps(config), credentials, actor))
        # A changed destination/identity/settings invalidates every prior synchronization proof.
        # Acquire decision locks first, matching model edits and mapping writes.
        conn.execute("SELECT id FROM decisions.decisions WHERE id IN (SELECT decision_id FROM decisions.cp4d_governance) ORDER BY id FOR UPDATE").fetchall()
        conn.execute("UPDATE decisions.decisions SET status='in_review',approver=NULL WHERE id IN (SELECT decision_id FROM decisions.cp4d_governance) AND status IN ('approved','published')")
        conn.execute("UPDATE decisions.cp4d_governance SET sync_status='stale',last_error='Governance connection settings changed' WHERE sync_status='synced'")
        saved = conn.execute('SELECT * FROM decisions.integration_settings WHERE provider=%s', (provider,)).fetchone()
        conn.execute("INSERT INTO decisions.events(decision_id,actor,action,payload) VALUES('*',%s,'governance.connection_configured',%s::jsonb)",
            (actor, json.dumps({'provider': provider, 'enabled': config['enabled'], 'origin': config['base_url'],
                               'catalog_id': config['catalog_id'], 'revision': saved['revision']})))
    return public_settings(provider, saved)


def test_admin_connection(provider, actor):
    from .cp4d_client import CP4DClient
    config = load_connection(provider)
    with CP4DClient(config) as client:
        catalogs = client.list_catalogs()
        if config.get('catalog_id'):
            client.get_catalog(config['catalog_id'])
    result = {'provider': provider, 'status': 'connected', 'catalog_count': len(catalogs),
              'revision': config['revision'], 'actor': actor}
    with _connection() as conn:
        conn.execute('''UPDATE decisions.integration_settings SET last_test=%s::jsonb ||
            jsonb_build_object('tested_at',now()) WHERE provider=%s AND revision=%s''',
            (json.dumps(result), provider, config['revision']))
        conn.execute("INSERT INTO decisions.events(decision_id,actor,action,payload) VALUES('*',%s,'governance.connection_tested',%s::jsonb)",
                     (actor, json.dumps({'provider': provider, 'revision': config['revision'], 'status': 'connected'})))
    return result
