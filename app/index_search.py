"""Backfill the bounded workspace text projection, including S3-backed files.

Run: python3 -m app.index_search. Safe to repeat; never changes file bytes.
"""
from app import postgres_storage as storage, job_queue, blob_storage
from app.search_text import searchable_text, TEXT_SUFFIXES
from pathlib import PurePosixPath


def main():
    storage.ensure_schema()
    indexed = 0
    with job_queue._connect() as db:
        rows = db.execute('SELECT username,scope,path,sha256 FROM bob_storage_files WHERE search_text IS NULL').fetchall()
    for row in rows:
        path = row['path']
        text = ''
        eligible = PurePosixPath(path).suffix.lower() in TEXT_SUFFIXES and not any(p.startswith('.') or p in {'node_modules','__pycache__','vendor'} for p in PurePosixPath(path).parts)
        if eligible:
            source = storage.get_file(row['username'], row['scope'], path, internal=True)
            if source is None or source['sha256'] != row['sha256']:
                continue
            text = searchable_text(path, source['content'])
        with job_queue._connect() as db:
            db.execute('UPDATE bob_storage_files SET search_text=%s WHERE username=%s AND scope=%s AND path=%s AND sha256=%s AND search_text IS NULL',
                       (text, row['username'], row['scope'], path, row['sha256']))
        indexed += 1
    print(f'Indexed {indexed} workspace file records.')


if __name__ == '__main__':
    main()
