"""Delete one conversation from live app stores, with a retryable tombstone."""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path
from fastapi import HTTPException

from app import job_queue, postgres_storage as storage, rag
from app.sessions import _VALID_ID, read_history, get_session


def _history_task_ids(path: Path) -> set[str]:
    ids: set[str] = set()
    if not path.is_file():
        return ids
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
            if event.get("type") in {"done", "error"} and isinstance(event.get("session_id"), str):
                ids.add(event["session_id"])
        except (ValueError, TypeError):
            continue
    return ids


def _delete_bob_tasks(database: Path, task_ids: set[str], directory: Path | None,
                      unique_prompts: set[str] | None = None) -> int:
    if not database.is_file():
        return 0
    with sqlite3.connect(database, timeout=15) as db:
        db.execute("PRAGMA secure_delete=ON")
        db.execute("BEGIN IMMEDIATE")
        if directory is not None:
            task_ids.update(row[0] for row in db.execute("SELECT id FROM tasks WHERE directory=?", (str(directory),)))
        if unique_prompts and any(row[1] == "first_message" for row in db.execute("PRAGMA table_info(tasks)")):
            for prompt in unique_prompts:
                task_ids.update(row[0] for row in db.execute("SELECT id FROM tasks WHERE first_message=?", (prompt,)))
        if not task_ids:
            return 0
        rows = db.execute("""WITH RECURSIVE descendants(id) AS (
            SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?))
            UNION SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id=d.id
        ) SELECT id FROM descendants""", (json.dumps(list(task_ids)),)).fetchall()
        all_ids = [row[0] for row in rows]
        if not all_ids:
            return 0
        ids_json = json.dumps(all_ids)
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in tables:
            if table == "tasks":
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            if any(column[1] == "task_id" for column in db.execute(f"PRAGMA table_info({quoted})")):
                db.execute(f"DELETE FROM {quoted} WHERE task_id IN (SELECT value FROM json_each(?))", (ids_json,))
        db.execute("DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))", (ids_json,))
        db.commit()
        db.execute("VACUUM")
        return len(all_ids)


def _delete_bob_shell_logs(log_directory: Path, conversation_directory: Path | None) -> int:
    """Remove logs that explicitly identify this conversation's private workspace."""
    if conversation_directory is None or not log_directory.is_dir():
        return 0
    marker = str(conversation_directory).encode()
    deleted = 0
    for path in log_directory.glob("bob-shell-*.log"):
        if path.is_file() and marker in path.read_bytes():
            path.unlink()
            deleted += 1
    return deleted


def _delete_scope_records(db, username, session_id):
    history=db.execute('SELECT event FROM bob_conversation_history WHERE username=%s AND session_id=%s',
                       (username,session_id)).fetchall()
    task_ids={r['event']['session_id'] for r in history if r['event'].get('session_id') and r['event'].get('type') in {'done','error'}}
    # Migrated Bob databases may be in the user scope; new task databases belong to one chat.
    tasks=0
    with storage.temporary_tree(username,'user') as root:
        database=root/'.home'/'.bob'/'db'/'bob.db'
        if database.is_file():
            tasks=_delete_bob_tasks(database,task_ids,None,job_queue.session_unique_bob_prompts(username,session_id))
            storage._upsert(db,username,'user','.home/.bob/db/bob.db',database.read_bytes())
            db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND path IN ('.home/.bob/db/bob.db-wal','.home/.bob/db/bob.db-shm')",(username,))
        for path in (root/'.home'/'.bob'/'logs').rglob('*'):
            if path.is_file() and ('/sessions/'+session_id).encode() in path.read_bytes():
                db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND path=%s",(username,path.relative_to(root).as_posix()))
    objects=storage.delete_scope(username,'session:'+session_id,db)
    objects+=storage.delete_scope(username,'home:'+session_id,db)
    from app.interactive_widgets import ensure_schema as ensure_widget_schema
    ensure_widget_schema(db)
    db.execute('DELETE FROM bob_interactive_widgets WHERE username=%s AND session_id=%s', (username, session_id))
    db.execute('DELETE FROM bob_conversation_history WHERE username=%s AND session_id=%s',(username,session_id))
    db.execute('DELETE FROM bob_conversations WHERE username=%s AND id=%s',(username,session_id))
    db.execute('DELETE FROM bob_jobs WHERE username=%s AND workspace_id=%s',(username,session_id))
    # Shared knowledge sources remain until explicitly removed from the library.
    db.execute("""INSERT INTO bob_deleted_conversations(username,workspace_id,status)
        VALUES (%s,%s,'deleted') ON CONFLICT(username,workspace_id) DO UPDATE SET status='deleted',updated_at=now()""",(username,session_id))
    return {'objects':objects,'bob_tasks':tasks}


def delete_conversation(username: str, session_id: str):
    if not _VALID_ID.fullmatch(session_id): raise ValueError('Invalid conversation ID')
    storage.ensure_schema()
    rag.ensure_schema()
    prior=job_queue.deletion_record(username,session_id)
    if prior and prior['status']=='deleted': return {'objects':0,'bob_tasks':0}
    record=get_session(session_id,username)
    scope='project:'+record['project_id'] if record.get('project_id') else 'session:'+session_id
    with storage.mutation(username,scope,session_id,user_lock=True) as db:
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',(f'conversation:{username}:{session_id}',))
        storage._lock(db,username,'user')
        return _delete_scope_records(db,username,session_id)


def delete_project(username,project_id):
    from app.projects import project_root
    project_root(username,project_id)
    storage.ensure_schema()
    rag.ensure_schema()
    with storage.mutation(username,'project:'+project_id,user_lock=True) as db:
        storage._lock(db,username,'user')
        conversations=db.execute("SELECT id FROM bob_conversations WHERE username=%s AND record->>'project_id'=%s",(username,project_id)).fetchall()
        for row in conversations:
            db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',(f"conversation:{username}:{row['id']}",))
            _delete_scope_records(db,username,row['id'])
        files=storage.delete_scope(username,'project:'+project_id,db)
        db.execute('DELETE FROM projects WHERE username=%s AND id=%s',(username,project_id))
        return {'files':files,'conversations':len(conversations)}
