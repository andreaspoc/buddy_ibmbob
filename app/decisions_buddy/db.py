"""Durable Decisions storage in the application's PostgreSQL database.

The feature owns the ``decisions`` schema. No source-tree SQLite database or
example records are opened at application startup. Legacy files are imported
only by the explicit ``python -m app.decisions_buddy.migrate_sqlite`` command.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
import os
from threading import Lock

_schema_lock = Lock()
_schema_database = None


class RevisionConflict(ValueError):
    """The client edited an older saved version of this decision."""


def _connect():
    from app.job_queue import _connect as connect
    return connect()


def init_db():
    """Create feature tables atomically, without seeding or migrating user data."""
    global _schema_database
    database = os.environ.get('DATABASE_URL')
    if not database:
        raise RuntimeError('Decisions requires the shared PostgreSQL DATABASE_URL')
    if _schema_database == database:
        return
    with _schema_lock:
        if _schema_database == database:
            return
        with _connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_decisions_schema_v1'))")
            db.execute('CREATE SCHEMA IF NOT EXISTS decisions')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.decisions (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                graph JSONB NOT NULL, default_input JSONB NOT NULL DEFAULT '{}'::jsonb,
                version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','approved','published')),
                environment TEXT NOT NULL DEFAULT 'development' CHECK(environment IN ('development','staging','production')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_by TEXT NOT NULL, approver TEXT, owner TEXT NOT NULL,
                access_policy TEXT NOT NULL DEFAULT 'private' CHECK(access_policy IN ('authenticated','private')))''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.decision_versions (
                id BIGSERIAL PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions.decisions(id) ON DELETE CASCADE,
                version BIGINT NOT NULL CHECK(version > 0), graph JSONB NOT NULL,
                name TEXT, description TEXT, default_input JSONB,
                change_summary TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_by TEXT NOT NULL, UNIQUE(decision_id, version))''')
            # Evaluation evidence intentionally survives deletion of a model.
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.audit_logs (
                id BIGSERIAL PRIMARY KEY, decision_id TEXT, input_data JSONB NOT NULL,
                output_result JSONB NOT NULL, duration_micros DOUBLE PRECISION NOT NULL CHECK(duration_micros >= 0),
                nodes_executed INTEGER NOT NULL CHECK(nodes_executed >= 0), trace_data JSONB NOT NULL DEFAULT '[]'::jsonb,
                user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                decision_version BIGINT, graph_digest TEXT, governance_snapshot JSONB)''')
            db.execute('ALTER TABLE decisions.audit_logs ADD COLUMN IF NOT EXISTS decision_version BIGINT')
            db.execute('ALTER TABLE decisions.audit_logs ADD COLUMN IF NOT EXISTS graph_digest TEXT')
            db.execute('ALTER TABLE decisions.audit_logs ADD COLUMN IF NOT EXISTS governance_snapshot JSONB')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.events (
                id BIGSERIAL PRIMARY KEY, decision_id TEXT NOT NULL, actor TEXT NOT NULL,
                action TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.cp4d_governance (
                decision_id TEXT PRIMARY KEY REFERENCES decisions.decisions(id) ON DELETE CASCADE,
                ikc_asset_id TEXT NOT NULL DEFAULT '', catalog_id TEXT NOT NULL DEFAULT '',
                catalog_name TEXT NOT NULL DEFAULT '', steward TEXT NOT NULL DEFAULT '',
                classification TEXT NOT NULL DEFAULT '', compliance_policies JSONB NOT NULL DEFAULT '[]'::jsonb,
                term_mappings JSONB NOT NULL DEFAULT '{}'::jsonb, lineage_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
                sync_status TEXT NOT NULL DEFAULT 'not_configured', last_synced_at TIMESTAMPTZ,
                synced_version BIGINT, synced_digest TEXT, last_error TEXT NOT NULL DEFAULT '',
                remote_origin TEXT NOT NULL DEFAULT '')''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.sqlite_imports (
                fingerprint TEXT PRIMARY KEY, source_name TEXT NOT NULL, counts JSONB NOT NULL,
                imported_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.releases (
                decision_id TEXT NOT NULL, version BIGINT NOT NULL, graph_digest TEXT NOT NULL,
                dependency_manifest JSONB NOT NULL, published_by TEXT NOT NULL,
                published_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(decision_id,version))''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.test_suites (
                decision_id TEXT PRIMARY KEY REFERENCES decisions.decisions(id) ON DELETE CASCADE,
                decision_version BIGINT NOT NULL, revision BIGINT NOT NULL,
                cases JSONB NOT NULL, updated_by TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS decisions.test_runs (
                id BIGSERIAL PRIMARY KEY, decision_id TEXT NOT NULL, decision_version BIGINT NOT NULL,
                suite_revision BIGINT NOT NULL, graph_digest TEXT NOT NULL,
                dependency_manifest JSONB NOT NULL, passed BOOLEAN NOT NULL,
                actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS decisions_test_runs_model ON decisions.test_runs(decision_id,id DESC)')
            db.execute('CREATE INDEX IF NOT EXISTS decisions_owner ON decisions.decisions(owner)')
            db.execute('CREATE INDEX IF NOT EXISTS decisions_audit_model ON decisions.audit_logs(decision_id, id DESC)')
            db.execute('CREATE INDEX IF NOT EXISTS decisions_audit_owner ON decisions.audit_logs(user_id, id DESC)')
            db.execute('CREATE INDEX IF NOT EXISTS decisions_events_model ON decisions.events(decision_id, id DESC)')
        _schema_database = database


def get_connection():
    """Native psycopg dict-row connection; caller must commit/rollback and close."""
    init_db()
    db = _connect()
    try:
        db.execute('SET search_path TO decisions, public')
    except BaseException:
        db.close()
        raise
    return db


@contextmanager
def connection():
    db = get_connection()
    try:
        with db:
            yield db
    finally:
        db.close()


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _value(value, default=None):
    # Native JSONB is already decoded; legacy/testing adapters may provide text.
    return json.loads(value) if isinstance(value, str) else default if value is None else value


def _time(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _record(row):
    if not row:
        return None
    return {'id': row['id'], 'name': row['name'], 'description': row.get('description', ''),
            'graph': _value(row['graph'], {}), 'defaultInput': _value(row.get('default_input'), {}),
            'version': row['version'], 'status': row.get('status') or 'draft',
            'environment': row.get('environment') or 'development', 'updatedAt': _time(row.get('updated_at')),
            'updatedBy': row.get('updated_by') or row.get('owner'), 'approver': row.get('approver'),
            'owner': row.get('owner'), 'accessPolicy': row.get('access_policy') or 'private'}


def _locked(db, decision_id):
    # The advisory lock also serializes creation of a previously absent ID.
    db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_decision:' || %s))", (decision_id,))
    return db.execute('SELECT * FROM decisions.decisions WHERE id=%s FOR UPDATE', (decision_id,)).fetchone()


def _check_version(row, expected_version):
    if expected_version is not None and expected_version != (row['version'] if row else 0):
        raise RevisionConflict('Decision changed. Reload the saved version before retrying.')


def _check_owner(row, author, is_admin):
    if not author:
        raise PermissionError('Authenticated decision author required')
    if row and not is_admin and row['owner'] != author:
        raise PermissionError('Only the decision owner or an administrator may modify it')


def _event(db, decision_id, actor, action, payload):
    db.execute('''INSERT INTO decisions.events(decision_id,actor,action,payload)
                  VALUES(%s,%s,%s,%s::jsonb)''', (decision_id, actor, action, _json(payload)))


def get_all_decisions(user=None):
    if not user or not user.get('username'):
        raise PermissionError('Authenticated Decisions user required')
    with connection() as db:
        rows = db.execute('''SELECT * FROM decisions.decisions
            WHERE %s OR access_policy='authenticated' OR owner=%s ORDER BY name,id''',
                          (bool(user.get('is_admin')), user['username'])).fetchall()
    result = []
    for row in rows:
        item = _record(row)
        graph = item.pop('graph')
        item.pop('defaultInput')
        result.append({**item, 'nodeCount': len(graph.get('nodes', [])), 'edgeCount': len(graph.get('edges', []))})
    return result


def get_decision(decision_id):
    with connection() as db:
        return _record(db.execute('SELECT * FROM decisions.decisions WHERE id=%s', (decision_id,)).fetchone())


def _save(db, decision_id, name, description, graph, default_input, change_summary, author,
          access_policy, expected_version, is_admin):
    existing = _locked(db, decision_id)
    _check_owner(existing, author, is_admin)
    _check_version(existing, expected_version)
    if access_policy not in {'private', 'authenticated'}:
        raise ValueError('Unknown decision access policy')
    if not isinstance(graph, dict) or not isinstance(default_input, dict):
        raise ValueError('Decision graph and default input must be objects')
    graph_json, input_json = _json(graph), _json(default_input)
    version = existing['version'] + 1 if existing else 1
    if existing:
        # A changed graph invalidates approval and all CP4D synchronization evidence.
        status = 'draft' if existing['status'] == 'draft' else 'in_review'
        row = db.execute('''UPDATE decisions.decisions SET name=%s,description=%s,graph=%s::jsonb,
            default_input=%s::jsonb,version=%s,updated_at=now(),updated_by=%s,status=%s,
            access_policy=%s,approver=NULL WHERE id=%s RETURNING *''',
            (name, description, graph_json, input_json, version, author, status, access_policy, decision_id)).fetchone()
        db.execute("""UPDATE decisions.cp4d_governance SET sync_status='stale',synced_version=NULL,
            synced_digest=NULL WHERE decision_id=%s""", (decision_id,))
    else:
        row = db.execute('''INSERT INTO decisions.decisions
            (id,name,description,graph,default_input,updated_by,owner,access_policy)
            VALUES(%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s) RETURNING *''',
            (decision_id, name, description, graph_json, input_json, author, author, access_policy)).fetchone()
    db.execute('''INSERT INTO decisions.decision_versions
        (decision_id,version,graph,name,description,default_input,change_summary,created_by)
        VALUES(%s,%s,%s::jsonb,%s,%s,%s::jsonb,%s,%s)''',
        (decision_id, version, graph_json, name, description, input_json, change_summary, author))
    _event(db, decision_id, author, 'decision.saved', {'version': version, 'accessPolicy': access_policy})
    return _record(row)


def save_decision(decision_id, name, description, graph, default_input, change_summary='Updated rules',
                  author='system', access_policy='private', *, expected_version=None, is_admin=False):
    with connection() as db:
        return _save(db, decision_id, name, description, graph, default_input, change_summary, author,
                     access_policy, expected_version, is_admin)


def delete_decision(decision_id, *, author=None, expected_version=None, is_admin=False):
    with connection() as db:
        row = _locked(db, decision_id)
        if not row:
            return False
        _check_owner(row, author, is_admin)
        _check_version(row, expected_version)
        _event(db, decision_id, author, 'decision.deleted', {'version': row['version'], 'name': row['name']})
        db.execute('DELETE FROM decisions.decisions WHERE id=%s', (decision_id,))
    return True


def update_governance_status(decision_id, status, environment=None, approver=None, *, author=None,
                             expected_version=None, is_admin=False, validate=None):
    actor = author or approver
    with connection() as db:
        row = _locked(db, decision_id)
        if not row:
            return None
        _check_owner(row, actor, is_admin)
        _check_version(row, expected_version)
        if validate is not None:
            validate(db, _record(row))
        if status not in {'draft', 'in_review', 'approved', 'published'}:
            raise ValueError('Unknown decision status')
        target_environment = environment or row['environment']
        if target_environment not in {'development', 'staging', 'production'}:
            raise ValueError('Unknown decision environment')
        changed = db.execute('''UPDATE decisions.decisions SET status=%s,environment=%s,
            approver=%s,updated_at=now() WHERE id=%s RETURNING *''',
            (status, target_environment, approver, decision_id)).fetchone()
        _event(db, decision_id, actor, 'decision.governance_changed',
               {'version': row['version'], 'from': row['status'], 'to': status, 'environment': target_environment})
        return _record(changed)


def get_decision_versions(decision_id):
    with connection() as db:
        rows = db.execute('''SELECT id,decision_id,version,change_summary,created_at,created_by
            FROM decisions.decision_versions WHERE decision_id=%s ORDER BY version DESC''', (decision_id,)).fetchall()
    return [{**row, 'created_at': _time(row['created_at'])} for row in rows]


def get_version_snapshot(decision_id, version):
    with connection() as db:
        row = db.execute('SELECT graph FROM decisions.decision_versions WHERE decision_id=%s AND version=%s',
                         (decision_id, version)).fetchone()
    return _value(row['graph'], {}) if row else None


def get_release(decision_id, version):
    with connection() as db:
        row = db.execute('SELECT * FROM decisions.releases WHERE decision_id=%s AND version=%s',
                         (decision_id, version)).fetchone()
    return dict(row) if row else None


def test_suite(decision_id, conn=None):
    if conn is None:
        with connection() as conn:
            return test_suite(decision_id, conn)
    row = conn.execute('SELECT * FROM decisions.test_suites WHERE decision_id=%s', (decision_id,)).fetchone()
    return {'decisionVersion': row['decision_version'], 'suiteRevision': row['revision'],
            'cases': _value(row['cases'], [])} if row else {'decisionVersion': None, 'suiteRevision': 0, 'cases': []}


def save_test_suite(decision_id, cases, *, expected_version, expected_suite_revision, actor, is_admin=False):
    with connection() as conn:
        current = _locked(conn, decision_id)
        if not current:
            raise ValueError('Decision not found')
        _check_owner(current, actor, is_admin)
        _check_version(current, expected_version)
        suite = test_suite(decision_id, conn)
        if suite['suiteRevision'] != expected_suite_revision:
            raise RevisionConflict('Test suite changed. Reload it before saving.')
        conn.execute('''INSERT INTO decisions.test_suites(decision_id,decision_version,revision,cases,updated_by)
            VALUES (%s,%s,%s,%s::jsonb,%s) ON CONFLICT(decision_id) DO UPDATE SET
            decision_version=excluded.decision_version,revision=excluded.revision,cases=excluded.cases,
            updated_by=excluded.updated_by,updated_at=now()''',
            (decision_id, expected_version, expected_suite_revision + 1, _json(cases), actor))
        _event(conn, decision_id, actor, 'tests.saved', {'version': expected_version, 'suiteRevision': expected_suite_revision + 1})
        return test_suite(decision_id, conn)


def record_test_run(decision_id, version, suite_revision, graph_digest, manifest, passed, actor):
    with connection() as conn:
        current = _locked(conn, decision_id)
        if not current:
            raise ValueError('Decision not found')
        _check_version(current, version)
        if test_suite(decision_id, conn)['suiteRevision'] != suite_revision:
            raise RevisionConflict('Test suite changed during execution. Run it again.')
        conn.execute('''INSERT INTO decisions.test_runs
            (decision_id,decision_version,suite_revision,graph_digest,dependency_manifest,passed,actor)
            VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s)''',
            (decision_id, version, suite_revision, graph_digest, _json(manifest), passed, actor))


def require_passing_tests(conn, decision, manifest):
    suite = test_suite(decision['id'], conn)
    if not suite['cases'] or suite['decisionVersion'] != decision['version']:
        raise ValueError('Save and pass test cases for this exact decision version before publishing')
    import hashlib
    digest = hashlib.sha256(json.dumps(decision['graph'], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    row = conn.execute('''SELECT passed FROM decisions.test_runs WHERE decision_id=%s
        AND decision_version=%s AND suite_revision=%s AND graph_digest=%s
        AND dependency_manifest=%s::jsonb ORDER BY id DESC LIMIT 1''',
        (decision['id'], decision['version'], suite['suiteRevision'], digest, _json(manifest))).fetchone()
    if not row or not row['passed']:
        raise ValueError('Run and pass the saved test suite before publishing this version')


def record_release(conn, decision, manifest, actor):
    import hashlib
    digest = hashlib.sha256(json.dumps(decision['graph'], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    existing = conn.execute('SELECT graph_digest,dependency_manifest FROM decisions.releases WHERE decision_id=%s AND version=%s',
                            (decision['id'], decision['version'])).fetchone()
    if existing and (existing['graph_digest'] != digest or _value(existing['dependency_manifest'], {}) != manifest):
        raise ValueError('A released version is immutable. Save a new decision version.')
    conn.execute('''INSERT INTO decisions.releases(decision_id,version,graph_digest,dependency_manifest,published_by)
        VALUES (%s,%s,%s,%s::jsonb,%s) ON CONFLICT(decision_id,version) DO NOTHING''',
        (decision['id'], decision['version'], digest, _json(manifest), actor))


def log_evaluation(decision_id, input_data, output_result, duration_micros, nodes_executed, trace_data,
                   user_id='anonymous', *, decision_version=None, graph_digest=None, governance_snapshot=None):
    from app.redaction import redact
    if not user_id or user_id == 'anonymous':
        raise PermissionError('Authenticated evaluation owner required')
    with connection() as db:
        db.execute('''INSERT INTO decisions.audit_logs
            (decision_id,input_data,output_result,duration_micros,nodes_executed,trace_data,user_id,
             decision_version,graph_digest,governance_snapshot)
            VALUES(%s,%s::jsonb,%s::jsonb,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb)''',
            (decision_id, _json(redact(input_data)), _json(redact(output_result)), duration_micros,
             nodes_executed, _json(redact(trace_data)), user_id, decision_version, graph_digest,
             _json(redact(governance_snapshot)) if governance_snapshot is not None else None))


def get_recent_logs(limit=50, user_id=None):
    limit = min(200, max(1, int(limit)))
    with connection() as db:
        if user_id:
            rows = db.execute('SELECT * FROM decisions.audit_logs WHERE user_id=%s ORDER BY id DESC LIMIT %s',
                              (user_id, limit)).fetchall()
        else:
            rows = db.execute('SELECT * FROM decisions.audit_logs ORDER BY id DESC LIMIT %s', (limit,)).fetchall()
    return [{'id': row['id'], 'decisionId': row['decision_id'], 'inputData': _value(row['input_data'], {}),
             'outputResult': _value(row['output_result'], {}), 'durationMicros': row['duration_micros'],
             'nodesExecuted': row['nodes_executed'], 'userId': row['user_id'],
             'createdAt': _time(row['created_at']), 'decisionVersion': row.get('decision_version'),
             'graphDigest': row.get('graph_digest'),
             'governanceSnapshot': _value(row.get('governance_snapshot'))} for row in rows]


def compute_rule_heatmap(decision_id, user_id=None):
    with connection() as db:
        rows = db.execute('''SELECT trace_data,duration_micros FROM decisions.audit_logs
            WHERE decision_id=%s AND (%s IS NULL OR user_id=%s) ORDER BY id DESC LIMIT 10000''',
            (decision_id, user_id, user_id)).fetchall()
    total = len(rows)
    hits, latencies = {}, []
    for row in rows:
        latencies.append(row['duration_micros'])
        for node in _value(row['trace_data'], []):
            for rule in node.get('ruleTrace', []):
                rule_id = rule.get('ruleId')
                if rule_id is not None:
                    hits.setdefault(rule_id, 0)
                    if rule.get('passed'):
                        hits[rule_id] += 1
    return {'decisionId': decision_id, 'totalRuns': total,
            'avgLatencyMicros': round(sum(latencies) / total, 2) if total else None,
            'p95LatencyMicros': round(sorted(latencies)[min(total - 1, int(total * .95))], 2) if total else None,
            'ruleHeatmap': {rule: {'hitCount': count, 'hitPercentage': round(count / total * 100, 1),
                                    'totalRuns': total} for rule, count in hits.items()},
            'sampleLimit': 10000}


def rollback_decision(decision_id, target_version, author='system', *, expected_version=None, is_admin=False):
    with connection() as db:
        current = _locked(db, decision_id)
        if not current:
            return None
        _check_owner(current, author, is_admin)
        _check_version(current, expected_version)
        snapshot = db.execute('SELECT * FROM decisions.decision_versions WHERE decision_id=%s AND version=%s',
                              (decision_id, target_version)).fetchone()
        if not snapshot:
            return None
        return _save(db, decision_id, snapshot.get('name') or current['name'],
                     snapshot.get('description') or current['description'], _value(snapshot['graph'], {}),
                     _value(snapshot.get('default_input'), _value(current['default_input'], {})),
                     f'Rollback to snapshot v{target_version}', author, current['access_policy'],
                     current['version'], is_admin)
