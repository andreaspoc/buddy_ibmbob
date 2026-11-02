"""Back up Compose PostgreSQL and prove restoration into a disposable database.

Usage: python3 scripts/verify_database_backup.py /private/tmp/bob-backup.dump
The output contains sensitive application data; store it securely. Existing files
are never overwritten. This does not back up external object-storage contents.
"""
import os
from pathlib import Path
import subprocess
import sys
import uuid


def postgres(*args, **kwargs):
    return subprocess.run(
        ['docker', 'compose', 'exec', '-T', 'postgres', *args],
        check=True, **kwargs,
    )


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Supply a new, secure backup output path')
    output = Path(sys.argv[1]).resolve()
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as archive:
        postgres('pg_dump', '-U', 'bob', '-d', 'bob', '-Fc', stdout=archive)
    database = 'bob_restore_check_' + uuid.uuid4().hex
    postgres('createdb', '-U', 'bob', database)
    try:
        with output.open('rb') as archive:
            postgres('pg_restore', '-U', 'bob', '-d', database,
                     '--exit-on-error', '--no-owner', stdin=archive)
        postgres('psql', '-U', 'bob', '-d', database, '-v', 'ON_ERROR_STOP=1',
                 '-c', "SELECT count(*) AS restored_tables FROM information_schema.tables WHERE table_schema='public';")
        print('Database archive restored successfully; application and object-store recovery still require verification.')
    finally:
        postgres('dropdb', '-U', 'bob', database)


if __name__ == '__main__':
    main()
