"""PostgreSQL is the durable filesystem; local trees exist only during tool runs."""
from __future__ import annotations
from app.branding import brand_text
from threading import Lock
from concurrent.futures import ThreadPoolExecutor, wait, as_completed, FIRST_COMPLETED

import hashlib
import json
import os
import shutil
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path, PurePosixPath

from app import job_queue, blob_storage
from app.private_directories import private_directory, scratch_directory

_user_baseline: ContextVar[dict | None] = ContextVar('bob_user_baseline', default=None)
_runtime: ContextVar[Path | None] = ContextVar('bob_runtime', default=None)
MAX_FILE_BYTES = 200 * 1024 * 1024
RESERVED = {'.bob', '.home', '.git', '.conversation.json', '.history.jsonl', '.deleting', '.s3-backed'}


def ensure_schema():
    with _schema_lock:
        if os.environ["DATABASE_URL"] in _schema_urls: return
        _create_schema()
        _schema_urls.add(os.environ["DATABASE_URL"])


_schema_urls: set[str] = set()
_schema_lock = Lock()


def _create_schema():
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtext('bob_storage_schema'))")
        db.execute('''CREATE TABLE IF NOT EXISTS bob_storage_files (
            username TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL,
            content BYTEA NOT NULL, sha256 TEXT NOT NULL, mode INTEGER NOT NULL DEFAULT 384,
            modified BIGINT NOT NULL, PRIMARY KEY(username,scope,path))''')
        db.execute('''CREATE TABLE IF NOT EXISTS bob_conversations (
            username TEXT NOT NULL, id TEXT NOT NULL, record JSONB NOT NULL,
            PRIMARY KEY(username,id))''')
        db.execute('''CREATE TABLE IF NOT EXISTS bob_conversation_history (
            id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, session_id TEXT NOT NULL,
            event JSONB NOT NULL)''')
        blob_storage.schema(db, 'bob_storage_files')
        db.execute("ALTER TABLE bob_storage_files ADD COLUMN IF NOT EXISTS search_text TEXT")
        db.execute('CREATE TABLE IF NOT EXISTS bob_storage_users(username TEXT PRIMARY KEY)')
        db.execute('''CREATE TABLE IF NOT EXISTS bob_deleted_skills (
            username TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL,
            PRIMARY KEY(username,folder))''')
        db.execute('CREATE TABLE IF NOT EXISTS bob_skill_aliases(username TEXT NOT NULL, alias TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(username,alias))')
        db.execute('CREATE INDEX IF NOT EXISTS bob_history_scope ON bob_conversation_history(username,session_id,id)')
        db.execute('''CREATE INDEX IF NOT EXISTS bob_history_requests
            ON bob_conversation_history(username,session_id,id)
            WHERE (event->>'type') = 'request' ''')
        db.execute("CREATE INDEX IF NOT EXISTS bob_conversations_user_project ON bob_conversations(username, (record->>'project_id'))")


def runtime_root():
    if _runtime.get() is not None:
        return _runtime.get()
    configured = os.getenv('BOB_RUNTIME_ROOT')
    return private_directory(configured) if configured else scratch_directory('runtime')


def validate_path(path: str, *, internal=False):
    p = PurePosixPath(path)
    if (not path or p.is_absolute() or '..' in p.parts or '\\' in path or '\x00' in path
        or p.as_posix() != path or (not internal and any(part in RESERVED for part in p.parts))):
        raise ValueError('Invalid file path')
    return path


def _lock(db, username, scope):
    db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'storage:{username}:{scope}',))


def _upsert(db, username, scope, path, content, mode=0o600, modified=None):
    import time
    validate_path(path, internal=True)
    if len(content) > MAX_FILE_BYTES:
        raise ValueError('File exceeds the 200 MB storage limit')
    parts = PurePosixPath(path).parts
    if len(parts) >= 3 and parts[:2] == ('.bob', 'skills'):
        if db.execute('SELECT 1 FROM bob_deleted_skills WHERE username=%s AND folder=%s',
                      (username, parts[2])).fetchone():
            return
    digest = hashlib.sha256(content).hexdigest()
    prior = db.execute('SELECT sha256,mode FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s',
                       (username,scope,path)).fetchone()
    if prior and prior['sha256'] == digest:
        if prior['mode'] != mode:
            db.execute('UPDATE bob_storage_files SET mode=%s,modified=%s WHERE username=%s AND scope=%s AND path=%s',
                       (mode,modified or time.time_ns(),username,scope,path))
        return
    blob = blob_storage.store(content, namespace=f'{username}:{scope}', db=db)
    from app.search_text import searchable_text
    db.execute('''INSERT INTO bob_storage_files(username,scope,path,content,sha256,mode,modified,object_key,object_bucket,size,search_text)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(username,scope,path) DO UPDATE
        SET content=excluded.content,sha256=excluded.sha256,mode=excluded.mode,modified=excluded.modified,
            object_key=excluded.object_key,object_bucket=excluded.object_bucket,size=excluded.size,search_text=excluded.search_text''',
        (username,scope,path,blob['content'],digest,mode,modified or time.time_ns(),blob['object_key'],blob['object_bucket'],blob['size'],searchable_text(path, content)))



def get_file(username, scope, path, *, internal=False):
    validate_path(path, internal=internal)
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('SELECT content,mode,modified,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s',
                         (username,scope,path)).fetchone()
    if row:
        row['content'] = blob_storage.read(row)
    return row


def list_files(username, scope, *, internal=False):
    ensure_schema()
    with job_queue._connect() as db:
        rows = db.execute('SELECT path,COALESCE(size,octet_length(content)) AS size,modified FROM bob_storage_files WHERE username=%s AND scope=%s ORDER BY path',
                          (username,scope)).fetchall()
    return rows if internal else [r for r in rows if not any(p.startswith('.') or p in RESERVED for p in PurePosixPath(r['path']).parts)]


@contextmanager
def mutation(username, scope, session_id=None, *, user_lock=False):
    """Serialize editing with enqueue and refuse mutations during a job/deletion."""
    ensure_schema()
    with job_queue._connect() as db:
        if user_lock:
            _lock(db, username, 'user')
        _lock(db, username, scope)
        if session_id and db.execute('SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s',
                                     (username,session_id)).fetchone():
            raise ValueError('Conversation is being deleted')
        if scope.startswith('project:') and not db.execute('SELECT 1 FROM projects WHERE username=%s AND id=%s',
                                                          (username,scope.split(':',1)[1])).fetchone():
            raise FileNotFoundError('Project not found')
        if db.execute("SELECT 1 FROM bob_jobs WHERE workspace_key=%s AND status IN ('queued','running')", (f'{username}:{scope}',)).fetchone():
            raise ValueError(brand_text('Buddy is active in this conversation or project'))
        yield db


def put_file(username, scope, path, content, *, session_id=None, internal=False):
    validate_path(path, internal=internal)
    with mutation(username,scope,session_id) as db:
        _upsert(db,username,scope,path,content)


def delete_file(username, scope, path, *, session_id=None, internal=False):
    validate_path(path, internal=internal)
    with mutation(username,scope,session_id) as db:
        return bool(db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s RETURNING path',
                               (username,scope,path)).fetchone())


def delete_scope(username, scope, db=None):
    if db is None:
        ensure_schema()
        with job_queue._connect() as connection:
            return delete_scope(username,scope,connection)
    if scope.startswith(('session:', 'project:')) and db.execute("SELECT to_regclass('bob_conversation_documents') AS name").fetchone()['name']:
        db.execute('DELETE FROM bob_conversation_documents WHERE username=%s AND scope=%s', (username, scope))
    return db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s', (username,scope)).rowcount


def _restore_file(row, root):
    validate_path(row['path'], internal=True)
    content = blob_storage.read(row)
    target = root / row['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    target.chmod(row['mode'] & 0o777)
    os.utime(target, ns=(row['modified'], row['modified']))


def restore_tree(username, scope, root):
    """Restore verified files with bounded concurrent cloud reads; keep no cache."""
    root.mkdir(parents=True, exist_ok=True)
    ensure_schema()
    workers = max(1, min(16, int(os.getenv('BOB_STORAGE_DOWNLOAD_WORKERS', '8'))))
    with job_queue._connect() as db:
        with db.cursor() as cursor:
            cursor.execute('SELECT path,content,mode,modified,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s', (username,scope))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                in_flight = set()
                max_in_flight = workers * 2
                while rows := cursor.fetchmany(workers):
                    for row in rows:
                        # Legacy conversation snapshots can contain runtime-owned
                        # .bob files. Restore user settings from the user scope;
                        # workspace metadata must not shadow its shared link.
                        if scope.startswith(('session:', 'project:')) and PurePosixPath(row['path']).parts[0] in RESERVED:
                            continue
                        while len(in_flight) >= max_in_flight:
                            done, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
                            for fut in done:
                                fut.result()
                        in_flight.add(pool.submit(_restore_file, row, root))
                for fut in as_completed(in_flight):
                    fut.result()


def save_tree(username, scope, root, *, db=None, merge=False):
    """Commit a complete tree atomically, including removal of deleted files."""
    if db is None:
        ensure_schema()
        with job_queue._connect() as connection:
            _lock(connection,username,scope)
            return save_tree(username,scope,root,db=connection,merge=merge)
    paths=[]
    for folder, dirs, files in os.walk(root, followlinks=False):
        for d in dirs:
            link=Path(folder)/d
            if link.is_symlink() and d != '.bob':
                raise ValueError('Workspace symbolic links cannot be persisted')
        dirs[:] = [d for d in dirs if not (Path(folder)/d).is_symlink()]
        for name in files:
            path=Path(folder)/name
            if path.is_symlink():
                if name == '.bob': continue
                raise ValueError('Workspace symbolic links cannot be persisted')
            relative=path.relative_to(root).as_posix()
            if scope.startswith('home:') and (relative in {'.bob/mcp_settings.json', '.bob/mcp.json', '.bob/settings/mcp.json'} or relative.startswith('.bob/tokens/')):
                continue
            if scope != 'user' and not scope.startswith('home:') and relative.split('/')[0] in {'.bob','.home','.conversation.json','.history.jsonl','.deleting','.s3-backed'}:
                continue
            if not path.is_file():
                raise ValueError('Workspace contains a non-regular file')
            if path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError(f'File exceeds 200 MB: {relative}')
            _upsert(db,username,scope,relative,path.read_bytes(),path.stat().st_mode & 0o777,path.stat().st_mtime_ns)
            paths.append(relative)
    if not merge:
        # Revision history is server-owned metadata, excluded from workspace
        # trees above. Retain it when committing a new generated file tree.
        if scope != 'user' and not scope.startswith('home:'):
            db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND NOT(path=ANY(%s::text[])) AND path NOT LIKE %s',
                       (username,scope,paths,'.bob/artifacts/%'))
        else:
            db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND NOT(path=ANY(%s::text[]))', (username,scope,paths))
    return len(paths)


@contextmanager
def temporary_tree(username, scope):
    with tempfile.TemporaryDirectory(prefix='bob-tree-') as directory:
        root=Path(directory)
        restore_tree(username,scope,root)
        yield root


def cleanup_abandoned_workspaces():
    """Remove only our scratch directories whose owning process no longer exists."""
    for directory in Path(tempfile.gettempdir()).glob('bob-job-*'):
        marker=directory/'.bob-storage-process'
        if directory.is_symlink() or not marker.is_file(): continue
        try:
            pid=int(marker.read_text())
            if pid<=0: continue
            os.kill(pid,0)
        except ProcessLookupError:
            shutil.rmtree(directory)
        except (OSError,ValueError):
            continue


@contextmanager
def job_workspace(username, session_id):
    """Each attempt owns its scratch tree; a stale worker cannot delete another's."""
    from app.sessions import user_root, workspace_for, storage_scope
    cleanup_abandoned_workspaces()
    with tempfile.TemporaryDirectory(prefix='bob-job-') as directory:
        (Path(directory)/'.bob-storage-process').write_text(str(os.getpid()))
        token=_runtime.set(Path(directory))
        try:
            user=user_root(username,create=True)
            migrate_skill_names(username)
            restore_tree(username,'user',user)
            baseline={p.relative_to(user).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (user/'.bob').rglob('*') if p.is_file() and not p.is_symlink()}
            baseline_token=_user_baseline.set(baseline)
            home_rows=list_files(username,'home:'+session_id,internal=True)
            if home_rows:
                shutil.rmtree(user/'.home'/'.bob'/'db',ignore_errors=True)
                shutil.rmtree(user/'.home'/'.bob'/'logs',ignore_errors=True)
                restore_tree(username,'home:'+session_id,user/'.home')
            else:
                partition_home(username,session_id,user/'.home')
            (user/'.home'/'.bob').mkdir(parents=True,exist_ok=True)
            from app.branding import refresh_identity_settings
            refresh_identity_settings(user)
            workspace=workspace_for(session_id,username)
            restore_tree(username,storage_scope(session_id,username),workspace)
            (workspace/'.bob').symlink_to(user/'.bob',target_is_directory=True)
            from app.sessions import _root
            agents_md = _root() / 'AGENTS.md'
            if agents_md.is_file():
                (workspace / 'AGENTS.md').write_text(brand_text(agents_md.read_text()))
            yield user,workspace
        finally:
            if 'baseline_token' in locals(): _user_baseline.reset(baseline_token)
            _runtime.reset(token)


def persist_job(job, user, workspace):
    from app.sessions import storage_scope
    username=job['username']
    scope=storage_scope(job['workspace_id'],username)
    with job_queue._connect() as db:
        _lock(db,username,scope)
        row=db.execute("SELECT 1 FROM bob_jobs WHERE id=%s AND worker_token=%s AND status='running' AND lease_until>now() FOR UPDATE",
                       (job['id'],job['worker_token'])).fetchone()
        if not row:
            raise RuntimeError('Worker lost its lease before files could be saved')
        save_tree(username,scope,workspace,db=db)
        from app.artifacts import capture_generated_revisions
        capture_generated_revisions(username, job['workspace_id'], scope, db)
        save_tree(username,'home:'+job['workspace_id'],user/'.home',db=db)
        baseline=_user_baseline.get() or {}
        for path in (user/'.bob').rglob('*'):
            if not path.is_file() or path.is_symlink(): continue
            relative=path.relative_to(user).as_posix()
            content=path.read_bytes()
            if hashlib.sha256(content).hexdigest()==baseline.get(relative): continue
            prior=db.execute("SELECT sha256 FROM bob_storage_files WHERE username=%s AND scope='user' AND path=%s",(username,relative)).fetchone()
            if (prior['sha256'] if prior else None)==baseline.get(relative):
                _upsert(db,username,'user',relative,content)



def user_file_identity(path):
    """Recognize descriptors under the runtime user directory, including MCP HOME."""
    parts=path.parts
    try:
        index=parts.index('users')
    except ValueError:
        return None
    if index+2 >= len(parts): return None
    username=parts[index+1]
    from app.sessions import _VALID_USER
    if not _VALID_USER.fullmatch(username): return None
    return username,Path(*parts[index+2:]).as_posix()


def read_user_file(path):
    identity=user_file_identity(path)
    if identity:
        row=get_file(identity[0],'user',identity[1],internal=True)
        return row['content'] if row else None
    return path.read_bytes() if path.is_file() else None


def write_user_file(path,content,*,exclusive=False, recreate_skill=False):
    identity=user_file_identity(path)
    if identity:
        ensure_schema()
        with job_queue._connect() as db:
            _lock(db,identity[0],'user')
            if recreate_skill:
                # Recreating an alias under its own name restores its selection,
                # while the old default folder stays tombstoned to prevent duplicates.
                db.execute("UPDATE bob_deleted_skills SET name='' WHERE username=%s AND name=%s",
                           (identity[0], PurePosixPath(identity[1]).parts[2]))
                db.execute('DELETE FROM bob_deleted_skills WHERE username=%s AND folder=%s',
                           (identity[0], PurePosixPath(identity[1]).parts[2]))
            if exclusive and db.execute('SELECT 1 FROM bob_storage_files WHERE username=%s AND scope=\'user\' AND path=%s',identity).fetchone():
                raise FileExistsError('File already exists')
            _upsert(db,identity[0],'user',identity[1],content)
    else:
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb' if exclusive else 'wb') as file: file.write(content)


def remove_user_file(path):
    identity=user_file_identity(path)
    if identity:
        delete_file(identity[0],'user',identity[1],internal=True)
    else:
        path.unlink(missing_ok=True)


def seed_user(username):
    """Copy shipped defaults once, without recreating removed user settings."""
    from app.sessions import _root
    ensure_schema()
    with job_queue._connect() as db:
        if db.execute('SELECT 1 FROM bob_storage_users WHERE username=%s',(username,)).fetchone(): return
    # Migration takes the user lock on its own connection. Finish it before
    # acquiring that same lock for seeding, or both connections wait forever.
    migrate_skill_names(username, force=True)
    with job_queue._connect() as db:
        _lock(db,username,'user')
        if db.execute('SELECT 1 FROM bob_storage_users WHERE username=%s',(username,)).fetchone(): return
        for path in (_root()/'.bob').rglob('*'):
            if path.is_file() and not path.is_symlink():
                relative='.bob/'+path.relative_to(_root()/'.bob').as_posix()
                if not db.execute("SELECT 1 FROM bob_storage_files WHERE username=%s AND scope='user' AND path=%s",(username,relative)).fetchone():
                    _upsert(db,username,'user',relative,path.read_bytes())
        db.execute('INSERT INTO bob_storage_users VALUES (%s)',(username,))


def partition_home(username,session_id,home):
    """A legacy shared Buddy database is copied with only this conversation's tasks."""
    import sqlite3
    from app.sessions import read_history
    from app.conversation_delete import _delete_bob_tasks
    database=home/'.bob'/'db'/'bob.db'
    if not database.is_file(): return
    ids={e['session_id'] for e in read_history(session_id,username) if e.get('type') in {'done','error'} and e.get('session_id')}
    ids.update(job_queue.session_done_task_ids(username,session_id))
    prompts=job_queue.session_unique_bob_prompts(username,session_id)
    with sqlite3.connect(database) as db:
        columns={r[1] for r in db.execute('PRAGMA table_info(tasks)')}
        if 'id' not in columns: return
        if 'directory' in columns:
            ids.update(r[0] for r in db.execute('SELECT id FROM tasks WHERE directory LIKE ?',('%/sessions/'+session_id,)))
        if 'first_message' in columns:
            for prompt in prompts: ids.update(r[0] for r in db.execute('SELECT id FROM tasks WHERE first_message=?',(prompt,)))
        if ids:
            ids.update(r[0] for r in db.execute("WITH RECURSIVE children(id) AS (SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT t.id FROM tasks t JOIN children c ON t.parent_id=c.id) SELECT id FROM children", (json.dumps(list(ids)),)))
            # Retain ancestors required to resume any selected child task.
            ids.update(r[0] for r in db.execute("WITH RECURSIVE parents(id,parent_id) AS (SELECT id,parent_id FROM tasks WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT t.id,t.parent_id FROM tasks t JOIN parents p ON t.id=p.parent_id) SELECT id FROM parents", (json.dumps(list(ids)),)))
        others={r[0] for r in db.execute('SELECT id FROM tasks')}-ids
    _delete_bob_tasks(database,others,None)
    for path in (home/'.bob'/'logs').rglob('*'):
        if path.is_file() and ('/sessions/'+session_id).encode() not in path.read_bytes(): path.unlink()


@contextmanager
def direct_workspace(username):
    """Temporary workspace for the synchronous legacy /ask and A2A endpoints."""
    with mutation(username,'session:legacy','legacy') as db:
        with job_workspace(username,'legacy') as (user,workspace):
            yield user,workspace
            save_tree(username,'session:legacy',workspace,db=db)
            save_tree(username,'home:legacy',user/'.home',db=db)


def deleted_skill_folders(username):
    ensure_schema()
    with job_queue._connect() as db:
        return {r['folder'] for r in db.execute(
            'SELECT folder FROM bob_deleted_skills WHERE username=%s', (username,)).fetchall()}


class SkillDeletionBusy(ValueError):
    pass


def delete_skill_tree(path, name):
    """Delete skill-owned files and clear saved selections; retain default tombstones."""
    identity = user_file_identity(path / 'SKILL.md')
    if not identity:
        shutil.rmtree(path)
        return
    username = identity[0]
    ensure_schema()
    from app.personalization import ensure_schema as ensure_personalization
    ensure_personalization()
    with job_queue._connect() as db:
        _lock(db, username, 'user')
        if db.execute("SELECT 1 FROM bob_jobs WHERE username=%s AND status IN ('queued','running')", (username,)).fetchone():
            raise SkillDeletionBusy('Wait for your active tasks to finish before deleting a skill')
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('personalization:' + username,))
        db.execute('INSERT INTO bob_deleted_skills VALUES (%s,%s,%s) ON CONFLICT(username,folder) DO UPDATE SET name=excluded.name',
                   (username, path.name, name))
        from app.skill_names import BUILTIN_SKILL_NAMES
        legacy_names = {alias for alias, target in BUILTIN_SKILL_NAMES.items() if target == name}
        folders = {path.name} | legacy_names | {row['alias'] for row in db.execute('SELECT alias FROM bob_skill_aliases WHERE username=%s AND name=%s', (username,name)).fetchall()}
        for folder in folders:
            db.execute('INSERT INTO bob_deleted_skills VALUES (%s,%s,%s) ON CONFLICT(username,folder) DO UPDATE SET name=excluded.name', (username,folder,name))
            prefix = '.bob/skills/' + folder + '/'
            db.execute("DELETE FROM bob_storage_files WHERE username=%s AND starts_with(path,%s)", (username, prefix))
        references = sorted(folders | {name})
        db.execute("UPDATE bob_personalization SET record=record || '{\"skill_name\":null}'::jsonb WHERE username=%s AND kind='presets' AND record->>'skill_name'=ANY(%s)", (username,references))
        # Keep user-authored workflow prompts, but stop their schedules rather
        # than silently running them without the selected skill.
        if db.execute("SELECT to_regclass('bob_workflows') AS name").fetchone()['name']:
            db.execute("""UPDATE bob_workflows SET spec=spec || '{"skill_name":null}'::jsonb,
                          enabled=false,next_run=NULL,last_error='Selected skill was deleted'
                          WHERE username=%s AND spec->>'skill_name'=ANY(%s)""", (username,references))
        if name == 'research-buddy':
            db.execute("UPDATE bob_personalization SET record=record || '{\"web_search\":false}'::jsonb WHERE username=%s AND kind='presets' AND record->>'web_search'='true'", (username,))
    # Request roots are temporary; never remove the shared shipped directory.
    if path.is_dir():
        shutil.rmtree(path)


_SKILL_MIGRATION_CHECKED: dict[str, float] = {}


def migrate_skill_names(username, force=False):
    """Rename durable account skill trees and references in one locked transaction."""
    import time
    now = time.monotonic()
    if not force and (now - _SKILL_MIGRATION_CHECKED.get(username, 0)) < 60.0:
        return
    _SKILL_MIGRATION_CHECKED[username] = now
    from app.skill_names import canonical_skill_name, migration_plan, rename_descriptor
    from app.personalization import ensure_schema as ensure_personalization
    ensure_schema()
    ensure_personalization()
    with job_queue._connect() as db:
        _lock(db, username, 'user')
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('personalization:' + username,))
        rows = db.execute("SELECT * FROM bob_storage_files WHERE username=%s AND scope='user' AND starts_with(path,'.bob/skills/')", (username,)).fetchall()
        descriptors = {PurePosixPath(r['path']).parts[2]: blob_storage.read(r) for r in rows
                       if len(PurePosixPath(r['path']).parts) == 4 and r['path'].endswith('/SKILL.md')}
        plan = migration_plan(descriptors)
        for folder, (old_name, target) in plan.items():
            if folder == target and old_name == target:
                continue
            for alias in {folder, old_name}:
                if alias != target:
                    db.execute('INSERT INTO bob_skill_aliases VALUES (%s,%s,%s) ON CONFLICT(username,alias) DO NOTHING', (username,alias,target))
            for row in rows:
                parts = PurePosixPath(row['path']).parts
                if parts[2] != folder:
                    continue
                new_path = '.bob/skills/' + target + '/' + '/'.join(parts[3:])
                content = blob_storage.read(row)
                if len(parts) == 4 and parts[3] == 'SKILL.md':
                    content = rename_descriptor(content, target)
                _upsert(db, username, 'user', new_path, content, row['mode'])
                if new_path != row['path']:
                    db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND path=%s", (username,row['path']))
            if old_name != target:
                db.execute("UPDATE bob_personalization SET record=jsonb_set(record,'{skill_name}',to_jsonb(%s::text)) WHERE username=%s AND kind='presets' AND record->>'skill_name'=%s", (target,username,old_name))
        tombstones = db.execute('SELECT folder,name FROM bob_deleted_skills WHERE username=%s', (username,)).fetchall()
        for row in tombstones:
            if not row['name']:
                continue
            target = canonical_skill_name(row['name'] or row['folder'])
            # Retain old folder tombstones too, protecting stale running runtimes.
            db.execute('UPDATE bob_deleted_skills SET name=%s WHERE username=%s AND folder=%s', (target,username,row['folder']))
            db.execute('INSERT INTO bob_deleted_skills VALUES (%s,%s,%s) ON CONFLICT(username,folder) DO NOTHING', (username,target,target))
            db.execute("DELETE FROM bob_storage_files WHERE username=%s AND scope='user' AND starts_with(path,%s)", (username,'.bob/skills/'+target+'/'))
            db.execute("UPDATE bob_personalization SET record=record || '{\"skill_name\":null}'::jsonb WHERE username=%s AND kind='presets' AND record->>'skill_name'=ANY(%s)", (username,[row['name'],target]))


def resolve_skill_alias(username, name):
    ensure_schema()
    with job_queue._connect() as db:
        row = db.execute('SELECT name FROM bob_skill_aliases WHERE username=%s AND alias=%s', (username,name)).fetchone()
    return row['name'] if row else name
