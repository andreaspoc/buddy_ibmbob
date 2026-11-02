"""Import the old workspace into PostgreSQL. Dry run unless --apply is supplied."""
from __future__ import annotations
from app.branding import brand_text
import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from app import postgres_storage as storage, job_queue, object_storage
from app.sessions import _VALID_ID, _VALID_USER


def _import_session(db, username, root):
    session_id=root.name
    metadata=root/'.conversation.json'
    record=json.loads(metadata.read_text()) if metadata.is_file() else {'id':session_id,'title':'Recovered conversation','updated':datetime.fromtimestamp(root.stat().st_mtime,timezone.utc).isoformat()}
    if record.get('id') != session_id: raise ValueError('Conversation metadata ID mismatch')
    if db.execute('SELECT 1 FROM bob_deleted_conversations WHERE username=%s AND workspace_id=%s',(username,session_id)).fetchone():
        raise ValueError('Deleted conversation still has local data; remove it separately')
    db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb) ON CONFLICT DO NOTHING',
               (username,session_id,json.dumps(record)))
    scope='session:'+session_id
    storage.save_tree(username,scope,root,db=db,merge=True)
    history=root/'.history.jsonl'
    if history.is_file():
        if not db.execute('SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s',(username,session_id)).fetchone():
            for line in history.read_text().splitlines():
                if line.strip():
                    event=json.loads(line)
                    db.execute('INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,%s,%s::jsonb)',(username,session_id,json.dumps(event)))
    return scope


def migrate(source: Path, *, apply=False, remove_local=False):
    storage.ensure_schema()
    with job_queue._connect() as db:
        if db.execute("SELECT 1 FROM bob_jobs WHERE status IN ('queued','running') LIMIT 1").fetchone():
            raise RuntimeError(brand_text('Stop Buddy and wait for active jobs before migrating'))
        db.execute('CREATE TABLE IF NOT EXISTS bob_storage_migrations(source TEXT PRIMARY KEY, migrated_at TIMESTAMPTZ DEFAULT now())')
    users=source/'users'
    migrated=0
    for root in sorted(users.iterdir() if users.exists() else []):
        username=root.name
        if not root.is_dir() or root.is_symlink() or not _VALID_USER.fullmatch(username): continue
        key=str(root.resolve())
        with job_queue._connect() as db:
            already=db.execute('SELECT 1 FROM bob_storage_migrations WHERE source=%s',(key,)).fetchone()
        if already:
            print(f'{username}: already migrated; original files retained (no overwrite)')
            continue
        sessions=[p for p in (root/'sessions').iterdir() if p.is_dir() and _VALID_ID.fullmatch(p.name)] if (root/'sessions').exists() else []
        files=sum(1 for p in root.rglob('*') if p.is_file() and not p.is_symlink())
        print(f'{username}: {len(sessions)} conversations, {files} local files')
        if not apply: continue
        # Import existing Office Suite copies before inspecting the local tree.
        if os.getenv('BOB_S3_BUCKET'):
            for session in sessions:
                metadata_path=session/'.conversation.json'
                metadata=json.loads(metadata_path.read_text()) if metadata_path.is_file() else {}
                if metadata.get('project_id'): continue
                prefix=f'users/{username}/sessions/{session.name}/files/'
                client=object_storage._client()
                for page in client.get_paginator('list_objects_v2').paginate(Bucket=os.environ['BOB_S3_BUCKET'],Prefix=prefix):
                    for item in page.get('Contents',[]):
                        relative=item['Key'][len(prefix):]
                        storage.validate_path(relative,internal=True)
                        path=session/('.history.jsonl' if relative=='history.jsonl' else relative)
                        if not path.is_file():
                            path.parent.mkdir(parents=True,exist_ok=True)
                            client.download_file(os.environ['BOB_S3_BUCKET'],item['Key'],str(path))
                            head=client.head_object(Bucket=os.environ['BOB_S3_BUCKET'],Key=item['Key'])
                            if head.get('Metadata',{}).get('sha256') and hashlib.sha256(path.read_bytes()).hexdigest()!=head['Metadata']['sha256']:
                                raise OSError('Office Suite migration checksum mismatch')
        with job_queue._connect() as db:
            storage._lock(db,username,'user')
            for session in sessions: _import_session(db,username,session)
            for project in (root/'projects').iterdir() if (root/'projects').exists() else []:
                if project.is_dir() and not project.is_symlink() and _VALID_ID.fullmatch(project.name):
                    storage.save_tree(username,'project:'+project.name,project,db=db,merge=True)
            # User settings and Bob's prior SQLite task records are retained as private blobs.
            for path in root.rglob('*'):
                if not path.is_file() or path.is_symlink(): continue
                relative=path.relative_to(root).as_posix()
                if relative.split('/')[0] in {'sessions','projects'}: continue
                scope='user' if relative.startswith(('.bob/','.home/')) else 'session:legacy'
                if relative=='.history.jsonl':
                    if not db.execute("SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id='legacy'",(username,)).fetchone():
                        for line in path.read_text().splitlines():
                            if line.strip(): db.execute("INSERT INTO bob_conversation_history(username,session_id,event) VALUES (%s,'legacy',%s::jsonb)",(username,json.dumps(json.loads(line))))
                else:
                    storage._upsert(db,username,scope,relative,path.read_bytes(),path.stat().st_mode & 0o777,path.stat().st_mtime_ns)
            db.execute('INSERT INTO bob_storage_migrations(source) VALUES (%s)',(key,))
        # Commit precedes read-back; never remove a source whose bytes failed verification.
        for path in root.rglob('*'):
            if not path.is_file() or path.is_symlink(): continue
            relative=path.relative_to(root).as_posix()
            parts=Path(relative).parts
            if parts[0]=='sessions':
                if parts[-1] in {'.conversation.json','.history.jsonl','.s3-backed','.deleting'}: continue
                scope='session:'+parts[1]; relative=Path(*parts[2:]).as_posix()
            elif parts[0]=='projects':
                scope='project:'+parts[1]; relative=Path(*parts[2:]).as_posix()
            else:
                if relative=='.history.jsonl': continue
                scope='user' if relative.startswith(('.bob/','.home/')) else 'session:legacy'
            row=storage.get_file(username,scope,relative,internal=True)
            if not row or row['content']!=path.read_bytes(): raise OSError(f'Migration verification failed: {path}')
        if remove_local: shutil.rmtree(root)
        migrated+=1
    print(f'{migrated} users migrated' if apply else 'Dry run: no user data changed')


def migrate_global(source,private_home=None,*,apply=False,remove_local=False):
    from app.auth import _connect
    with _connect() as db:
        owner=db.execute('SELECT username FROM users ORDER BY is_admin DESC,username LIMIT 1').fetchone()
    if not owner: return
    username=owner[0]
    files=[p for p in source.iterdir() if p.is_file() and p.suffix.lower() in {'.html','.htm','.bobdeck','.pptx'}]
    print(f'Global legacy workspace: {len(files)} files assigned to {username}')
    if not apply: return
    key=str(source.resolve())+':global'
    with job_queue._connect() as db:
        if db.execute('SELECT 1 FROM bob_storage_migrations WHERE source=%s',(key,)).fetchone(): return
        for path in files: storage._upsert(db,username,'session:legacy',path.name,path.read_bytes())
        if private_home and private_home.is_dir():
            for path in private_home.rglob('*'):
                if path.is_file() and not path.is_symlink():
                    storage._upsert(db,username,'home:legacy','.bob/'+path.relative_to(private_home).as_posix(),path.read_bytes(),path.stat().st_mode & 0o777)
        db.execute('INSERT INTO bob_storage_migrations(source) VALUES (%s)',(key,))
    for path in files:
        row=storage.get_file(username,'session:legacy',path.name,internal=True)
        if not row or row['content']!=path.read_bytes(): raise OSError('Legacy file verification failed')
    if private_home and private_home.is_dir():
        for path in private_home.rglob('*'):
            if path.is_file() and not path.is_symlink():
                row=storage.get_file(username,'home:legacy','.bob/'+path.relative_to(private_home).as_posix(),internal=True)
                if not row or row['content']!=path.read_bytes(): raise OSError(brand_text('Legacy Buddy home verification failed'))
        if remove_local:
            for child in private_home.iterdir():
                if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
                else: child.unlink()
    if remove_local:
        for path in files:
            if path.name!='interactive_deck_template.html': path.unlink()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path(os.getenv('BOB_WORKSPACE','/workspace')))
    parser.add_argument('--private-home',type=Path,help=brand_text('Old global Buddy home directory (the .bob directory)'))
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--remove-local',action='store_true',help='Remove old user directories after commit and verification')
    args=parser.parse_args()
    if args.remove_local and not args.apply: parser.error('--remove-local requires --apply')
    migrate(args.source.resolve(),apply=args.apply,remove_local=args.remove_local)
    migrate_global(args.source.resolve(),args.private_home,apply=args.apply,remove_local=args.remove_local)

if __name__=='__main__': main()
