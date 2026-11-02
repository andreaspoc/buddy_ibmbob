"""Move existing BYTEA files to verified S3 objects, one transaction per file."""
from __future__ import annotations

import argparse
import json

from psycopg import sql

from app import blob_storage, job_queue, postgres_storage, rag

IDENTITIES = {'bob_storage_files': ('username', 'scope', 'path'), 'bob_knowledge_documents': ('id',)}


def migrate(*, apply=False):
    postgres_storage.ensure_schema()
    rag.ensure_schema()
    if apply and not blob_storage.enabled():
        raise ValueError('Set BOB_FILE_STORAGE=s3 and configure BOB_S3_* before applying')
    result = {'files': 0, 'bytes': 0, 'applied': apply}
    for table, identities in IDENTITIES.items():
        name = sql.Identifier(table)
        if not apply:
            with job_queue._connect() as db:
                row = db.execute(sql.SQL('SELECT count(*) AS n,coalesce(sum(octet_length(content)),0) AS bytes FROM {} WHERE content IS NOT NULL').format(name)).fetchone()
            result['files'] += row['n']
            result['bytes'] += row['bytes']
            continue
        while True:
            with job_queue._connect() as db:
                row = db.execute(sql.SQL('SELECT * FROM {} WHERE content IS NOT NULL LIMIT 1 FOR UPDATE').format(name)).fetchone()
                if not row:
                    break
                raw = blob_storage.read(row)
                namespace = table + ':' + ':'.join(str(row[key]) for key in identities)
                stored = blob_storage.store(raw, namespace=namespace, db=db)
                condition = sql.SQL(' AND ').join(sql.SQL('{}=%s').format(sql.Identifier(key)) for key in identities)
                db.execute(sql.SQL('UPDATE {} SET content=NULL,object_key=%s,object_bucket=%s,size=%s WHERE {}').format(name, condition),
                           (stored['object_key'],stored['object_bucket'],stored['size'],*(row[key] for key in identities)))
            result['files'] += 1
            result['bytes'] += len(raw)
            if result['files'] % 100 == 0:
                print(f"Progress: migrated {result['files']} files ({result['bytes'] / (1024*1024):.1f} MB) to Wasabi S3...", flush=True)
    return result


def verify():
    postgres_storage.ensure_schema()
    rag.ensure_schema()
    result = {'verified_files': 0, 'verified_bytes': 0}
    for table in IDENTITIES:
        with job_queue._connect() as db:
            with db.cursor() as cursor:
                cursor.execute(sql.SQL('SELECT content,sha256,size,object_key,object_bucket FROM {}').format(sql.Identifier(table)))
                for row in cursor:
                    raw = blob_storage.read(row, use_cache=False)
                    result['verified_files'] += 1
                    result['verified_bytes'] += len(raw)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--apply', action='store_true', help='Upload, verify, then release BYTEA for each file')
    group.add_argument('--verify', action='store_true', help='Verify every stored file without changing it')
    group.add_argument('--gc', action='store_true', help='Collect expired unreferenced objects')
    args = parser.parse_args()
    if args.gc:
        postgres_storage.ensure_schema()
        rag.ensure_schema()
        result = {'deleted_objects': blob_storage.collect_garbage()}
    else:
        result = verify() if args.verify else migrate(apply=args.apply)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
