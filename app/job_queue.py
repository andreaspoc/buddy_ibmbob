"""PostgreSQL-backed Buddy jobs and durable stream events."""
from __future__ import annotations
from app.branding import brand_text
from threading import Lock

import asyncio
import json
import os
import re
import uuid
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row


LEASE_SECONDS = 180
# Agent tools may have already performed external writes when a lease expires.
# Replaying an arbitrary prompt cannot guarantee idempotency.
MAX_ATTEMPTS = 1


def _connect():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


@contextmanager
def session_guard(username: str, workspace_id: str):
    """Serialize uploads with deletion of the same conversation."""
    ensure_schema()
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"conversation:{username}:{workspace_id}",))
        if db.execute("SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s",
                      (username, workspace_id)).fetchone():
            raise ValueError("Conversation is being deleted")
        yield


def ensure_schema() -> None:
    with _schema_lock:
        if os.environ["DATABASE_URL"] in _schema_urls: return
        _create_schema()
        _schema_urls.add(os.environ["DATABASE_URL"])


_schema_urls: set[str] = set()
_schema_lock = Lock()


def _create_schema():
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_jobs_schema'))")
        db.execute("""CREATE TABLE IF NOT EXISTS bob_jobs (
            id UUID PRIMARY KEY, username TEXT NOT NULL, workspace_id TEXT NOT NULL,
            workspace_key TEXT NOT NULL, payload JSONB NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
            attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
            worker_token UUID, lease_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS bob_jobs_one_active_workspace
            ON bob_jobs (workspace_key) WHERE status IN ('queued','running')""")
        db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS bob_jobs_one_running_user
            ON bob_jobs (username) WHERE status='running'""")
        db.execute("""CREATE TABLE IF NOT EXISTS bob_job_events (
            id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES bob_jobs(id) ON DELETE CASCADE,
            event JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS bob_job_events_by_job ON bob_job_events (job_id,id)")
        db.execute("""CREATE TABLE IF NOT EXISTS bob_job_guidance (
            id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL REFERENCES bob_jobs(id) ON DELETE CASCADE,
            instruction TEXT NOT NULL, applied BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
        db.execute("CREATE INDEX IF NOT EXISTS bob_guidance_by_job ON bob_job_guidance(job_id,id)")
        db.execute("""CREATE TABLE IF NOT EXISTS bob_job_approvals (
            id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES bob_jobs(id) ON DELETE CASCADE,
            worker_token UUID NOT NULL, event JSONB NOT NULL,
            decision TEXT CHECK (decision IN ('approve','reject')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")

        db.execute("""CREATE TABLE IF NOT EXISTS bob_deleted_conversations (
            username TEXT NOT NULL, workspace_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('deleting','deleted')),
            project_id TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (username,workspace_id)
        )""")
        db.execute("ALTER TABLE bob_deleted_conversations ADD COLUMN IF NOT EXISTS project_id TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS bob_chat_submissions (
            username TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL, job_id UUID NOT NULL REFERENCES bob_jobs(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY(username,workspace_id,idempotency_key))""")


def find_submission(username, workspace_id, key, request_hash):
    ensure_schema()
    with _connect() as db:
        return _find_submission(db, username, workspace_id, key, request_hash)


def _find_submission(db, username, workspace_id, key, request_hash):
    from app.chat_submission import SubmissionResult
    row = db.execute("""SELECT s.request_hash,j.id,j.payload FROM bob_chat_submissions s
        JOIN bob_jobs j ON j.id=s.job_id
        WHERE s.username=%s AND s.workspace_id=%s AND s.idempotency_key=%s""",
        (username, workspace_id, key)).fetchone()
    if row:
        if row['request_hash'] != request_hash:
            raise ValueError('Idempotency key was already used for a different request')
        return SubmissionResult(row['id'], row['payload'], reused=True)
    return None


def enqueue(username: str, workspace_id: str, workspace_key: str, payload: dict[str, Any], *,
            idempotency_key=None, request_hash=None, request_event=None) -> str:
    ensure_schema()
    job_id = str(uuid.uuid4())
    from app.chat_correlation import turn_metadata
    queued_event = {"type": "status", "message": brand_text("Queued for a Buddy worker"),
                    **turn_metadata(payload, workspace_id, job_id)}
    try:
        with _connect() as db:
            from app import postgres_storage as storage
            scope = workspace_key.removeprefix(username + ':')
            storage._lock(db, username, 'user')
            storage._lock(db, username, scope)
            if scope.startswith('project:') and not db.execute('SELECT 1 FROM projects WHERE username=%s AND id=%s',
                                                              (username, scope.split(':', 1)[1])).fetchone():
                raise ValueError('Project has been deleted')
            db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"conversation:{username}:{workspace_id}",))
            if db.execute("SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s",
                          (username, workspace_id)).fetchone():
                raise ValueError("Conversation is being deleted or has been deleted")
            record = db.execute('SELECT record FROM bob_conversations WHERE username=%s AND id=%s', (username, workspace_id)).fetchone()
            edited_history = bool(record and record['record'].get('history_revision', 0))
            if not edited_history:
                # Legacy workspaces do not have a conversation metadata row.
                edited_history = bool(db.execute("""SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s
                    AND (event->>'user_deleted'='true' OR event->>'assistant_deleted'='true') LIMIT 1""", (username, workspace_id)).fetchone())
            if edited_history:
                if db.execute("""SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s
                    AND (event->>'user_deleted'='true' OR event->>'assistant_deleted'='true')
                    AND (event->>'user_message_id'=%s OR event->>'assistant_message_id'=%s)""",
                              (username, workspace_id, payload.get('user_message_id'), payload.get('assistant_message_id'))).fetchone():
                    raise ValueError('This message was deleted. Send a new question instead of retrying it.')
                # Never trust stale browser/native contexts after message deletion.
                payload = {**payload, 'session_id': None, 'agent_context_id': None, 'context_rebuilt': True}
            if idempotency_key:
                existing = _find_submission(db, username, workspace_id, idempotency_key, request_hash)
                if existing:
                    return existing

            # Auto-supersede any existing queued or running jobs in this workspace
            rows = db.execute(
                "SELECT id,payload,workspace_id FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running') FOR UPDATE",
                (workspace_key,)
            ).fetchall()
            for r in rows:
                cancel_event = {"type": "error", "message": "Superseded by a new prompt", "cancelled": True,
                                **turn_metadata(r.get('payload', {}), r.get('workspace_id'), r['id'])}
                from app.delivery import delivery_event, persist_delivery
                persist_delivery(db, r['id'], username, r.get('workspace_id', workspace_id), delivery_event('cancelled', cancel_event))
                db.execute(
                    """UPDATE bob_jobs
                       SET status='failed', worker_token=NULL, lease_until=NULL,
                           payload=payload || %s::jsonb, updated_at=now()
                       WHERE id=%s""",
                    (json.dumps({"cancel_requested": True, "superseded": True}), r["id"])
                )
                db.execute("INSERT INTO bob_job_events (job_id, event) VALUES (%s, %s::jsonb)",
                           (r["id"], _dumps_jsonb(cancel_event)))
                clean_r_id = str(r["id"]).replace("-", "")
                db.execute("SELECT pg_notify(%s, %s)", (f"bob_job_{clean_r_id}", _dumps_jsonb(cancel_event)))

            # Clear expired running jobs for this user
            db.execute(
                """UPDATE bob_jobs SET status='failed', worker_token=NULL, lease_until=NULL, updated_at=now()
                   WHERE username=%s AND status='running' AND lease_until < now()""",
                (username,)
            )

            db.execute("""INSERT INTO bob_jobs
                (id,username,workspace_id,workspace_key,payload,status,max_attempts)
                VALUES (%s,%s,%s,%s,%s::jsonb,'queued',%s)""",
                (job_id, username, workspace_id, workspace_key, _dumps_jsonb(payload), MAX_ATTEMPTS))
            db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)",
                       (job_id, _dumps_jsonb(queued_event)))
            _record_submission(db, username, workspace_id, job_id, payload, idempotency_key, request_hash, request_event)
            db.execute("SELECT pg_notify('bob_jobs_ready', %s)", (job_id,))
    except UniqueViolation:
        # Race-condition recovery: auto-supersede and retry insert cleanly
        with _connect() as db:
            storage._lock(db, username, 'user')
            db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"conversation:{username}:{workspace_id}",))
            record = db.execute('SELECT record FROM bob_conversations WHERE username=%s AND id=%s', (username, workspace_id)).fetchone()
            edited_history = bool(record and record['record'].get('history_revision', 0))
            if not edited_history:
                # Legacy workspaces do not have a conversation metadata row.
                edited_history = bool(db.execute("""SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s
                    AND (event->>'user_deleted'='true' OR event->>'assistant_deleted'='true') LIMIT 1""", (username, workspace_id)).fetchone())
            if edited_history:
                if db.execute("""SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s
                    AND (event->>'user_deleted'='true' OR event->>'assistant_deleted'='true')
                    AND (event->>'user_message_id'=%s OR event->>'assistant_message_id'=%s)""",
                              (username, workspace_id, payload.get('user_message_id'), payload.get('assistant_message_id'))).fetchone():
                    raise ValueError('This message was deleted. Send a new question instead of retrying it.')
                # Never trust stale browser/native contexts after message deletion.
                payload = {**payload, 'session_id': None, 'agent_context_id': None, 'context_rebuilt': True}
            if idempotency_key:
                existing = _find_submission(db, username, workspace_id, idempotency_key, request_hash)
                if existing:
                    return existing
            db.execute("""UPDATE bob_jobs SET status='failed', worker_token=NULL, lease_until=NULL, updated_at=now()
                          WHERE workspace_key=%s AND status IN ('queued','running')""", (workspace_key,))
            db.execute("""INSERT INTO bob_jobs
                (id,username,workspace_id,workspace_key,payload,status,max_attempts)
                VALUES (%s,%s,%s,%s,%s::jsonb,'queued',%s)""",
                (job_id, username, workspace_id, workspace_key, _dumps_jsonb(payload), MAX_ATTEMPTS))
            db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)",
                       (job_id, _dumps_jsonb(queued_event)))
            _record_submission(db, username, workspace_id, job_id, payload, idempotency_key, request_hash, request_event)
            db.execute("SELECT pg_notify('bob_jobs_ready', %s)", (job_id,))
    from app.chat_submission import SubmissionResult
    return SubmissionResult(job_id, payload) if idempotency_key else job_id


def _record_submission(db, username, workspace_id, job_id, payload, key, request_hash, request_event):
    from app.chat_correlation import turn_metadata
    metadata = turn_metadata(payload, workspace_id, job_id)
    if key:
        db.execute("""INSERT INTO bob_chat_submissions(username,workspace_id,idempotency_key,request_hash,job_id)
            VALUES (%s,%s,%s,%s,%s)""", (username, workspace_id, key, request_hash, job_id))
    if request_event is not None:
        event = {**request_event, **metadata, 'message_id': payload['user_message_id']}
        db.execute("INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)",
                   (username, workspace_id, _dumps_jsonb(event)))
    from app.delivery import delivery_event, persist_delivery
    for state in ('accepted', 'queued'):
        persist_delivery(db, job_id, username, workspace_id, delivery_event(state, metadata))


def begin_deletion(username: str, workspace_id: str, workspace_key: str, project_id: str | None = None) -> str:
    ensure_schema()
    with _connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"conversation:{username}:{workspace_id}",))
        row = db.execute("SELECT status FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s",
                         (username, workspace_id)).fetchone()
        if row:
            if row["status"] == "deleting" and db.execute(
                "SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running') LIMIT 1",
                (workspace_key,),
            ).fetchone():
                raise ValueError("A job is active in this conversation or project")
            return row["status"]
        if db.execute("SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running') LIMIT 1",
                      (workspace_key,)).fetchone():
            raise ValueError("A job is active in this conversation or project")
        db.execute("INSERT INTO bob_deleted_conversations (username,workspace_id,status,project_id) VALUES (%s,%s,'deleting',%s)",
                   (username, workspace_id, project_id))
        return "deleting"


def complete_deletion(username: str, workspace_id: str) -> None:
    with _connect() as db:
        db.execute("""UPDATE bob_deleted_conversations SET status='deleted',updated_at=now()
            WHERE username=%s AND workspace_id=%s""", (username, workspace_id))


def deletion_record(username: str, workspace_id: str) -> dict | None:
    ensure_schema()
    with _connect() as db:
        row = db.execute("SELECT status,project_id FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s",
                         (username, workspace_id)).fetchone()
    return row


def deletion_status(username: str, workspace_id: str) -> str | None:
    row = deletion_record(username, workspace_id)
    return row["status"] if row else None


def deleted_session_ids(username: str) -> set[str]:
    ensure_schema()
    with _connect() as db:
        rows = db.execute("SELECT workspace_id FROM bob_deleted_conversations WHERE username=%s", (username,)).fetchall()
    return {row["workspace_id"] for row in rows}


def deletion_states(username: str) -> dict[str, dict]:
    ensure_schema()
    with _connect() as db:
        rows = db.execute("SELECT workspace_id,status,project_id FROM bob_deleted_conversations WHERE username=%s", (username,)).fetchall()
    return {row["workspace_id"]: {"status": row["status"], "project_id": row["project_id"]} for row in rows}


def session_done_task_ids(username: str, workspace_id: str) -> set[str]:
    ensure_schema()
    with _connect() as db:
        rows = db.execute("""SELECT event->>'session_id' AS task_id FROM bob_job_events e
            JOIN bob_jobs j ON j.id=e.job_id WHERE j.username=%s AND j.workspace_id=%s
            AND event->>'type' IN ('done','error') AND event ? 'session_id'""", (username, workspace_id)).fetchall()
    return {row["task_id"] for row in rows if row["task_id"]}


def session_unique_bob_prompts(username: str, workspace_id: str) -> set[str]:
    """Prompts owned only by this conversation, for recovering missing task IDs."""
    ensure_schema()
    with _connect() as db:
        rows = db.execute("""SELECT workspace_id,payload->>'bob_prompt' AS prompt
            FROM bob_jobs WHERE username=%s AND payload ? 'bob_prompt'""", (username,)).fetchall()
    own = {row["prompt"] for row in rows if row["workspace_id"] == workspace_id and row["prompt"]}
    others = {row["prompt"] for row in rows if row["workspace_id"] != workspace_id and row["prompt"]}
    return own - others


def delete_session_jobs(username: str, workspace_id: str) -> None:
    with _connect() as db:
        db.execute("DELETE FROM bob_jobs WHERE username=%s AND workspace_id=%s", (username, workspace_id))


def get_job(job_id: str, username: str | None = None) -> dict[str, Any] | None:
    ensure_schema()
    with _connect() as db:
        if username is None:
            return db.execute("SELECT * FROM bob_jobs WHERE id=%s", (job_id,)).fetchone()
        return db.execute("SELECT * FROM bob_jobs WHERE id=%s AND username=%s", (job_id, username)).fetchone()


def has_active_workspace(workspace_key: str) -> bool:
    ensure_schema()
    with _connect() as db:
        return db.execute("SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running') LIMIT 1", (workspace_key,)).fetchone() is not None


def events_after(job_id: str, after_id: int) -> tuple[list[dict[str, Any]], str | None]:
    with _connect() as db:
        rows = db.execute("SELECT id,event FROM bob_job_events WHERE job_id=%s AND id>%s ORDER BY id LIMIT 200", (job_id, after_id)).fetchall()
        job = db.execute("SELECT status FROM bob_jobs WHERE id=%s", (job_id,)).fetchone()
    return rows, job["status"] if job else None


def requeue_expired() -> None:
    ensure_schema()
    with _connect() as db:
        rows = db.execute("""SELECT id,username,attempts,max_attempts,payload,workspace_id FROM bob_jobs
            WHERE status='running' AND lease_until<now() FOR UPDATE SKIP LOCKED""").fetchall()
        for row in rows:
            if row["attempts"] < row["max_attempts"] and not row["payload"].get("cancel_requested"):
                db.execute("""UPDATE bob_jobs SET status='queued', worker_token=NULL,
                    lease_until=NULL,updated_at=now() WHERE id=%s""", (row["id"],))
                event = {"type": "status", "message": "Worker stopped; retrying job"}
            else:
                db.execute("""UPDATE bob_jobs SET status='failed', worker_token=NULL,
                    lease_until=NULL,updated_at=now() WHERE id=%s""", (row["id"],))
                event = ({"type": "error", "message": "Stopped by you", "cancelled": True}
                         if row["payload"].get("cancel_requested") else
                         {"type": "error", "message": "Worker stopped before completing the job. Review external actions before submitting again."})
            from app.chat_correlation import turn_metadata
            event = {**event, **turn_metadata(row['payload'], row['workspace_id'], row['id'])}
            from app.delivery import delivery_event, persist_delivery, terminal_state
            persist_delivery(db, row['id'], row['username'], row['workspace_id'],
                             delivery_event('queued' if event['type'] == 'status' else terminal_state(event), event))
            db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)", (row["id"], _dumps_jsonb(event)))


def claim(worker_token: str) -> dict[str, Any] | None:
    ensure_schema()
    try:
        with _connect() as db:
            row = db.execute("""SELECT * FROM bob_jobs j WHERE status='queued'
                AND NOT EXISTS (SELECT 1 FROM bob_jobs active
                    WHERE active.username=j.username AND active.status='running')
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
            if not row:
                return None
            db.execute("""UPDATE bob_jobs SET status='running', attempts=attempts+1,
                worker_token=%s,lease_until=now()+(%s * interval '1 second'),updated_at=now()
                WHERE id=%s""", (worker_token, LEASE_SECONDS, row["id"]))
            from app.chat_correlation import turn_metadata
            db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)",
                       (row["id"], _dumps_jsonb({"type": "status", "message": brand_text("Buddy is starting"),
                                                **turn_metadata(row['payload'], row['workspace_id'], row['id'])})))
            from app.delivery import delivery_event, persist_delivery
            persist_delivery(db, row['id'], row['username'], row['workspace_id'],
                             delivery_event('running', turn_metadata(row['payload'], row['workspace_id'], row['id'])))
            row["worker_token"] = worker_token
            row["status"] = "running"
            return row
    except UniqueViolation:
        return None


def heartbeat(job_id: str, worker_token: str) -> bool:
    with _connect() as db:
        result = db.execute("""UPDATE bob_jobs SET lease_until=now()+(%s * interval '1 second'),updated_at=now()
            WHERE id=%s AND worker_token=%s AND status='running'""", (LEASE_SECONDS, job_id, worker_token))
        return result.rowcount == 1


def _clean_null_bytes(data: Any) -> Any:
    if isinstance(data, str):
        return data.replace('\x00', '').replace('\u0000', '')
    if isinstance(data, dict):
        return {_clean_null_bytes(k): _clean_null_bytes(v) for k, v in data.items()}
    if isinstance(data, (list, tuple, set)):
        return [_clean_null_bytes(x) for x in data]
    return data


def _dumps_jsonb(data: Any) -> str:
    cleaned = _clean_null_bytes(data)
    encoded = json.dumps(cleaned, ensure_ascii=False)
    # Consume each backslash run once, including runs without a null escape.
    # Requiring u0000 after the run retries a long near miss at every slash.
    encoded = re.sub(r'\\+(?:u0000)?',
                     lambda match: '' if match[0].endswith('u0000') else match[0], encoded)
    return encoded.replace('\x00', '')


def append_event(job_id: str, worker_token: str, event: dict[str, Any]) -> bool:
    with _connect() as db:
        row = db.execute("SELECT payload,workspace_id FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running'",
                         (job_id, worker_token)).fetchone()
        if not row:
            return False
        from app.chat_correlation import turn_metadata
        event = {**event, **turn_metadata(row.get('payload', {}), row.get('workspace_id'), job_id)}
        db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)", (job_id, _dumps_jsonb(event)))
        db.execute("SELECT pg_notify('bob_job_events', %s)", (str(job_id),))
        return True


class JobStreamRecorder:
    """Streams live events in-memory to the UI with zero table overhead,
    then batches and persists the completed turn into the database at the end."""

    def __init__(self, job_id: str | uuid.UUID, worker_token: str | uuid.UUID, username: str, workspace_id: str, *, durable: bool = False, correlation: dict | None = None):
        self.durable = durable
        self.job_id = str(job_id)
        self.clean_id = self.job_id.replace("-", "")
        self.channel = f"bob_job_{self.clean_id}"
        self.worker_token = str(worker_token)
        self.username = username
        self.workspace_id = workspace_id
        from app.chat_correlation import turn_metadata
        self.correlation = turn_metadata(correlation, workspace_id, job_id) if correlation is not None else {}
        self._streaming_started = False
        self.accumulated_text: list[str] = []
        self.workflow_events: list[dict[str, Any]] = []
        self.activity_secrets = [os.getenv(name, "") for name in ("BOB_API_KEY", "BOBSHELL_API_KEY")]
        self._conn: psycopg.AsyncConnection | None = None

    async def __aenter__(self):
        try:
            self._conn = await psycopg.AsyncConnection.connect(os.environ["DATABASE_URL"], autocommit=True)
        except Exception:
            self._conn = None
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._conn:
            try:
                await self._conn.close()
            except Exception:
                pass
            self._conn = None

    async def record_event(self, event: dict[str, Any]) -> bool:
        from app.delivery import delivery_event, timestamp
        if event.get('type') == 'delta' and event.get('text') and not self._streaming_started and self.correlation:
            if not await self.record_event(delivery_event('streaming', self.correlation)):
                return False
            self._streaming_started = True
        event = {**event, **self.correlation}
        if event.get('type') == 'artifact':
            event = {**event, 'timestamp': timestamp()}
        event_type = event.get("type")
        if event_type in {"tool", "status", "approval"}:
            from app.redaction import redact
            event = redact(event, self.activity_secrets)
        if event_type == "delta":
            text = event.get("text")
            if isinstance(text, str):
                if event.get("replace"):
                    self.accumulated_text = [text]
                else:
                    self.accumulated_text.append(text)
        elif event_type not in {"done", "error"} and not self.durable:
            self.workflow_events.append(event)

        # Checkpoint the finished answer independently of artifact/home writes.
        # Refresh/reconnect can recover it while the job is still saving files.
        if self.durable and event_type == 'delivery_state' and event.get('state') == 'saving':
            snapshot = {'type': 'delta', 'text': ''.join(self.accumulated_text), 'replace': True, **self.correlation}
            if not await asyncio.to_thread(self._persist_event, self.job_id, self.worker_token,
                                           self.username, self.workspace_id, snapshot):
                return False

        # Durably record structural workflow events (status, tool, skill) so task inspectors see progress.
        # Do not block live text deltas with synchronous DB locks; the full response text is consolidated in finish().
        if self.durable and event_type != "delta":
            event_id = await asyncio.to_thread(self._persist_event, self.job_id, self.worker_token,
                                              self.username, self.workspace_id, event)
            if not event_id:
                return False
            if isinstance(event_id, int) and not isinstance(event_id, bool):
                event['event_id'] = event_id

        # Prepare in-memory live stream payload
        payload = _clean_null_bytes(event)
        if event_type == "tool" and isinstance(payload.get("output"), (str, dict, list)):
            out_str = str(payload["output"])
            if len(out_str) > 3500:
                payload = {**payload, "output": out_str[:3500] + "… (preview)"}

        jsonb_str = _dumps_jsonb(payload)
        if len(jsonb_str.encode("utf-8")) > 7500:
            safe_payload = {"type": event_type, "id": event.get("id"), "status": event.get("status"), **self.correlation}
            jsonb_str = _dumps_jsonb(safe_payload)

        try:
            if self._conn is None or self._conn.closed:
                self._conn = await psycopg.AsyncConnection.connect(os.environ["DATABASE_URL"], autocommit=True)
            # 100% in-memory pub/sub notice to the UI listener
            await self._conn.execute(
                "SELECT pg_notify(%s, %s)",
                (self.channel, jsonb_str),
            )
            return True
        except Exception:
            # Durable replay remains available if the optional live notice fails.
            return self.durable

    @staticmethod
    def _persist_event(job_id, worker_token, username, workspace_id, event):
        """Persist activity and text before delivery so reconnects can replay them."""
        with _connect() as db:
            if not db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE",
                              (job_id, worker_token)).fetchone():
                return False
            encoded = _dumps_jsonb(event)
            inserted = db.execute("INSERT INTO bob_job_events(job_id,event) VALUES (%s,%s::jsonb) RETURNING id", (job_id, encoded)).fetchone()
            db.execute("INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)",
                       (username, workspace_id, encoded))
            db.execute("SELECT pg_notify('bob_job_events',%s)", (job_id,))
            return inserted['id']

    async def finish(self, terminal_event: dict[str, Any]) -> bool:
        from app.delivery import timestamp
        terminal_event = {**terminal_event, **self.correlation, 'timestamp': timestamp()}
        # Commit completion before publishing the terminal notification.
        full_text = "".join(self.accumulated_text)
        await asyncio.to_thread(
            self._persist_completion,
            self.job_id, self.worker_token, self.username, self.workspace_id,
            self.workflow_events, full_text, terminal_event
        )
        # Publish completion after its durable records are committed
        try:
            if self._conn and not self._conn.closed:
                term_str = _dumps_jsonb(terminal_event)
                await self._conn.execute(
                    "SELECT pg_notify(%s, %s)",
                    (self.channel, term_str),
                )
        except Exception:
            pass

        return True

    @staticmethod
    def _persist_completion(job_id: str, worker_token: str, username: str, workspace_id: str,
                            workflow_events: list[dict], full_text: str, terminal_event: dict) -> None:
        from app import postgres_storage as storage
        storage.ensure_schema()
        status = "completed" if terminal_event.get("type") == "done" else "failed"

        with _connect() as db:
            row = db.execute(
                "SELECT username, workspace_id FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE",
                (job_id, worker_token)
            ).fetchone()
            if not row:
                return

            # Batch insert workflow steps
            for evt in workflow_events:
                db.execute("INSERT INTO bob_job_events (job_id, event) VALUES (%s, %s::jsonb)", (job_id, _dumps_jsonb(evt)))
                db.execute("INSERT INTO bob_conversation_history (username, session_id, event) VALUES (%s, %s, %s::jsonb)",
                           (username, workspace_id, _dumps_jsonb(evt)))

            # Batch insert consolidated full delta
            if full_text:
                from app.chat_correlation import turn_metadata
                full_delta = {"type": "delta", "text": full_text, "replace": True,
                              **turn_metadata(terminal_event, workspace_id, job_id)}
                delta_str = _dumps_jsonb(full_delta)
                db.execute("INSERT INTO bob_job_events (job_id, event) VALUES (%s, %s::jsonb)", (job_id, delta_str))
                db.execute("INSERT INTO bob_conversation_history (username, session_id, event) VALUES (%s, %s, %s::jsonb)",
                           (username, workspace_id, delta_str))

            # Commit the final milestone atomically with the terminal result.
            from app.delivery import delivery_event, persist_delivery, terminal_state
            persist_delivery(db, job_id, username, workspace_id,
                             delivery_event(terminal_state(terminal_event), terminal_event, terminal_event.get('timestamp')))
            # Terminal event
            term_str = _dumps_jsonb(terminal_event)
            db.execute("INSERT INTO bob_job_events (job_id, event) VALUES (%s, %s::jsonb)", (job_id, term_str))
            db.execute("""UPDATE bob_jobs SET status=%s, worker_token=NULL, lease_until=NULL, updated_at=now()
                          WHERE id=%s""", (status, job_id))
            db.execute("INSERT INTO bob_conversation_history (username, session_id, event) VALUES (%s, %s, %s::jsonb)",
                       (username, workspace_id, term_str))
            db.execute("SELECT pg_notify('bob_job_events', %s)", (str(job_id),))



def finish(job_id: str, worker_token: str, event: dict[str, Any]) -> bool:
    from app import postgres_storage as storage
    storage.ensure_schema()
    status = "completed" if event.get("type") == "done" else "failed"
    with _connect() as db:
        row = db.execute("SELECT username,workspace_id,payload FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE",
                         (job_id, worker_token)).fetchone()
        if not row:
            return False
        from app.chat_correlation import turn_metadata
        event = {**event, **turn_metadata(row.get('payload', {}), row['workspace_id'], job_id)}
        from app.delivery import delivery_event, persist_delivery, terminal_state, timestamp
        event = {**event, 'timestamp': timestamp()}
        persist_delivery(db, job_id, row['username'], row['workspace_id'], delivery_event(terminal_state(event), event, event['timestamp']))
        jsonb_str = _dumps_jsonb(event)
        db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)", (job_id, jsonb_str))
        db.execute("""UPDATE bob_jobs SET status=%s,worker_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=%s""", (status, job_id))
        db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',
                   (row['username'],row['workspace_id'],jsonb_str))
        db.execute("SELECT pg_notify('bob_job_events', %s)", (str(job_id),))
        return True


def request_cancel(job_id: str, username: str) -> dict | None:
    """Keep running jobs locked until the worker has terminated its process."""
    with _connect() as db:
        row = db.execute("SELECT * FROM bob_jobs WHERE id=%s AND username=%s FOR UPDATE", (job_id, username)).fetchone()
        if not row:
            return None
        if row["status"] in {"queued", "running"}:
            db.execute("UPDATE bob_jobs SET payload=payload || %s::jsonb, updated_at=now() WHERE id=%s", (json.dumps({"cancel_requested": True}), job_id))
            if row["status"] == "queued":
                from app.chat_correlation import turn_metadata
                event = {"type": "error", "message": "Stopped by you", "cancelled": True,
                         **turn_metadata(row['payload'], row['workspace_id'], job_id)}
                db.execute("UPDATE bob_jobs SET status='failed' WHERE id=%s", (job_id,))
                db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)", (job_id, _dumps_jsonb(event)))
                from app.delivery import delivery_event, persist_delivery
                persist_delivery(db, job_id, username, row['workspace_id'], delivery_event('cancelled', event))
                row["status"] = "failed"
                row["cancel_event"] = event
        return row


def cancellation_requested(job_id: str) -> bool:
    with _connect() as db:
        row = db.execute("SELECT payload->>'cancel_requested' AS cancelled FROM bob_jobs WHERE id=%s", (job_id,)).fetchone()
    return bool(row and row["cancelled"] == "true")


async def event_listener():
    connection = await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'], autocommit=True)
    try:
        await connection.execute('LISTEN bob_job_events')
    except BaseException:
        await connection.close()
        raise
    return connection


async def worker_listener():
    """Wake an idle worker as soon as a queued job's transaction commits."""
    connection = await psycopg.AsyncConnection.connect(os.environ['DATABASE_URL'], autocommit=True)
    try:
        await connection.execute('LISTEN bob_jobs_ready')
    except BaseException:
        await connection.close()
        raise
    return connection


async def stream_reader():
    """A stream owns one read connection instead of reconnecting for each fragment."""
    return await psycopg.AsyncConnection.connect(
        os.environ['DATABASE_URL'], autocommit=True, row_factory=dict_row)


async def read_stream_events(connection, job_id: str, after_id: int):
    cursor = await connection.execute(
        "SELECT id,event FROM bob_job_events WHERE job_id=%s AND id>%s ORDER BY id LIMIT 200",
        (job_id, after_id))
    rows = await cursor.fetchall()
    cursor = await connection.execute("SELECT status FROM bob_jobs WHERE id=%s", (job_id,))
    job = await cursor.fetchone()
    return rows, job['status'] if job else None


def create_approval(job_id: str, token: str, event: dict) -> None:
    with _connect() as db:
        if not db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE", (job_id, token)).fetchone():
            raise RuntimeError("Approval job is no longer running")
        db.execute("INSERT INTO bob_job_approvals(id,job_id,worker_token,event) VALUES (%s,%s,%s,%s::jsonb)",
                   (event['approval_id'], job_id, token, _dumps_jsonb(event)))


def approval_decision(job_id: str, token: str, approval_id: str) -> str | None:
    with _connect() as db:
        row = db.execute("""SELECT a.decision,a.event FROM bob_job_approvals a JOIN bob_jobs j ON j.id=a.job_id
            WHERE a.id=%s AND a.job_id=%s AND a.worker_token=%s AND j.worker_token=%s
            AND j.status='running' AND NOT COALESCE((j.payload->>'cancel_requested')::boolean,false)""",
            (approval_id, job_id, token, token)).fetchone()
    if not row:
        raise RuntimeError("Approval job was stopped")
    return 'approve_task' if row['decision'] == 'approve' and row['event'].get('scope') == 'task' else row['decision']


def assert_execution_active(job_id: str, token: str, username: str) -> None:
    """Last execution checkpoint after approval/UI delivery/configuration awaits."""
    with _connect() as db:
        if not db.execute("""SELECT id FROM bob_jobs WHERE id=%s AND worker_token=%s
            AND username=%s AND status='running'
            AND NOT COALESCE((payload->>'cancel_requested')::boolean,false)""",
            (job_id, token, username)).fetchone():
            raise PermissionError('Agent job was stopped or authorization changed')


def consume_execution_approval(job_id: str, token: str, approval_id: str, username: str, digest: str) -> str | None:
    """Check job/actor/action/expiry and consume once, under shared DB locks.

    Serialize with cancellation and policy/owner decisions. The approval row and
    execution audit are committed together, before the caller invokes a tool.
    """
    with _connect() as db:
        job = db.execute("""SELECT id FROM bob_jobs WHERE id=%s AND username=%s
            AND worker_token=%s AND status='running'
            AND NOT COALESCE((payload->>'cancel_requested')::boolean,false) FOR UPDATE""",
            (job_id, username, token)).fetchone()
        if not job:
            raise PermissionError('Approval job was stopped')
        row = db.execute("""SELECT decision,event,
            created_at > now() - interval '300 seconds' AS valid
            FROM bob_job_approvals WHERE id=%s AND job_id=%s AND worker_token=%s FOR UPDATE""",
            (approval_id, job_id, token)).fetchone()
        if not row:
            raise PermissionError('Approval does not exist')
        event = row['event']
        if (event.get('actor') != username or event.get('action_digest') != digest
                or event.get('consumed') or event.get('scope') != 'action'):
            raise PermissionError('Approval does not authorize this action')
        if not row['valid']:
            raise PermissionError('Approval expired')
        if row['decision'] is None:
            return None
        decision = row['decision']
        consumed = {**event, 'consumed': True}
        db.execute('UPDATE bob_job_approvals SET event=%s::jsonb WHERE id=%s',
                   (_dumps_jsonb(consumed), approval_id))
        audit = {'type': 'execution_authorization', 'approval_id': approval_id,
                 'actor': username, 'action_digest': digest,
                 'policy_version': event.get('policy_version'), 'decision': decision}
        db.execute('INSERT INTO bob_job_events(job_id,event) VALUES(%s,%s::jsonb)',
                   (job_id, _dumps_jsonb(audit)))
        return decision


def decide_approval(job_id: str, username: str, approval_id: str, decision: str) -> dict | None:
    if decision not in {'approve', 'approve_task', 'reject'}:
        raise ValueError('Invalid approval decision')
    stored_decision = 'approve' if decision == 'approve_task' else decision
    scope = 'task' if decision == 'approve_task' else 'action'
    with _connect() as db:
        row = db.execute("""SELECT a.*,j.status FROM bob_job_approvals a JOIN bob_jobs j ON j.id=a.job_id
            WHERE a.id=%s AND a.job_id=%s AND j.username=%s AND a.worker_token=j.worker_token
            AND NOT COALESCE((j.payload->>'cancel_requested')::boolean,false) FOR UPDATE OF a,j""",
            (approval_id, job_id, username)).fetchone()
        if not row:
            return None
        if row['status'] != 'running':
            raise ValueError("Job is no longer running")
        if row['event'].get('consumed'):
            raise ValueError('This approval has already been consumed')
        if decision == 'approve_task':
            raise ValueError('Approve this exact action once; task-wide approvals are disabled')
        if row['decision'] and (row['decision'] != stored_decision or row['event'].get('scope', 'action') != scope):
            raise ValueError("This action has already been decided")
        event = {**row['event'], 'scope': scope}
        db.execute("UPDATE bob_job_approvals SET decision=%s,event=%s::jsonb WHERE id=%s", (stored_decision, _dumps_jsonb(event), approval_id))
        return {**event, 'status': 'approved' if stored_decision == 'approve' else 'rejected'}


def get_approval_policy(job_id: str, username: str) -> dict | None:
    from app.approval_policy import policy_state
    job = get_job(job_id, username)
    return policy_state(job) if job else None


def worker_approval_policy(job_id: str, token: str) -> dict:
    with _connect() as db:
        job = db.execute("SELECT payload FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' AND NOT COALESCE((payload->>'cancel_requested')::boolean,false)", (job_id, token)).fetchone()
    if not job:
        raise RuntimeError('Approval job was stopped')
    return {'policy': job['payload'].get('approval_policy', {'mode': 'auto', 'actions': []}),
            'revision': job['payload'].get('approval_policy_revision', 0)}


def update_approval_policy(job_id: str, username: str, policy: dict) -> dict | None:
    """Serialize owner policy changes with permission decisions and task cancellation."""
    from app.approval_policy import ApprovalPolicy, policy_state, review_required
    policy = ApprovalPolicy.model_validate(policy).model_dump()
    ensure_schema()
    with _connect() as db:
        job = db.execute('SELECT * FROM bob_jobs WHERE id=%s AND username=%s FOR UPDATE', (job_id, username)).fetchone()
        if not job:
            return None
        state = policy_state(job)
        if not state['mutable']:
            raise ValueError(state['reason'])
        revision = state['revision'] + 1
        encoded_payload = _dumps_jsonb({'approval_policy': policy, 'approval_policy_revision': revision})
        db.execute('UPDATE bob_jobs SET payload=payload || %s::jsonb WHERE id=%s', (encoded_payload, job_id))
        result = {'policy': policy, 'revision': revision, 'mutable': True, 'reason': None}
        events = [{'type': 'approval_policy', **result}]
        pending = db.execute('SELECT id,event FROM bob_job_approvals WHERE job_id=%s AND decision IS NULL FOR UPDATE', (job_id,)).fetchall()
        for row in pending:
            event = row['event']
            if not event.get('mandatory') and not review_required(policy, event.get('tool', {})):
                resolved = {**event, 'scope': 'action', 'policy_revision': revision, 'status': 'approved', 'automatic': True}
                db.execute("UPDATE bob_job_approvals SET decision='approve',event=%s::jsonb WHERE id=%s", (_dumps_jsonb(resolved), row['id']))
                events.append(resolved)
        for event in events:
            encoded = _dumps_jsonb(event)
            db.execute('INSERT INTO bob_job_events(job_id,event) VALUES(%s,%s::jsonb)', (job_id, encoded))
            db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES(%s,%s,%s::jsonb)', (username, job['workspace_id'], encoded))
            db.execute("SELECT pg_notify(%s,%s)", ('bob_job_' + str(job_id).replace('-', ''), encoded))
        db.execute("SELECT pg_notify('bob_job_events',%s)", (str(job_id),))
        return result


def auto_resolve_approval(job_id: str, token: str, approval_id: str) -> str | None:
    """Close the policy-update/create-permission race under the same job lock."""
    from app.approval_policy import review_required
    with _connect() as db:
        job = db.execute("SELECT payload FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' AND NOT COALESCE((payload->>'cancel_requested')::boolean,false) FOR UPDATE", (job_id, token)).fetchone()
        if not job:
            raise RuntimeError('Approval job was stopped')
        row = db.execute('SELECT decision,event FROM bob_job_approvals WHERE id=%s AND job_id=%s AND worker_token=%s FOR UPDATE', (approval_id, job_id, token)).fetchone()
        if not row or row['decision']:
            return row['decision'] if row else None
        if row['event'].get('mandatory') or review_required(job['payload'].get('approval_policy', {}), row['event'].get('tool', {})):
            return None
        event = {**row['event'], 'scope': 'action', 'policy_revision': job['payload'].get('approval_policy_revision', 0), 'automatic': True}
        db.execute("UPDATE bob_job_approvals SET decision='approve',event=%s::jsonb WHERE id=%s", (_dumps_jsonb(event), approval_id))
        return 'approve'


def interrupt_approval(job_id: str, token: str, approval_id: str) -> None:
    with _connect() as db:
        if not db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' FOR UPDATE", (job_id, token)).fetchone():
            raise RuntimeError('Approval job was stopped')
        db.execute("UPDATE bob_job_approvals SET decision='reject' WHERE id=%s AND job_id=%s AND worker_token=%s AND decision IS NULL", (approval_id, job_id, token))
