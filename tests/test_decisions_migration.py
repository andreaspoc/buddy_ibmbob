"""Real synthetic legacy SQLite files and transactional target-adapter checks."""
import copy
import importlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

migration = importlib.import_module('app.decisions_buddy.migrate_sqlite')
STAMP = '2026-10-24T12:00:00+00:00'


class Target:
    def __init__(self):
        self.models, self.versions, self.audits, self.imports = set(), set(), set(), set()
        self.calls = []
        self.result = None
        self.fail_on = None
    def __enter__(self):
        self.snapshot = copy.deepcopy((self.models, self.versions, self.audits, self.imports))
        return self
    def __exit__(self, exc_type, *args):
        if exc_type:
            self.models, self.versions, self.audits, self.imports = self.snapshot
    def execute(self, sql, params=()):
        compact = ' '.join(sql.split())
        self.calls.append((compact, params))
        if self.fail_on and self.fail_on in compact:
            raise RuntimeError('Synthetic migration interruption')
        if compact.startswith('SELECT fingerprint'):
            self.result = {'fingerprint': params[0]} if params[0] in self.imports else None
        elif compact.startswith('SELECT id FROM decisions.'):
            table = compact.split()[3].split('.')[1]
            identities = {'decisions': self.models, 'decision_versions': self.versions, 'audit_logs': self.audits}[table]
            self.result = {'id': params[0]} if params[0] in identities else None
        elif compact.startswith('INSERT INTO decisions.decisions '): self.models.add(params[0])
        elif compact.startswith('INSERT INTO decisions.decision_versions '): self.versions.add(params[0])
        elif compact.startswith('INSERT INTO decisions.audit_logs '): self.audits.add(params[0])
        elif compact.startswith('INSERT INTO decisions.sqlite_imports('): self.imports.add(params[0])
        return self
    def fetchone(self): return self.result


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'legacy-fixture.db'
        with sqlite3.connect(self.path) as db:
            db.executescript('''CREATE TABLE decisions(id TEXT PRIMARY KEY,name TEXT,description TEXT,
                graph TEXT,default_input TEXT,version INTEGER,status TEXT,environment TEXT,
                created_at TEXT,updated_at TEXT,owner TEXT,updated_by TEXT,approver TEXT,access_policy TEXT);
                CREATE TABLE decision_versions(id INTEGER PRIMARY KEY,decision_id TEXT,version INTEGER,
                graph TEXT,change_summary TEXT,created_at TEXT,created_by TEXT);
                CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,decision_id TEXT,input_data TEXT,
                output_result TEXT,duration_micros REAL,nodes_executed INTEGER,trace_data TEXT,user_id TEXT,created_at TEXT);
                CREATE TABLE cp4d_governance(decision_id TEXT PRIMARY KEY,ikc_asset_id TEXT,catalog_id TEXT,
                catalog_name TEXT,steward TEXT,classification TEXT,compliance_policies TEXT,term_mappings TEXT,
                lineage_manifest TEXT,sync_status TEXT,last_synced_at TEXT);''')
            db.execute('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('synthetic','Fixture','',json.dumps({'nodes':[]}), '{}', 4,'draft','development',STAMP,STAMP,
                 'owner','owner',None,'private'))
            db.execute('INSERT INTO decision_versions VALUES (?,?,?,?,?,?,?)',
                (7,'synthetic',4,json.dumps({'nodes':[]}), 'Synthetic history',STAMP,'owner'))
            db.execute('INSERT INTO audit_logs VALUES (?,?,?,?,?,?,?,?,?)',
                (19,'synthetic',json.dumps({'password':'synthetic-secret'}),'{}',2.0,0,'[]','owner',STAMP))
            db.execute('INSERT INTO cp4d_governance VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                ('synthetic','legacy-local-id','legacy-local-catalog','Legacy fixture','Fixture steward','Internal',
                 json.dumps([{'name':'Legacy claim','status':'COMPLIANT'}]),'{}','{}','synced',STAMP))

    def read(self): return migration.read_legacy(self.path)

    def test_read_only_source_and_fingerprint_are_repeatable(self):
        before = self.path.read_bytes()
        name, fingerprint, rows = self.read()
        self.assertEqual(name,'legacy-fixture.db')
        self.assertEqual(fingerprint,self.read()[1])
        self.assertEqual(self.path.read_bytes(),before)
        self.assertEqual(rows['decisions'][0]['version'],4)

    def test_dry_run_has_no_target_insert_and_counts_real_source_rows(self):
        name, fingerprint, rows = self.read()
        target = Target()
        with target:
            result = migration.import_rows(target,name,fingerprint,rows)
        self.assertFalse(result['applied'])
        self.assertEqual(result['counts'],{'decisions':1,'decision_versions':1,'audit_logs':1,'cp4d_governance':1})
        self.assertFalse(any(sql.startswith('INSERT') for sql, _ in target.calls))

    def test_apply_preserves_ids_redacts_audit_and_does_not_validate_legacy_claims(self):
        name, fingerprint, rows = self.read()
        target = Target()
        with target:
            result = migration.import_rows(target,name,fingerprint,rows,apply=True)
        self.assertTrue(result['applied'])
        self.assertEqual((target.models,target.versions,target.audits),({'synthetic'},{7},{19}))
        audit = next(params for sql,params in target.calls if sql.startswith('INSERT INTO decisions.audit_logs'))
        self.assertNotIn('synthetic-secret',audit[2])
        governance_sql, governance = next((sql,params) for sql,params in target.calls if sql.startswith('INSERT INTO decisions.cp4d_governance'))
        self.assertIn("'legacy_unverified',NULL",governance_sql)
        self.assertEqual(json.loads(governance[6])[0]['status'],'NOT_ASSESSED')
        self.assertEqual(json.loads(governance[6])[0]['legacyStatus'],'COMPLIANT')
        inserts = sum(sql.startswith('INSERT') for sql,_ in target.calls)
        with target:
            second = migration.import_rows(target,name,fingerprint,rows,apply=True)
        self.assertEqual(second['status'],'already_imported')
        self.assertEqual(sum(sql.startswith('INSERT') for sql,_ in target.calls),inserts)

    def test_target_conflicts_abort_instead_of_overwriting(self):
        name, fingerprint, rows = self.read()
        for field, identity in (('models','synthetic'),('versions',7),('audits',19)):
            target = Target()
            getattr(target,field).add(identity)
            with target, self.assertRaises(migration.ImportConflict):
                migration.import_rows(target,name,fingerprint,rows,apply=True)
            self.assertFalse(any(sql.startswith('INSERT') for sql,_ in target.calls))

    def test_interruption_rolls_back_all_imported_rows_and_fingerprint(self):
        name, fingerprint, rows = self.read()
        target = Target()
        target.fail_on = 'INSERT INTO decisions.audit_logs'
        with self.assertRaises(RuntimeError):
            with target:
                migration.import_rows(target,name,fingerprint,rows,apply=True)
        self.assertEqual((target.models,target.versions,target.audits,target.imports),(set(),set(),set(),set()))

    def test_missing_source_does_not_create_a_new_sqlite_file(self):
        path = self.path.with_name('missing.db')
        with self.assertRaises(FileNotFoundError): migration.read_legacy(path)
        self.assertFalse(path.exists())

    def test_invalid_or_orphaned_source_is_rejected_during_check(self):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE decision_versions SET decision_id='missing-model'")
        with self.assertRaisesRegex(ValueError,'orphaned'): self.read()


if __name__ == '__main__': unittest.main()
