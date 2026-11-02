"""Version-bound governance evidence from configured IBM services.

Local vocabulary mappings and lineage are proposals. Only acknowledged remote
responses count as synchronized metadata; synchronization is not legal compliance
certification and does not execute, approve or publish business decisions.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

from .cp4d_client import CP4DClient, digest
from .cp4d_settings import GovernanceError, PROVIDERS, get_public_settings, load_connection

# Compatibility imports; no synthetic catalog or glossary is exposed as live data.
IKC_GLOSSARY_TERMS = []
IKC_CATALOGS = []


def init_cp4d_tables(conn):
    # The plugin's PostgreSQL schema initializer owns the complete DDL.
    from .db import init_db
    init_db()


def connection_status():
    settings = get_public_settings()['providers']
    providers = {name: {'enabled': item['enabled'],
                        'configured': bool(item['enabled'] and item['base_url'] and item['credential_configured']),
                        'version': item['version'], 'origin': item['base_url'],
                        'revision': item['revision'], 'catalogId': item['catalog_id'], 'last_test': item['last_test']}
                 for name, item in settings.items()}
    configured = any(p['configured'] for p in providers.values())
    return {'configured': configured, 'status': 'configured' if configured else 'not_configured', 'providers': providers}


def list_catalogs(provider='ikc'):
    if not get_public_settings()['providers'][provider]['enabled']:
        return []
    with CP4DClient(load_connection(provider)) as client:
        return client.list_catalogs()


def list_terms(provider='ikc'):
    if not get_public_settings()['providers'][provider]['enabled']:
        return []
    with CP4DClient(load_connection(provider)) as client:
        return client.list_terms()


def get_default_term_mappings(decision_id, graph):
    fields = {}
    for node in graph.get('nodes', []):
        content = node.get('content') or {}
        if node.get('type') != 'decisionTableNode':
            continue
        for direction in ('input', 'output'):
            columns = content.get(direction + 's') or (content.get('schema') or {}).get(direction + 's', [])
            for column in columns:
                field = column.get('field')
                if not isinstance(field, str) or not field:
                    continue
                key = field if field not in fields else direction + ':' + field
                fields[key] = {'field': field, 'label': column.get('label') or field, 'type': direction,
                               'termId': None, 'termName': None, 'provider': None,
                               'verification': 'unmapped'}
    if len(fields) > 200:
        raise GovernanceError('Decision governance supports at most 200 mapped fields')
    return fields


def generate_openlineage_manifest(decision_id, decision_name, mappings, graph):
    """Local design lineage, not an assertion of a completed data-processing run."""
    return {'kind': 'decision_design_lineage', 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'decisionId': decision_id, 'decisionName': decision_name, 'graphDigest': digest(graph),
            'inputs': [item for item in mappings.values() if item.get('type') == 'input'],
            'outputs': [item for item in mappings.values() if item.get('type') == 'output'],
            'remoteLineagePublished': False,
            'note': 'Local design metadata; no Manta/OpenLineage ingestion or legal certification is claimed.'}


def _json(value, default):
    if value is None:
        return default
    return json.loads(value) if isinstance(value, str) else value


def _iso(value):
    return value.isoformat() if hasattr(value, 'isoformat') else value


def _view(row, graph, version):
    mappings = _json(row['term_mappings'], {})
    lineage = _json(row['lineage_manifest'], {})
    status = row['sync_status']
    if status == 'synced' and (row.get('synced_version') != version or row.get('synced_digest') != digest(graph)):
        status = 'stale'
    snapshot = lineage.get('governanceSnapshot') or {}
    return {'decisionId': row['decision_id'], 'ikcAssetId': row.get('ikc_asset_id') or None,
            'catalogId': row.get('catalog_id') or None, 'catalogName': row.get('catalog_name') or '',
            'steward': row.get('steward') or '', 'classification': row.get('classification') or 'Not assessed',
            'compliancePolicies': [], 'termMappings': mappings, 'lineageManifest': lineage,
            'syncStatus': status, 'lastSyncedAt': _iso(row.get('last_synced_at')),
            'syncedVersion': row.get('synced_version'), 'graphDigest': row.get('synced_digest'),
            'lastError': row.get('last_error') or '', 'governanceSnapshot': snapshot,
            'complianceAdherence': 'Not assessed; catalog synchronization is not compliance certification'}


def get_or_create_cp4d_governance(conn, decision_id, decision_name, graph, version=None):
    if version is None:
        decision = conn.execute('SELECT version FROM decisions.decisions WHERE id=%s', (decision_id,)).fetchone()
        if not decision:
            raise GovernanceError('Decision does not exist')
        version = decision['version']
    configured = connection_status()['configured']
    mappings = get_default_term_mappings(decision_id, graph)
    lineage = generate_openlineage_manifest(decision_id, decision_name, mappings, graph)
    conn.execute('''INSERT INTO decisions.cp4d_governance(decision_id,ikc_asset_id,catalog_id,catalog_name,
        steward,classification,compliance_policies,term_mappings,lineage_manifest,sync_status)
        VALUES(%s,'','','','','Not assessed','[]'::jsonb,%s::jsonb,%s::jsonb,%s)
        ON CONFLICT(decision_id) DO NOTHING''',
        (decision_id, json.dumps(mappings), json.dumps(lineage), 'not_synced' if configured else 'not_configured'))
    row = conn.execute('SELECT * FROM decisions.cp4d_governance WHERE decision_id=%s', (decision_id,)).fetchone()
    stored_mappings = _json(row['term_mappings'], {})
    reconciled = {field: {**entry, **({key: value for key, value in stored_mappings[field].items()
                           if key not in {'field', 'label', 'type'}} if field in stored_mappings
                           and stored_mappings[field].get('field') == entry['field']
                           and stored_mappings[field].get('type') == entry['type'] else {})}
                  for field, entry in mappings.items()}
    if reconciled != stored_mappings:
        conn.execute("UPDATE decisions.cp4d_governance SET term_mappings=%s::jsonb,sync_status='stale',last_error='Decision fields changed; review mappings again' WHERE decision_id=%s",
                     (json.dumps(reconciled), decision_id))
        row = {**row, 'term_mappings': reconciled, 'sync_status': 'stale',
               'last_error': 'Decision fields changed; review mappings again'}
    result = _view(row, graph, version)
    if result['syncStatus'] == 'synced' and not governance_ready(result, {'version': version, 'graph': graph}):
        result['syncStatus'] = 'stale'
    return result


def update_cp4d_term_mapping(conn, decision_id, field, term_id, provider='ikc'):
    # Resolve an ACTIVE remote term before treating a user-selected ID as evidence.
    config = load_connection(provider)
    with CP4DClient(config) as client:
        term = client.get_term(term_id)
    row = conn.execute('SELECT term_mappings FROM decisions.cp4d_governance WHERE decision_id=%s FOR UPDATE',
                       (decision_id,)).fetchone()
    if not row:
        raise GovernanceError('Load governance metadata before assigning a term')
    mappings = _json(row['term_mappings'], {})
    if field not in mappings:
        raise GovernanceError('The selected decision field does not exist')
    mappings[field] = {**mappings[field], 'termId': term['id'], 'termName': term['name'],
                       'provider': provider, 'source': term['source'], 'termVersion': term['version'],
                       'sourceDigest': term['sourceDigest'], 'verification': 'active_remote_term',
                       'verifiedAt': datetime.now(timezone.utc).isoformat()}
    conn.execute("""UPDATE decisions.cp4d_governance SET term_mappings=%s::jsonb,
        sync_status='stale',last_error='Field mapping changed; synchronize this version again' WHERE decision_id=%s""",
        (json.dumps(mappings), decision_id))
    conn.execute("UPDATE decisions.decisions SET status='in_review',approver=NULL WHERE id=%s AND status IN ('approved','published')", (decision_id,))
    return mappings


def governance_ready(record, decision):
    """A local release gate over fresh, version-bound remote evidence, not a policy engine."""
    if (record.get('syncStatus') != 'synced' or record.get('syncedVersion') != decision.get('version')
            or record.get('graphDigest') != digest(decision.get('graph') or {})):
        return False
    snapshot = record.get('governanceSnapshot') or {}
    sources = snapshot.get('sources') or {}
    mappings = record.get('termMappings') or {}
    if set(mappings) != set(get_default_term_mappings(decision.get('id', ''), decision.get('graph') or {})):
        return False
    settings = get_public_settings()['providers']
    enabled = [name for name, config in settings.items() if config['enabled']]
    if not enabled:
        return True
    if any(not item.get('termId') or item.get('verification') != 'active_remote_term'
           or item.get('provider') not in enabled
           or item.get('source') != settings[item['provider']]['base_url'] for item in mappings.values()):
        return False
    try:
        max_age = min(86400, max(60, int(os.getenv('BUDDY_DECISIONS_GOVERNANCE_TTL_SECONDS', '3600'))))
        checked = datetime.fromisoformat(snapshot['checkedAt'])
        age = (datetime.now(timezone.utc) - checked).total_seconds()
        if not 0 <= age <= max_age:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    for name in enabled:
        source = sources.get(name) or {}
        if (source.get('settingsRevision') != settings[name]['revision']
                or source.get('origin') != settings[name]['base_url']
                or source.get('decisionVersion') != decision['version']
                or source.get('graphDigest') != record['graphDigest']
                or source.get('mappingDigest') != digest(mappings) or not source.get('assetId')):
            return False
    return True


def sync_decision_to_cp4d(conn, decision_id, decision_name, graph, catalog_id=None, version=None):
    gov = get_or_create_cp4d_governance(conn, decision_id, decision_name, graph, version)
    current = conn.execute('SELECT version,graph FROM decisions.decisions WHERE id=%s', (decision_id,)).fetchone()
    version = current['version']
    graph_digest = digest(graph)
    if digest(_json(current['graph'], {})) != graph_digest:
        raise GovernanceError('Decision changed. Reload before synchronizing.')
    settings = get_public_settings()['providers']
    enabled = [name for name in PROVIDERS if settings[name]['enabled']]
    if not enabled:
        raise GovernanceError('Configure and test a governance connection in administrator settings first')
    # Preserve acknowledged asset identities across retries. An ambiguous create
    # must be reconciled manually; never blindly create a second remote asset.
    if gov['syncStatus'] in {'pending', 'reconciliation_required'}:
        raise GovernanceError('A previous synchronization is unresolved. Reconcile its remote assets before retrying.')
    mappings = gov['termMappings']
    sources = dict((gov.get('governanceSnapshot') or {}).get('sources') or {})
    conn.execute("UPDATE decisions.decisions SET status='in_review',approver=NULL WHERE id=%s AND status IN ('approved','published')", (decision_id,))
    conn.execute("UPDATE decisions.cp4d_governance SET sync_status='pending',last_error='' WHERE decision_id=%s", (decision_id,))
    conn.commit()
    creating = False
    deadline = time.monotonic() + 120
    try:
        prepared = {}
        # Resolve every source before publishing, so both providers attest to the
        # same final mapping digest even if one term changed remotely.
        for name in enabled:
            config = load_connection(name)
            if name == 'ikc' and catalog_id and catalog_id != config.get('catalog_id'):
                raise GovernanceError('The catalog must match the administrator-saved connection scope')
            target_catalog = config.get('catalog_id')
            if not target_catalog:
                raise GovernanceError('Choose and save a catalog for every enabled governance connection')
            with CP4DClient(config) as client:
                catalog = client.get_catalog(target_catalog)
                for field, mapping in mappings.items():
                    if time.monotonic() >= deadline:
                        raise GovernanceError('Governance synchronization exceeded its time limit')
                    if mapping.get('provider') == name and mapping.get('termId'):
                        term = client.get_term(mapping['termId'])
                        mappings[field] = {**mapping, 'termName': term['name'], 'termVersion': term['version'],
                                           'sourceDigest': term['sourceDigest'], 'source': term['source'],
                                           'verification': 'active_remote_term'}
            prepared[name] = config, target_catalog, catalog
        for name in enabled:
            if time.monotonic() >= deadline:
                raise GovernanceError('Governance synchronization exceeded its time limit')
            config, target_catalog, catalog = prepared[name]
            with CP4DClient(config) as client:
                previous = sources.get(name) or next((source for source in sources.values()
                    if source.get('origin') == config['base_url'] and source.get('catalogId') == target_catalog), {})
                identity_matches = (previous.get('origin') == config['base_url'] and previous.get('catalogId') == target_catalog)
                asset_id = previous.get('assetId') if identity_matches else None
                creating = not bool(asset_id)
                proof = client.upsert_decision_asset(catalog_id=target_catalog, asset_id=asset_id,
                    decision_id=decision_id, decision_name=decision_name, version=version,
                    graph_digest=graph_digest, mappings=mappings)
                creating = False
                proof['catalogName'] = (catalog.get('entity') or {}).get('name') or catalog.get('name') or target_catalog
                sources[name] = proof
                # Persist acknowledged IDs after each provider, even if the next fails.
                checkpoint = {**gov['lineageManifest'], 'governanceSnapshot': {'sources': sources}}
                conn.execute('UPDATE decisions.cp4d_governance SET lineage_manifest=%s::jsonb WHERE decision_id=%s',
                             (json.dumps(checkpoint), decision_id))
                conn.commit()
        checked_at = datetime.now(timezone.utc).isoformat()
        snapshot = {'checkedAt': checked_at, 'decisionVersion': version, 'graphDigest': graph_digest,
                    'mappingDigest': digest(mappings), 'sources': sources,
                    'legalCompliance': 'not_assessed', 'remotePolicyEnforcement': 'not_claimed'}
        lineage = generate_openlineage_manifest(decision_id, decision_name, mappings, graph)
        lineage['governanceSnapshot'] = snapshot
        latest = conn.execute('SELECT version,graph FROM decisions.decisions WHERE id=%s FOR UPDATE', (decision_id,)).fetchone()
        if latest['version'] != version or digest(_json(latest['graph'], {})) != graph_digest:
            raise GovernanceError('Decision changed during synchronization; remote evidence is stale')
        current_settings = get_public_settings()['providers']
        if any(current_settings[name]['revision'] != prepared[name][0]['revision'] for name in enabled):
            raise GovernanceError('Governance settings changed during synchronization; refresh and retry')
        primary = sources.get('ikc') or sources[enabled[0]]
        conn.execute('''UPDATE decisions.cp4d_governance SET ikc_asset_id=%s,catalog_id=%s,catalog_name=%s,
            term_mappings=%s::jsonb,lineage_manifest=%s::jsonb,sync_status='synced',last_synced_at=now(),
            synced_version=%s,synced_digest=%s,remote_origin=%s,last_error='' WHERE decision_id=%s''',
            (primary['assetId'], primary['catalogId'], primary['catalogName'], json.dumps(mappings),
             json.dumps(lineage), version, graph_digest, primary['origin'], decision_id))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        message = str(exc) if isinstance(exc, GovernanceError) else 'Governance synchronization failed; verify the remote server and configuration'
        state = 'reconciliation_required' if creating else 'failed'
        conn.execute('UPDATE decisions.cp4d_governance SET sync_status=%s,last_error=%s WHERE decision_id=%s',
                     (state, message, decision_id))
        conn.commit()
        raise GovernanceError(message) from None
    return {'status': 'success', 'syncStatus': 'synced', 'decisionId': decision_id,
            'syncedVersion': version, 'graphDigest': graph_digest, 'providers': sources,
            'ikcAssetId': primary['assetId'], 'catalogId': primary['catalogId'],
            'catalogName': primary['catalogName'], 'lastSyncedAt': checked_at,
            'complianceAdherence': 'Not assessed; metadata sync does not certify compliance'}


def adopt_remote_asset(conn, decision_id, provider, asset_id):
    """Explicit administrator reconciliation after an uncertain external create.

    Verify the remote record belongs to this local decision in the saved catalog;
    adoption does not mark governance fresh or approve publication.
    """
    config = load_connection(provider)
    catalog_id = config.get('catalog_id')
    if not catalog_id or not isinstance(asset_id, str) or not asset_id or len(asset_id) > 200:
        raise GovernanceError('A saved catalog and valid remote asset ID are required')
    from urllib.parse import quote
    with CP4DClient(config) as client:
        remote = client._request('GET', '/v2/assets/' + quote(asset_id, safe=''), params={'catalog_id': catalog_id})
    description = (remote.get('metadata') or {}).get('description', '')
    try:
        marker, encoded = description.split('\n', 1)
        metadata = json.loads(encoded)
        if marker != 'Buddy decision governance metadata' or metadata.get('decision_id') != decision_id:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise GovernanceError('The remote asset is not a matching Buddy decision record') from None
    row = conn.execute('SELECT lineage_manifest FROM decisions.cp4d_governance WHERE decision_id=%s FOR UPDATE',
                       (decision_id,)).fetchone()
    if not row:
        raise GovernanceError('Decision governance record does not exist')
    lineage = _json(row['lineage_manifest'], {})
    snapshot = lineage.setdefault('governanceSnapshot', {})
    sources = snapshot.setdefault('sources', {})
    sources[provider] = {'provider': provider, 'origin': config['base_url'], 'catalogId': catalog_id,
                         'assetId': asset_id, 'reconciledAt': datetime.now(timezone.utc).isoformat()}
    conn.execute("UPDATE decisions.decisions SET status='in_review',approver=NULL WHERE id=%s AND status IN ('approved','published')", (decision_id,))
    conn.execute("UPDATE decisions.cp4d_governance SET lineage_manifest=%s::jsonb,sync_status='stale',last_error='' WHERE decision_id=%s",
                 (json.dumps(lineage), decision_id))
    return {'status': 'reconciled', 'provider': provider, 'assetId': asset_id,
            'note': 'Synchronize the current decision version to refresh governance evidence'}
