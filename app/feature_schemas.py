"""Move feature tables within the existing database without copying their data.

Run ``python -m app.feature_schemas --check`` before ``--apply``. Stop writers
for apply/rollback; all moves commit together or are rolled back together.
"""
from __future__ import annotations

import argparse
import json
import os


FEATURE_TABLES = {
    'office': (
        'bob_office_files', 'bob_office_sessions', 'bob_office_shares',
        'bob_office_folders', 'bob_office_analytics_cache',
    ),
    'people_chat': (
        'bob_chat_rooms', 'bob_chat_members', 'bob_chat_messages',
        'bob_chat_message_seen', 'bob_chat_dependencies',
        'bob_chat_notification_settings', 'bob_chat_reactions', 'bob_chat_tasks',
        'bob_chat_notification_preferences', 'bob_chat_bob_context',
        'bob_chat_away', 'bob_chat_away_jobs', 'bob_chat_away_pauses',
    ),
}


class MigrationConflict(RuntimeError):
    """A safe, unambiguous move cannot be performed."""


def ensure_namespaces(db):
    """Create namespaces before qualified feature DDL on a fresh installation."""
    for schema in FEATURE_TABLES:
        db.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')


def _inventory(db):
    rows = db.execute("""SELECT n.nspname, c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','office','people_chat')
          AND c.relkind IN ('r','p','v','m','f','S')""").fetchall()
    return {(row['nspname'], row['relname']) if isinstance(row, dict)
            else (row[0], row[1]) for row in rows}


def plan(db, *, rollback=False):
    """Validate the complete inventory before issuing any table moves."""
    inventory = _inventory(db)
    moves = []
    counts = {}
    for schema, tables in FEATURE_TABLES.items():
        # Indexes and sequences are associated objects, moved by PostgreSQL.
        # Reject foreign feature tables or accidental local application tables.
        unexpected = db.execute("""SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=%s AND c.relkind IN ('r','p','v','m','f')
              AND NOT (c.relname = ANY(%s))""", (schema, list(tables))).fetchall()
        if unexpected:
            raise MigrationConflict(f'{schema}: unexpected relations ({len(unexpected)})')
        found = missing = 0
        for table in tables:
            public = ('public', table) in inventory
            feature = (schema, table) in inventory
            if public and feature:
                raise MigrationConflict(f'{schema}: duplicate feature table')
            if not public and not feature:
                missing += 1
                continue
            found += 1
            source, target = (schema, 'public') if rollback else ('public', schema)
            if (source, table) in inventory:
                moves.append((source, table, target))
        counts[schema] = {'present': found, 'missing': missing,
                          'move': sum(source == schema if rollback else target == schema
                                      for source, _, target in moves)}
    return moves, counts


def migrate(db, *, apply=False, rollback=False, lock_timeout_ms=5000):
    """Inspect/move inside one transaction; never change database or roles.

    The connection must support psycopg's transaction context. ALTER TABLE SET
    SCHEMA preserves table OIDs, rows, foreign keys, keys and owned sequences.
    """
    if not isinstance(lock_timeout_ms, int) or not 1 <= lock_timeout_ms <= 60000:
        raise ValueError('lock timeout must be between 1 and 60000 milliseconds')
    with db.transaction():
        db.execute("SELECT set_config('lock_timeout', %s, true)",
                   (f'{lock_timeout_ms}ms',))
        db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_feature_schemas_v1'))")
        moves, counts = plan(db, rollback=rollback)
        if apply:
            ensure_namespaces(db)
            for source, table, target in moves:
                # Identifiers come exclusively from FEATURE_TABLES, never input.
                db.execute(f'ALTER TABLE "{source}"."{table}" SET SCHEMA "{target}"')
        return {'operation': 'rollback' if rollback else 'apply' if apply else 'check',
                'applied': apply, 'tables': counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    parser.add_argument('--lock-timeout-ms', type=int, default=5000)
    args = parser.parse_args()
    import psycopg
    try:
        with psycopg.connect(os.environ['DATABASE_URL']) as db:
            result = migrate(db, apply=args.apply or args.rollback,
                             rollback=args.rollback,
                             lock_timeout_ms=args.lock_timeout_ms)
    except MigrationConflict as exc:
        parser.exit(1, f'Migration refused: {exc}\n')
    except Exception:
        # Do not expose connection strings or operational data in CLI output.
        parser.exit(1, 'Migration failed; no partial migration committed. Check database connectivity and locks.\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
