#!/usr/bin/env python3
"""Record/verify table identities, counts, foreign keys and Office key checksums.

No user content or object keys are emitted. Run while application writers are
stopped. Uses the configured existing database; never creates another database.
"""
import argparse
import json
import os
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from app.feature_schemas import FEATURE_TABLES


def snapshot(db):
    tables = {}
    names = [name for items in FEATURE_TABLES.values() for name in items]
    names += ['bob_conversations', 'bob_conversation_history', 'bob_chat_submissions']
    for name in names:
        relations = db.execute('''SELECT c.oid,n.nspname FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relname=%s AND n.nspname IN ('public','office','people_chat')
                AND c.relkind IN ('r','p')''', (name,)).fetchall()
        if len(relations) != 1:
            raise RuntimeError('Missing or duplicate table: ' + name)
        relation = relations[0]
        count = db.execute(sql.SQL('SELECT count(*) AS n FROM {}.{}').format(
            sql.Identifier(relation['nspname']), sql.Identifier(name))).fetchone()['n']
        tables[name] = {'oid': relation['oid'], 'rows': count}
    ids = [entry['oid'] for entry in tables.values()]
    foreign_keys = db.execute('''SELECT oid,conrelid,confrelid,conkey,confkey,convalidated
        FROM pg_constraint WHERE contype='f' AND (conrelid=ANY(%s::oid[]) OR confrelid=ANY(%s::oid[]))
        ORDER BY oid''', (ids, ids)).fetchall()
    sequences = db.execute('''SELECT objid,refobjid,refobjsubid FROM pg_depend
        WHERE refobjid=ANY(%s::oid[]) AND deptype IN ('a','i')
          AND objid IN (SELECT oid FROM pg_class WHERE relkind='S') ORDER BY objid''', (ids,)).fetchall()
    office_schema = db.execute('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=%s',
                               (tables['bob_office_files']['oid'],)).fetchone()['nspname']
    keys = db.execute(sql.SQL('''SELECT COALESCE(sum(hashtextextended(
        concat_ws('|',id::text,object_key,revision::text,sha256),0)::numeric),0)::text AS fingerprint
        FROM {}.bob_office_files''').format(sql.Identifier(office_schema))).fetchone()['fingerprint']
    return {'tables': tables, 'foreign_keys': foreign_keys, 'sequences': sequences,
            'office_keys_fingerprint': keys}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['record', 'verify'])
    parser.add_argument('file', type=Path)
    args = parser.parse_args()
    with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as db:
        current = snapshot(db)
    if args.mode == 'record':
        args.file.write_text(json.dumps(current, sort_keys=True, indent=2) + '\n')
        args.file.chmod(0o600)
        print('Recorded migration invariants for', len(current['tables']), 'tables')
    else:
        if current != json.loads(args.file.read_text()):
            raise SystemExit('Migration verification failed: identities, rows, relationships or Office keys differ')
        print('Verified table identities, row counts, foreign keys, sequences, conversation records and Office keys')


if __name__ == '__main__':
    main()
