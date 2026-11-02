"""Bounded, exact-origin CPD Common Core / Knowledge Catalog REST adapter.

The protocol is explicitly selected in saved admin settings. IKC and watsonx.data
intelligence can each expose this documented CPD API profile; this is not an
assumption that unrelated product APIs or installations are interchangeable.
"""
from __future__ import annotations

import hashlib
import json
import ssl
from urllib.parse import quote, urlsplit

import httpcore
import httpx

from app.safe_http import resolve
from .cp4d_settings import GovernanceError, validate_origin

MAX_RESPONSE = 2 * 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


class ConfiguredBackend(httpcore.SyncBackend):
    def __init__(self, host, port):
        self.host, self.port = host.lower(), port

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        host = host.decode() if isinstance(host, bytes) else host
        if (host.lower(), port) != (self.host, self.port):
            raise GovernanceError('The connection attempted an unconfigured destination')
        ip = resolve(host, port, allow_private=True, block_sensitive=True)
        return super().connect_tcp(ip, port, timeout, local_address, socket_options)


class CP4DClient:
    def __init__(self, config, *, transport=None):
        self.config = config
        self.base = validate_origin(config.get('base_url', ''))
        if config.get('api_profile') != 'cpd_common_core_v2':
            raise GovernanceError('This installed governance API profile is not supported')
        parsed = urlsplit(self.base)
        try:
            context = ssl.create_default_context(cadata=config.get('ca_certificate') or None)
        except (ValueError, ssl.SSLError):
            raise GovernanceError('The configured CA certificate is invalid') from None
        if transport is None:
            transport = httpx.HTTPTransport(verify=context, retries=0, trust_env=False)
            transport._pool._network_backend = ConfiguredBackend(parsed.hostname, parsed.port or 443)
        self.client = httpx.Client(base_url=self.base, transport=transport, trust_env=False,
                                  follow_redirects=False, timeout=httpx.Timeout(20, connect=5))
        self.token = config.get('bearer') or config.get('bearer_token') or ''

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    def _request(self, method, path, *, params=None, payload=None, authenticate=True):
        if not path.startswith('/') or path.startswith('//') or '\\' in path or '?' in path:
            raise GovernanceError('Invalid governance API operation')
        if payload is not None and len(json.dumps(payload).encode()) > 512 * 1024:
            raise GovernanceError('Governance metadata exceeds the request limit')
        if authenticate and not self.token:
            username, api_key = self.config.get('username'), self.config.get('api_key')
            if not username or not api_key:
                raise GovernanceError('Governance credentials are missing')
            result = self._request('POST', '/icp4d-api/v1/authorize',
                                   payload={'username': username, 'api_key': api_key}, authenticate=False)
            self.token = result.get('token') or result.get('accessToken') or ''
            if not isinstance(self.token, str) or not self.token:
                raise GovernanceError('The CPD authorization response did not contain a token')
        headers = {'Accept': 'application/json'}
        if authenticate:
            headers['Authorization'] = 'Bearer ' + self.token
        if method == 'PATCH':
            headers['Content-Type'] = 'application/json-patch+json'
        try:
            with self.client.stream(method, path, params=params, json=payload, headers=headers) as response:
                if not 200 <= response.status_code < 300:
                    raise GovernanceError(f'Governance server rejected the operation (HTTP {response.status_code})')
                raw = bytearray()
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > MAX_RESPONSE:
                        raise GovernanceError('Governance response exceeded the size limit')
                result = json.loads(raw) if raw else {}
                if not isinstance(result, (dict, list)):
                    raise GovernanceError('Governance server returned an invalid response')
                return result
        except (httpx.HTTPError, ValueError, UnicodeError) as exc:
            if isinstance(exc, GovernanceError):
                raise
            # Never expose remote bodies, request URLs/queries or credentials.
            raise GovernanceError('Governance request failed; check server connectivity, TLS trust and permissions') from None

    def list_catalogs(self):
        data = self._request('GET', '/v2/catalogs', params={'limit': 100})
        rows = data.get('catalogs', data.get('resources', [])) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise GovernanceError('Catalog response has an unsupported format')
        result = []
        for row in rows[:100]:
            metadata = row.get('metadata') or {}
            entity = row.get('entity') or {}
            identifier = metadata.get('guid') or metadata.get('id') or row.get('id') or row.get('catalog_id')
            if identifier:
                result.append({'catalogId': identifier, 'catalogName': entity.get('name') or row.get('name') or identifier,
                               'description': entity.get('description') or row.get('description') or '',
                               'provider': self.config['provider'], 'source': self.base})
        return result

    def get_catalog(self, catalog_id):
        return self._request('GET', '/v2/catalogs/' + quote(catalog_id, safe=''))

    def list_terms(self):
        data = self._request('GET', '/v3/search',
                             params={'query': 'artifact_type:glossary_term', 'limit': 100})
        rows = data.get('rows', data.get('resources', []))
        if not isinstance(rows, list):
            raise GovernanceError('Term search response has an unsupported format')
        result = []
        for row in rows[:100]:
            metadata, entity = row.get('metadata') or {}, row.get('entity') or {}
            artifact = entity.get('artifacts') or entity.get('glossary_term') or entity
            identifier = metadata.get('artifact_id') or metadata.get('asset_id') or row.get('artifact_id') or row.get('id')
            if identifier:
                result.append({'id': identifier, 'name': metadata.get('name') or artifact.get('name') or identifier,
                               'description': artifact.get('short_description') or artifact.get('description') or '',
                               'provider': self.config['provider'], 'source': self.base, 'verifiedActive': False})
        return result

    def get_term(self, term_id):
        data = self._request('GET', '/v3/glossary_terms/' + quote(term_id, safe='') + '/versions',
                             params={'status': 'ACTIVE'})
        rows = data.get('resources', [])
        if not isinstance(rows, list) or not rows:
            raise GovernanceError('The selected business term has no active version')
        row = rows[0]
        metadata, entity = row.get('metadata') or {}, row.get('entity') or {}
        term = entity.get('glossary_term') or entity.get('artifacts') or entity
        return {'id': term_id, 'name': metadata.get('name') or term.get('name') or term_id,
                'version': metadata.get('version_id') or row.get('version_id'),
                'provider': self.config['provider'], 'source': self.base,
                'sourceDigest': digest(data), 'verifiedActive': True}

    def upsert_decision_asset(self, *, catalog_id, asset_id, decision_id, decision_name, version, graph_digest, mappings):
        # Only model metadata is transmitted. No runtime inputs, outputs, secrets,
        # audit payloads or the business-rule expressions are sent remotely.
        description = 'Buddy decision governance metadata\n' + json.dumps({
            'decision_id': decision_id, 'decision_version': version, 'graph_sha256': graph_digest,
            'fields': sorted(mappings), 'mapping_sha256': digest(mappings)}, sort_keys=True)
        name = f'{decision_name} [{decision_id}]'
        if asset_id:
            path = '/v2/assets/' + quote(asset_id, safe='')
            self._request('PATCH', path, params={'catalog_id': catalog_id}, payload=[
                {'op': 'replace', 'path': '/metadata/name', 'value': name},
                {'op': 'replace', 'path': '/metadata/description', 'value': description}])
        else:
            result = self._request('POST', '/v2/assets', params={'catalog_id': catalog_id}, payload={
                'metadata': {'name': name, 'description': description, 'asset_type': self.config.get('asset_type', 'data_asset')},
                'entity': {self.config.get('asset_type', 'data_asset'): {}}})
            asset_id = (result.get('metadata') or {}).get('asset_id') or result.get('asset_id')
            if not isinstance(asset_id, str) or not asset_id:
                raise GovernanceError('Asset creation was not acknowledged with an asset ID; reconcile the remote catalog before retrying')
        data = self._request('GET', '/v2/assets/' + quote(asset_id, safe=''), params={'catalog_id': catalog_id})
        metadata = data.get('metadata') or {}
        if metadata.get('description') != description:
            raise GovernanceError('The remote asset did not confirm the exact decision version and digest')
        return {'provider': self.config['provider'], 'origin': self.base, 'catalogId': catalog_id,
                'assetId': asset_id, 'remoteVersion': metadata.get('revision_id') or metadata.get('version'),
                'responseDigest': digest(data), 'settingsRevision': self.config['revision'],
                'decisionVersion': version, 'graphDigest': graph_digest, 'mappingDigest': digest(mappings)}
