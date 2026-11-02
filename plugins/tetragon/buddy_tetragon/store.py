"""Durable plugin configuration and audit; live kernel state comes from Tetragon."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sqlite3


class Store:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv('BUDDY_TETRAGON_DB', '/data/rules.sqlite'))

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS rules (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                    enabled INTEGER NOT NULL DEFAULT 0, attempted INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
                    rule_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def locked(self):
        # Serialize the full engine mutation across threads/processes, including
        # revision check and readback. Never execute the same apply concurrently.
        with open(str(self.path) + '.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    @staticmethod
    def decode(row):
        return {**json.loads(row['payload']), 'revision': row['revision'],
                'enabled': bool(row['enabled']), 'attempted': bool(row['attempted']),
                'last_error': row['last_error']}

    def get(self, identity):
        with self.connect() as db:
            row = db.execute('SELECT * FROM rules WHERE id=?', (identity,)).fetchone()
        return self.decode(row) if row else None

    def snapshot(self):
        with self.connect() as db:
            rules = [self.decode(row) for row in db.execute('SELECT * FROM rules ORDER BY rowid DESC')]
            audit = [dict(row) for row in db.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')]
        return {'rules': rules, 'audit': audit}

    @staticmethod
    def event(db, actor, action, identity, outcome):
        db.execute('INSERT INTO audit(actor,action,rule_id,outcome,created_at) VALUES (?,?,?,?,?)',
                   (actor, action, identity, outcome, datetime.now(timezone.utc).isoformat()))

    def create(self, rule, actor):
        with self.locked(), self.connect() as db:
            if db.execute('SELECT count(*) FROM rules').fetchone()[0] >= 200:
                raise ValueError('The plugin supports at most 200 managed rules')
            db.execute('INSERT INTO rules(id,payload) VALUES (?,?)', (rule['id'], json.dumps(rule)))
            self.event(db, actor, 'save', rule['id'], 'draft')
        return self.get(rule['id'])

    def intent(self, identity, actor, action):
        with self.connect() as db:
            db.execute('UPDATE rules SET attempted=1,revision=revision+1 WHERE id=?', (identity,))
            self.event(db, actor, action, identity, 'requested')

    def result(self, identity, actor, action, *, enabled=None, error=''):
        with self.connect() as db:
            if enabled is not None:
                db.execute('UPDATE rules SET enabled=?,last_error=? WHERE id=?', (int(enabled), error, identity))
            else:
                db.execute('UPDATE rules SET last_error=? WHERE id=?', (error, identity))
            self.event(db, actor, action, identity, 'failed' if error else 'confirmed')

    def delete(self, identity, actor):
        with self.connect() as db:
            db.execute('DELETE FROM rules WHERE id=?', (identity,))
            self.event(db, actor, 'delete', identity, 'confirmed')
