"""Verify one conversation is erased without touching a sibling."""
import os
import sqlite3
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

from app import job_queue
from app.conversation_delete import delete_conversation
from app.sessions import create_session, read_history, user_root


def main():
    username = "deletecheck"
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BOB_WORKSPACE": directory, "BOB_S3_BUCKET": ""}):
        first = create_session(username)["id"]
        second = create_session(username)["id"]
        root = user_root(username)
        first_dir = root / "sessions" / first
        second_dir = root / "sessions" / second
        (first_dir / "deck.html").write_text("secret deck")
        (second_dir / "keep.html").write_text("keep")
        logs = root / ".home" / ".bob" / "logs" / "shell"
        logs.mkdir(parents=True)
        deleted_log = logs / "bob-shell-first.log"
        kept_log = logs / "bob-shell-second.log"
        deleted_log.write_text(str(first_dir))
        kept_log.write_text(str(second_dir))
        task_id = "test-task-" + uuid.uuid4().hex
        failed_task_id = "test-failed-" + uuid.uuid4().hex
        sibling_task_id = "test-sibling-" + uuid.uuid4().hex
        (first_dir / ".history.jsonl").write_text('{"type":"done","session_id":"' + task_id + '"}\n')
        db_path = root / ".home" / ".bob" / "db" / "bob.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(db_path) as db:
            db.executescript("""CREATE TABLE tasks (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,first_message TEXT);
                CREATE TABLE messages (id TEXT,task_id TEXT);
                CREATE TABLE task_pending_approvals (task_id TEXT);
                CREATE TABLE attribution_logs (task_id TEXT);""")
            db.execute("INSERT INTO tasks VALUES (?,?,?,?)", (task_id, None, str(first_dir), "first prompt"))
            db.execute("INSERT INTO tasks VALUES (?,?,?,?)", (failed_task_id, None, "", "failed prompt"))
            db.execute("INSERT INTO tasks VALUES (?,?,?,?)", (sibling_task_id, None, "", "sibling prompt"))
            db.execute("INSERT INTO messages VALUES (?,?)", ("message-1", task_id))
            db.execute("INSERT INTO messages VALUES (?,?)", ("message-2", failed_task_id))
            db.execute("INSERT INTO messages VALUES (?,?)", ("message-3", sibling_task_id))

        job_id = str(uuid.uuid4())
        job_queue.ensure_schema()
        with job_queue._connect() as db:
            db.execute("""INSERT INTO bob_jobs (id,username,workspace_id,workspace_key,payload,status)
                VALUES (%s,%s,%s,%s,'{}'::jsonb,'completed')""", (job_id, username, first, str(first_dir)))
            db.execute("INSERT INTO bob_job_events (job_id,event) VALUES (%s,%s::jsonb)",
                       (job_id, '{"type":"done","session_id":"' + task_id + '"}'))
            db.execute("""INSERT INTO bob_jobs (id,username,workspace_id,workspace_key,payload,status)
                VALUES (%s,%s,%s,%s,%s::jsonb,'failed')""",
                (str(uuid.uuid4()), username, first, str(first_dir), '{"bob_prompt":"failed prompt"}'))
            db.execute("""INSERT INTO bob_jobs (id,username,workspace_id,workspace_key,payload,status)
                VALUES (%s,%s,%s,%s,%s::jsonb,'completed')""",
                (str(uuid.uuid4()), username, second, str(second_dir), '{"bob_prompt":"sibling prompt"}'))
        try:
            result = delete_conversation(username, first)
            assert result["bob_tasks"] == 2
            assert not first_dir.exists()
            assert (second_dir / "keep.html").read_text() == "keep"
            assert not deleted_log.exists() and kept_log.exists()
            assert job_queue.get_job(job_id) is None
            assert job_queue.deletion_status(username, first) == "deleted"
            with sqlite3.connect(db_path) as db:
                assert db.execute("SELECT id FROM tasks").fetchall() == [(sibling_task_id,)]
                assert db.execute("SELECT task_id FROM messages").fetchall() == [(sibling_task_id,)]
            assert delete_conversation(username, first) == {"objects": 0, "bob_tasks": 0}
        finally:
            with job_queue._connect() as db:
                db.execute("DELETE FROM bob_deleted_conversations WHERE username=%s", (username,))
    print("conversation deletion passed")


if __name__ == "__main__":
    main()
