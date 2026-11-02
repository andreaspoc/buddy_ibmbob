"""Explicit, non-destructive import of one legacy Decisions SQLite database.

Inspect with ``--check`` before ``--apply``. The source is opened read-only and
never modified. Target conflicts abort the complete import, and a canonical
source fingerprint makes repeated imports idempotent. Live writers should be
stopped while taking a consistent source backup and applying the import.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import sqlite3

from . import db as storage

TABLES = ('decisions', 'decision_versions', 'audit_logs', 'cp4d_governance')
JSON_FIELDS = {'graph', 'default_input', 'input_data', 'output_result', 'trace_data',
               'compliance_policies', 'term_mappings', 'lineage_manifest'}


class ImportConflict(ValueError):
    pass


def _json(value, default):
    if value is None or value == '':
        return default
    decoded = json.loads(value) if isinstance(value, str) else value
    if not isinstance(decoded, type(default)):
        raise ValueError('Legacy JSON has an unexpected type')
    return decoded


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Legacy row has no creation timestamp')
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError('Legacy timestamps must include a timezone')
    return parsed.isoformat()


def read_legacy(path):
    source = Path(path).resolve(strict=True)
    if not source.is_file() or source.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('Legacy source must be a SQLite file no larger than 256 MiB')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as legacy:
        legacy.row_factory = sqlite3.Row
        legacy.execute('BEGIN')
        names = {row['name'] for row in legacy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'decisions' not in names:
            raise ValueError('Legacy source contains no decisions table')
        rows = {table: [dict(row) for row in legacy.execute(f'SELECT * FROM "{table}"')]
                if table in names else [] for table in TABLES}
    # Fingerprint content, not filenames or unstable SQLite journal metadata.
    for table in TABLES:
        rows[table].sort(key=lambda row: json.dumps(row, sort_keys=True, separators=(',', ':'), allow_nan=False))
    fingerprint = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    model_ids = set()
    for row in rows['decisions']:
        if not isinstance(row.get('id'), str) or not row['id'] or row['id'] in model_ids:
            raise ValueError('Legacy source has invalid decision identities')
        model_ids.add(row['id'])
        if row.get('status', 'draft') not in {'draft', 'in_review', 'approved', 'published'}:
            raise ValueError('Legacy decision has an unknown lifecycle status')
        if row.get('environment', 'development') not in {'development', 'staging', 'production'}:
            raise ValueError('Legacy decision has an unknown environment')
        if row.get('access_policy', 'private') not in {'authenticated', 'private'}:
            raise ValueError('Legacy decision has an unknown access policy')
        if type(row.get('version', 1)) is not int or row.get('version', 1) < 1:
            raise ValueError('Legacy decision has an invalid version')
        _json(row.get('graph'), {})
        _json(row.get('default_input'), {})
        _timestamp(row.get('created_at'))
        _timestamp(row.get('updated_at'))
    for table in ('decision_versions', 'cp4d_governance'):
        if any(row.get('decision_id') not in model_ids for row in rows[table]):
            raise ValueError('Legacy source has orphaned decision metadata')
    for row in rows['decision_versions']:
        if type(row.get('version')) is not int or row['version'] < 1:
            raise ValueError('Legacy snapshot has an invalid version')
        _json(row.get('graph'), {})
        _timestamp(row.get('created_at'))
    for row in rows['audit_logs']:
        _json(row.get('input_data'), {})
        _json(row.get('output_result'), {})
        _json(row.get('trace_data'), [])
        _timestamp(row.get('created_at'))
        duration, nodes = row.get('duration_micros'), row.get('nodes_executed')
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration < 0 or type(nodes) is not int or nodes < 0):
            raise ValueError('Legacy audit contains invalid execution metrics')
    for row in rows['cp4d_governance']:
        policies = _json(row.get('compliance_policies'), [])
        if any(not isinstance(policy, dict) for policy in policies):
            raise ValueError('Legacy governance policies must be objects')
        _json(row.get('term_mappings'), {})
        _json(row.get('lineage_manifest'), {})
    return source.name, fingerprint, rows


def _counts(rows):
    return {table: len(rows[table]) for table in TABLES}


def _target_conflicts(db, rows):
    for row in rows['decisions']:
        if db.execute('SELECT id FROM decisions.decisions WHERE id=%s', (row['id'],)).fetchone():
            raise ImportConflict('Target already contains a decision ID from this source; no rows imported')
    for table in ('decision_versions', 'audit_logs'):
        for row in rows[table]:
            if db.execute(f'SELECT id FROM decisions.{table} WHERE id=%s', (row['id'],)).fetchone():
                raise ImportConflict('Target contains a conflicting historical ID; no rows imported')


def import_rows(db, source_name, fingerprint, rows, *, apply=False):
    """The caller owns a single transaction encompassing every target change."""
    counts = _counts(rows)
    db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_decisions_sqlite_import_v1'))")
    imported = db.execute('SELECT fingerprint FROM decisions.sqlite_imports WHERE fingerprint=%s',
                          (fingerprint,)).fetchone()
    if imported:
        return {'status': 'already_imported', 'source': source_name, 'counts': counts, 'applied': False}
    _target_conflicts(db, rows)
    if not apply:
        return {'status': 'ready', 'source': source_name, 'counts': counts, 'applied': False}
    for row in rows['decisions']:
        owner = row.get('owner') or 'legacy-unassigned'
        db.execute('''INSERT INTO decisions.decisions
            (id,name,description,graph,default_input,version,status,environment,created_at,updated_at,
             updated_by,approver,owner,access_policy)
            VALUES(%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (row['id'], row.get('name') or row['id'], row.get('description') or '',
             storage._json(_json(row.get('graph'), {})), storage._json(_json(row.get('default_input'), {})),
             row.get('version', 1), row.get('status') or 'draft', row.get('environment') or 'development',
             _timestamp(row['created_at']), _timestamp(row['updated_at']), row.get('updated_by') or owner,
             row.get('approver'), owner, row.get('access_policy') or 'private'))
    for row in rows['decision_versions']:
        db.execute('''INSERT INTO decisions.decision_versions
            (id,decision_id,version,graph,change_summary,created_at,created_by)
            VALUES(%s,%s,%s,%s::jsonb,%s,%s,%s)''',
            (row['id'], row['decision_id'], row['version'], storage._json(_json(row.get('graph'), {})),
             row.get('change_summary') or '', _timestamp(row['created_at']), row.get('created_by') or 'legacy-unassigned'))
    from app.redaction import redact
    for row in rows['audit_logs']:
        db.execute('''INSERT INTO decisions.audit_logs
            (id,decision_id,input_data,output_result,duration_micros,nodes_executed,trace_data,user_id,created_at)
            VALUES(%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s::jsonb,%s,%s)''',
            (row['id'], row.get('decision_id'), storage._json(redact(_json(row.get('input_data'), {}))),
             storage._json(redact(_json(row.get('output_result'), {}))), row['duration_micros'], row['nodes_executed'],
             storage._json(redact(_json(row.get('trace_data'), []))), row.get('user_id') or 'legacy-unassigned',
             _timestamp(row['created_at'])))
    for row in rows['cp4d_governance']:
        policies = _json(row.get('compliance_policies'), [])
        normalized = [{**policy, 'legacyStatus': policy.get('status'), 'status': 'NOT_ASSESSED'}
                      for policy in policies if isinstance(policy, dict)]
        db.execute('''INSERT INTO decisions.cp4d_governance
            (decision_id,ikc_asset_id,catalog_id,catalog_name,steward,classification,compliance_policies,
             term_mappings,lineage_manifest,sync_status,last_synced_at,last_error)
            VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,'legacy_unverified',NULL,%s)''',
            (row['decision_id'], row.get('ikc_asset_id') or '', row.get('catalog_id') or '', row.get('catalog_name') or '',
             row.get('steward') or '', row.get('classification') or '', storage._json(normalized),
             storage._json(_json(row.get('term_mappings'), {})), storage._json(_json(row.get('lineage_manifest'), {})),
             'Imported local metadata; remote synchronization and compliance have not been verified.'))
    # Explicit historical IDs must not make the next normal INSERT collide.
    for table in ('decision_versions', 'audit_logs'):
        db.execute(f"""SELECT setval(pg_get_serial_sequence('decisions.{table}','id'),
            COALESCE((SELECT max(id) FROM decisions.{table}),1),
            EXISTS(SELECT 1 FROM decisions.{table}))""")
    db.execute('INSERT INTO decisions.sqlite_imports(fingerprint,source_name,counts) VALUES(%s,%s,%s::jsonb)',
               (fingerprint, source_name, storage._json(counts)))
    storage._event(db, 'legacy-import', 'migration', 'decisions.sqlite_imported',
                   {'fingerprint': fingerprint, 'source': source_name, 'counts': counts,
                    'auditHandling': 'credentials_redacted', 'governanceHandling': 'legacy_unverified'})
    return {'status': 'imported', 'source': source_name, 'counts': counts, 'applied': True}


def migrate(path, *, apply=False):
    source, fingerprint, rows = read_legacy(path)
    if apply:
        storage.init_db()
    with storage._connect() as db:
        ready = db.execute("SELECT to_regclass('decisions.decisions') AS relation").fetchone()
        if not ready['relation']:
            return {'status': 'target_schema_not_initialized', 'source': source,
                    'counts': _counts(rows), 'applied': False}
        return import_rows(db, source, fingerprint, rows, apply=apply)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='A consistent backup of the legacy SQLite database')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    arguments = parser.parse_args()
    try:
        result = migrate(arguments.source, apply=arguments.apply)
    except ImportConflict as exc:
        parser.exit(1, str(exc) + '\n')
    except Exception:
        parser.exit(1, 'Migration failed; source unchanged and target rows rolled back. Check source validity and database connectivity.\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
