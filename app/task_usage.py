"""Recover reported usage from owner-scoped Buddy task stores."""
from __future__ import annotations

import json
import math
import sqlite3
import time
import tempfile
from pathlib import Path
from collections import OrderedDict
from threading import Lock

# Task lists poll frequently. Cache small results, not potentially large DB blobs.
_CACHE = OrderedDict()
_CACHE_LOCK = Lock()
_CACHE_TTL = 30
_CACHE_LIMIT = 128
_TOKEN_BASES = {'input_output', 'context_calls'}


def _message_tokens(connection, task_id, reported_cost):
    """Sum per-call reported context counts only when they cover the task's cost."""
    if not isinstance(reported_cost, (int, float)) or isinstance(reported_cost, bool) or not math.isfinite(reported_cost) or reported_cost < 0:
        return None
    try:
        rows = connection.execute("SELECT data FROM messages WHERE task_id=? AND role='assistant'", (task_id,))
        tokens, cost, calls = 0, 0, 0
        for (raw,) in rows:
            spend = json.loads(raw).get('_meta', {}).get('spend')
            if not spend:
                continue
            count, charge = spend.get('contextTokens'), spend.get('cost')
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in (count, charge)):
                return None
            tokens += count
            cost += charge
            calls += 1
        # A missing/partial message archive must never become a lower usage total.
        return tokens if calls and math.isclose(cost, reported_cost, rel_tol=1e-9, abs_tol=1e-9) else None
    except (sqlite3.Error, ValueError, TypeError, AttributeError):
        return None


def read_usage(connection, task_ids):
    result = {}
    ids = sorted(set(task_ids))
    for start in range(0, len(ids), 500):
        batch = ids[start:start + 500]
        # Bind the whole batch as data; the SQL statement never depends on IDs.
        rows = connection.execute('SELECT id,costs FROM tasks WHERE id IN (SELECT value FROM json_each(?))',
                                  (json.dumps(batch),))
        for task_id, raw in rows:
            if not raw:
                continue
            try:
                costs = json.loads(raw)
                usage = {}
                # contextTokens is the latest context window, not cumulative usage.
                counts = [costs.get(name) for name in ('input', 'output')]
                if all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in counts):
                    usage['tokens'] = sum(counts)
                    usage['tokens_basis'] = 'input_output'
                if 'tokens' not in usage:
                    total = _message_tokens(connection, task_id, costs.get('cost'))
                    if total is not None:
                        usage['tokens'] = total
                        usage['tokens_basis'] = 'context_calls'
                for field, source in (('cost', 'cost'),):
                    value = costs.get(source)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                        usage[field] = value
                result[task_id] = usage
            except (ValueError, TypeError, AttributeError):
                continue
    return result


def _stored_usage(storage, username, scope, path, ids):
    key = (username, scope, path, tuple(sorted(set(ids))))
    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and now - cached[0] < _CACHE_TTL:
            _CACHE.move_to_end(key)
            return cached[1]
    stored = storage.get_file(username, scope, path, internal=True)
    found = {}
    if stored:
        # Archived task stores may use WAL; deserialize cannot open WAL databases.
        with tempfile.TemporaryDirectory(prefix='buddy-usage-') as directory:
            database = Path(directory) / 'bob.db'
            database.write_bytes(bytes(stored['content']))
            wal = storage.get_file(username, scope, path + '-wal', internal=True)
            if wal:
                database.with_name('bob.db-wal').write_bytes(bytes(wal['content']))
            with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
                found = read_usage(connection, ids)
    with _CACHE_LOCK:
        _CACHE[key] = (now, found)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return found


def recover_usage(username, session_id, events):
    """Recover reported totals; replace legacy context-window counts from task data."""
    missing = [event for event in events if isinstance(event.get('session_id'), str) and
               (event.get('tokens_basis') not in _TOKEN_BASES or event.get('tokens') is None or event.get('cost') is None)]
    if not missing:
        return events
    from app import postgres_storage as storage
    from app.sessions import _root, _VALID_USER, _VALID_ID
    if not isinstance(username, str) or not isinstance(session_id, str) or not _VALID_USER.fullmatch(username) or not _VALID_ID.fullmatch(session_id):
        return events
    ids = [event['session_id'] for event in missing]
    usage = {}

    def merge(found):
        for task_id, values in found.items():
            target = usage.setdefault(task_id, {})
            for key, value in values.items():
                target.setdefault(key, value)

    def complete():
        return all(all((event.get(key) is not None and (key != 'tokens' or event.get('tokens_basis') in _TOKEN_BASES)) or key in usage.get(event['session_id'], {})
                       for key in ('tokens', 'cost')) for event in missing)

    # New tasks persist the isolated home; older tasks used a shared user home.
    for scope, path in (('home:' + session_id, '.bob/db/bob.db'),
                        ('user', '.home/.bob/db/bob.db')):
        try:
            merge(_stored_usage(storage, username, scope, path, ids))
        except Exception:
            # Recovery is optional: unavailable storage must not hide task history.
            continue
        if complete():
            break
    if not complete():
        legacy = _root() / 'users' / username / '.home' / '.bob' / 'db' / 'bob.db'
        try:
            if legacy.is_file():
                with sqlite3.connect(legacy.as_uri() + '?mode=ro', uri=True) as connection:
                    merge(read_usage(connection, ids))
        except (sqlite3.Error, OSError):
            pass
    return [{**event,
             **({'tokens': None} if event.get('session_id') and event.get('tokens_basis') not in _TOKEN_BASES else {}),
             **{key: value for key, value in usage.get(event.get('session_id'), {}).items()
                if event.get(key) is None or key in {'tokens', 'tokens_basis'}}} for event in events]
