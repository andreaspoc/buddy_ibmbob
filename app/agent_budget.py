"""Execution quotas shared by every broker in a job, and every worker for a user.

These are hard action quotas, not invented estimates of provider charges. Reported
USD/token usage remains explicitly unknown when the provider does not expose it.
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from threading import Lock


class BudgetExceeded(PermissionError):
    pass


def _limit(name, default):
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f'{name} must be a positive integer') from exc
    if value <= 0:
        raise ValueError(f'{name} must be a positive integer')
    return value


_schema_lock = Lock()
_schema_urls = set()


def _reserve_user_action(username, maximum):
    """Reserve before execution; a failed call still consumes its reservation.

    The UPSERT serializes concurrent workers. DB time defines the UTC quota day,
    and unavailable accounting fails closed instead of resetting the allowance.
    """
    from app.job_queue import _connect
    url = os.environ['DATABASE_URL']
    with _schema_lock:
        if url not in _schema_urls:
            with _connect() as db:
                db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_agent_quotas_schema'))")
                db.execute('''CREATE TABLE IF NOT EXISTS bob_agent_daily_quotas (
                    username TEXT NOT NULL, quota_day DATE NOT NULL,
                    actions BIGINT NOT NULL CHECK(actions > 0),
                    PRIMARY KEY(username, quota_day))''')
            _schema_urls.add(url)
    with _connect() as db:
        row = db.execute('''INSERT INTO bob_agent_daily_quotas(username,quota_day,actions)
            VALUES (%s,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,1)
            ON CONFLICT(username,quota_day) DO UPDATE
            SET actions=bob_agent_daily_quotas.actions+1
            WHERE bob_agent_daily_quotas.actions < %s RETURNING actions''',
                         (username, maximum)).fetchone()
        if not row:
            raise BudgetExceeded('Daily agent action quota reached')


class RunBudget:
    """One server-owned instance per job. Never accept limits from tool payloads."""

    def __init__(self, username):
        if not isinstance(username, str) or not username:
            raise PermissionError('Authenticated budget owner required')
        self.username = username
        self.limits = {'tool': _limit('BUDDY_AGENT_MAX_TOOL_CALLS', 100),
                       'inference': _limit('BUDDY_AGENT_MAX_INFERENCE_CALLS', 16),
                       'remote': _limit('BUDDY_AGENT_MAX_REMOTE_CALLS', 6),
                       'specialist': _limit('BUDDY_AGENT_MAX_SPECIALIST_CALLS', 6)}
        self.daily_limit = _limit('BUDDY_AGENT_MAX_DAILY_ACTIONS', 1000)
        self.deadline = time.monotonic() + _limit('BUDDY_AGENT_MAX_RUN_SECONDS', 3600)
        self.counts = dict.fromkeys(self.limits, 0)
        self.total = 0
        self._lock = asyncio.Lock()

    async def consume(self, kind='tool'):
        if kind not in self.limits:
            raise PermissionError('Unknown agent budget category')
        async with self._lock:
            if time.monotonic() >= self.deadline:
                raise BudgetExceeded('Agent run time quota reached')
            if self.total >= self.limits['tool'] or self.counts[kind] >= self.limits[kind]:
                raise BudgetExceeded('Agent action quota reached')
            # Reserve local capacity before yielding. Keep it consumed even on
            # cancellation so a retry cannot reset an in-flight reservation.
            self.counts[kind] += 1
            self.total += 1
            try:
                await asyncio.to_thread(_reserve_user_action, self.username, self.daily_limit)
            except BudgetExceeded:
                raise
            except Exception as exc:
                raise BudgetExceeded('Agent quota accounting unavailable') from exc


def reported_usage(value):
    """Only expose valid provider-reported totals; never turn missing into zero."""
    result = {'tokens': None, 'cost': None}
    if isinstance(value, dict):
        for name in result:
            number = value.get(name)
            if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0:
                result[name] = number
        if result['tokens'] is not None and value.get('tokens_basis') in {'input_output', 'context_calls'}:
            result['tokens_basis'] = value['tokens_basis']
    return result
