"""Read-only queue checks for an external monitoring scheduler.

Run python -m app.ops_check with DATABASE_URL configured. Exit 1 means attention,
2 means the check itself failed. This cannot detect an idle unavailable worker;
also monitor container state and run a staging synthetic job.
"""
import json
import os
import sys
import psycopg


def main():
    try:
        threshold = int(os.getenv('BOB_OPS_QUEUE_AGE_SECONDS', '300'))
        if threshold < 1:
            raise ValueError('Queue age threshold must be positive')
        with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=5) as db:
            db.execute('SET TRANSACTION READ ONLY')
            db.execute("SET LOCAL statement_timeout = '5s'")
            expired = db.execute("SELECT count(*) FROM bob_jobs WHERE status='running' AND lease_until < now()").fetchone()[0]
            queued = db.execute("SELECT count(*) FROM bob_jobs WHERE status='queued' AND created_at < now()-(%s * interval '1 second')", (threshold,)).fetchone()[0]
        print(json.dumps({'expired_job_leases': expired, 'overdue_queued_jobs': queued, 'queue_age_threshold_seconds': threshold}))
        return 1 if expired or queued else 0
    except Exception:
        # Connection error strings may include credential-bearing DSNs.
        print(json.dumps({'error': 'Operational check failed; inspect database access and schema'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
