"""Short-lived, shared login attempt limits; never stores passwords or raw identities."""
import hashlib
from contextlib import contextmanager

WINDOW_SECONDS = 60
ACCOUNT_LIMIT = 8
SOURCE_LIMIT = 120


class LoginThrottled(Exception):
    def __init__(self, retry_after=WINDOW_SECONDS):
        self.retry_after = max(1, min(WINDOW_SECONDS, int(retry_after)))
        super().__init__('Too many sign-in attempts. Please try again shortly.')


def bucket_keys(username, source):
    account = hashlib.sha256(username.strip().lower().encode('utf-8')).hexdigest()
    peer = hashlib.sha256((source or 'unknown').encode('utf-8')).hexdigest()
    return [('account:' + account, ACCOUNT_LIMIT), ('source:' + peer, SOURCE_LIMIT)]


@contextmanager
def _database():
    from app.auth import _connect
    with _connect() as db:
        yield db


def reserve_login_attempt(username, source):
    """Reserve before expensive verification, across all workers sharing the DB.

    Windows expire rather than creating permanent account lockouts. Account and
    source budgets are independent; client-supplied forwarding headers are ignored.
    """
    blocked = False
    with _database() as db:
        # Serialize first-time DDL and two-key reservations across processes.
        db.execute("SELECT pg_advisory_xact_lock(hashtext('login-attempt-limits'))")
        db.execute('''CREATE TABLE IF NOT EXISTS bob_login_attempts (
            bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
        # Table size is bounded by attempts in recent windows, not lifetime traffic.
        db.execute("DELETE FROM bob_login_attempts WHERE window_started_at < now() - interval '2 minutes'")
        # Check source first so a blocked source cannot create unlimited account buckets.
        for key, limit in reversed(bucket_keys(username, source)):
            row = db.execute('''INSERT INTO bob_login_attempts(bucket,attempts) VALUES (%s,1)
                ON CONFLICT(bucket) DO UPDATE SET
                attempts=CASE WHEN bob_login_attempts.window_started_at <= now() - interval '60 seconds'
                    THEN 1 ELSE LEAST(bob_login_attempts.attempts+1,%s) END,
                window_started_at=CASE WHEN bob_login_attempts.window_started_at <= now() - interval '60 seconds'
                    THEN now() ELSE bob_login_attempts.window_started_at END RETURNING attempts''',
                (key, limit + 1)).fetchone()
            if row[0] > limit:
                blocked = True
                break
    # Commit reservations even when blocked; no rollback that resets the budget.
    if blocked:
        raise LoginThrottled()


def clear_account_attempts(username):
    key = bucket_keys(username, '')[0][0]
    with _database() as db:
        # Successful authentication follows reserve_login_attempt, which creates schema.
        db.execute('DELETE FROM bob_login_attempts WHERE bucket=%s', (key,))
