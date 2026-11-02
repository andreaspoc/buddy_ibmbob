"""Owned projects, bounded imports, repository browsing and change review."""
from __future__ import annotations
from app.branding import brand_text
import io
import base64
import os
import re
import shutil
import stat
import subprocess
import uuid
import zipfile
import tempfile
from app import postgres_storage as storage, job_queue
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, quote
from contextlib import contextmanager
from fastapi import HTTPException
from app.auth import _connect
from app.sessions import user_root

MAX_ZIP = 50 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
MAX_FILES = 10000
HIDDEN = {'.git', '.bob', '.home', 'node_modules', '.venv', '__pycache__'}

@contextmanager
def database():
    with _connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username),
          name TEXT NOT NULL, source TEXT NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT now())''')
        yield db

def list_projects(username):
    with database() as db:
        rows = db.execute('SELECT id, name, source, created FROM projects WHERE username=%s ORDER BY created DESC', (username,)).fetchall()
    return [dict(id=r[0], name=r[1], source=r[2], created=r[3].isoformat()) for r in rows]

def project_root(username, project_id):
    if not re.fullmatch('[a-f0-9]{32}', project_id):
        raise HTTPException(404, 'Project not found')
    with database() as db:
        if not db.execute('SELECT 1 FROM projects WHERE id=%s AND username=%s', (project_id, username)).fetchone():
            raise HTTPException(404, 'Project not found')
    return user_root(username) / 'projects' / project_id

def git(root, *args, auth_token=None):
    env = {k:v for k,v in os.environ.items() if k in {'PATH','LANG','HOME'}}
    if auth_token:
        credential = base64.b64encode(('x-access-token:' + auth_token).encode()).decode()
        env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
                   GIT_CONFIG_VALUE_0='Authorization: Basic ' + credential)
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    try:
        result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false', '-C', str(root), *args], env=env, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise HTTPException(408, 'Git operation timed out')
    if result.returncode:
        err = result.stderr.decode('utf-8', errors='replace').strip()
        clean_err = re.sub(r'https?://[^@\s]+@', 'https://***@', err)
        lines = [line.strip() for line in clean_err.splitlines() if line.strip()]
        last_err = lines[-1] if lines else 'Unknown error'
        if 'Authentication failed' in clean_err:
            raise HTTPException(401, 'Git authentication failed. Please check repository permissions or your Personal Access Token.')
        if 'not found' in clean_err.lower():
            raise HTTPException(404, f'Git repository or branch not found ({last_err})')
        raise HTTPException(400, f'Git operation failed: {last_err}')
    return result.stdout

def validate_zip(data):
    if len(data) > MAX_ZIP:
        raise HTTPException(413, 'ZIP exceeds 50 MB')
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_EXPANDED:
            raise HTTPException(413, 'Archive exceeds 10,000 entries or 200 MB extracted')
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename or ':' in entry.filename
                or any(p in {'.git', '.bob', '.home'} for p in path.parts)
                or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}) or entry.flag_bits & 1):
                raise HTTPException(400, 'ZIP contains unsafe paths, links, reserved folders, or encrypted files')
        return archive
    except zipfile.BadZipFile:
        raise HTTPException(400, 'Invalid ZIP archive')

def _create_project_local(username, name, source='empty', data=None, url='', branch='', token=''):
    if not name.strip() or len(name) > 100:
        raise HTTPException(422, 'Project name must contain 1–100 characters')
    archive = validate_zip(data) if source == 'zip' else None
    token = (token or '').strip()
    if source == 'git':
        parsed = urlsplit(url)
        hosts = [h.strip() for h in os.getenv('BOB_GIT_HOSTS', 'github.com,gitlab.com,bitbucket.org').split(',') if h.strip()]
        
        # If user included credentials in the URL, extract them safely
        if parsed.username or parsed.password:
            if not token:
                token = parsed.password or parsed.username
            netloc = parsed.hostname + (f":{parsed.port}" if parsed.port and parsed.port != 443 else "")
            parsed = parsed._replace(netloc=netloc)
            url = parsed.geturl()

        if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.port not in {None,443} or parsed.query or parsed.fragment or not parsed.path.strip('/'):
            raise HTTPException(400, f'Use an HTTPS repository on an allowed Git host ({", ".join(hosts)}). For private repositories, enter your Personal Access Token.')
        if branch and not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}', branch):
            raise HTTPException(400, 'Invalid branch')
    project_id = uuid.uuid4().hex
    root = user_root(username, create=True) / 'projects' / project_id
    root.mkdir(parents=True)
    try:
        if source == 'git':
            clone_url = url
            if token:
                safe_token = quote(token, safe='')
                if parsed.hostname == 'github.com':
                    clone_url = f"https://x-access-token:{safe_token}@{parsed.hostname}{parsed.path}"
                elif parsed.hostname == 'gitlab.com':
                    clone_url = f"https://oauth2:{safe_token}@{parsed.hostname}{parsed.path}"
                elif parsed.hostname == 'bitbucket.org':
                    clone_url = f"https://x-token-auth:{safe_token}@{parsed.hostname}{parsed.path}"
                else:
                    clone_url = f"https://{safe_token}@{parsed.hostname}{parsed.path}"

            args = ['clone', '--depth=1', '--no-recurse-submodules']
            if branch: args += ['--branch', branch]
            try:
                git(root, *args, '--', clone_url, '.')
            except HTTPException as e:
                if token and token in e.detail:
                    e.detail = e.detail.replace(token, '***')
                raise e

            # Clean remote URL so token is never stored in .git/config on disk
            if token:
                try:
                    git(root, 'remote', 'set-url', 'origin', url)
                except Exception:
                    pass

            if any(p.is_symlink() for p in root.rglob('*')):
                raise HTTPException(400, 'Repositories with symlinks are not supported in this version')
        elif archive:
            with archive:
                try: archive.extractall(root)
                except (zipfile.BadZipFile, RuntimeError, OSError): raise HTTPException(400, 'Could not extract ZIP')
            children = list(root.iterdir())
            if len(children) == 1 and children[0].is_dir():
                wrapper = root.with_name(root.name + '-unpack')
                children[0].rename(wrapper)
                for child in list(wrapper.iterdir()): shutil.move(str(child), root / child.name)
                wrapper.rmdir()
        if source != 'git':
            git(root, 'init')
            git(root, 'add', '--all')
            git(root, '-c', brand_text('user.name=Buddy Workspace'), '-c', 'user.email=bob@localhost', 'commit', '--allow-empty', '-m', 'Initial project import')
        # Keep service configuration out of changes and downloadable archives.
        with (root / '.git' / 'info' / 'exclude').open('a') as f:
            f.write('\n.bob\n.home\n')
        if not (root / '.bob').exists():
            (root / '.bob').symlink_to(user_root(username) / '.bob', target_is_directory=True)
        with database() as db:
            storage.save_tree(username, 'project:'+project_id, root, db=db)
            db.execute('INSERT INTO projects (id,username,name,source) VALUES (%s,%s,%s,%s)', (project_id,username,name.strip(),source))
        return dict(id=project_id,name=name.strip(),source=source)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(root.with_name(root.name + '-unpack'), ignore_errors=True)
        raise

def safe_file(root, path):
    relative = PurePosixPath(path)
    if not path or relative.is_absolute() or '..' in relative.parts or any(p in {'.git','.bob','.home'} for p in relative.parts):
        raise HTTPException(400, 'Invalid file path')
    target = root / path
    if not target.resolve().is_relative_to(root.resolve()) or any(p.is_symlink() for p in [target, *target.parents] if p != root.parent):
        raise HTTPException(400, 'File links are not supported')
    return target

def files(root):
    found=[]
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in HIDDEN and not (Path(folder)/d).is_symlink())
        for name in sorted(names):
            p=Path(folder)/name
            if p.is_symlink(): continue
            found.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size})
            if len(found) >= MAX_FILES: return found
    return found

def read_file(root, path):
    target=safe_file(root,path)
    if not target.is_file(): raise HTTPException(404,'File not found')
    if target.stat().st_size > 1024*1024: raise HTTPException(413,'Preview limited to 1 MB')
    try:
        text=target.read_text('utf-8')
        if '\x00' in text: raise UnicodeError()
    except UnicodeError: raise HTTPException(415,'Binary file cannot be edited as text')
    return {'path':path,'content':text}

def changes(root):
    diff=git(root,'diff','--no-ext-diff','--no-textconv','HEAD','--','.',':(exclude).bob',':(exclude).home').decode('utf-8',errors='replace')
    untracked=git(root,'ls-files','--others','--exclude-standard','-z').decode('utf-8',errors='replace').split('\0')
    return {'diff':diff[:1000000], 'truncated':len(diff)>1000000, 'untracked':[p for p in untracked if p and p.split('/')[0] not in {'.bob','.home'}], 'baseline':'HEAD'}

def download(root):
    buffer=io.BytesIO()
    total=0
    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:
        for entry in files(root):
            total+=entry['size']
            if total > MAX_EXPANDED: raise HTTPException(413,'Project is too large to export')
            archive.write(safe_file(root,entry['path']),entry['path'])
    return buffer.getvalue()


def create_project(username, name, source='empty', data=None, url='', branch='', token=''):
    with tempfile.TemporaryDirectory(prefix='bob-import-') as directory:
        runtime_token = storage._runtime.set(Path(directory))
        try:
            return _create_project_local(username,name,source,data,url,branch,token)
        finally:
            storage._runtime.reset(runtime_token)


def stored_files(username, project_id):
    project_root(username,project_id)
    return [dict(path=r['path'],size=r['size']) for r in storage.list_files(username,'project:'+project_id)
            if not any(p in HIDDEN for p in PurePosixPath(r['path']).parts)]


def stored_read_file(username, project_id, path):
    root=project_root(username,project_id)
    safe_file(root,path)
    try: row=storage.get_file(username,'project:'+project_id,path)
    except ValueError as exc: raise HTTPException(400,str(exc)) from exc
    if not row: raise HTTPException(404,'File not found')
    if len(row['content'])>1024*1024: raise HTTPException(413,'Preview limited to 1 MB')
    try:
        text=row['content'].decode('utf-8')
        if '\x00' in text: raise UnicodeError()
    except UnicodeError: raise HTTPException(415,'Binary file cannot be edited as text')
    return {'path':path,'content':text}


def stored_edit_file(username,project_id,path,content,original):
    stored_read_file(username,project_id,path)
    try:
        with storage.mutation(username,'project:'+project_id) as db:
            row=db.execute('SELECT content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s',
                           (username,'project:'+project_id,path)).fetchone()
            if not row or storage.blob_storage.read(row).decode('utf-8')!=original:
                raise HTTPException(409,'File changed. Reopen it before saving.')
            storage._upsert(db,username,'project:'+project_id,path,content.encode('utf-8'))
    except ValueError as exc: raise HTTPException(409,str(exc)) from exc
    return {'ok':True}


def stored_changes(username,project_id):
    project_root(username,project_id)
    with storage.temporary_tree(username,'project:'+project_id) as root:
        return changes(root)


def stored_download(username,project_id):
    project_root(username,project_id)
    with storage.temporary_tree(username,'project:'+project_id) as root:
        return download(root)


def stored_publish(username, project_id, url, branch, token):
    project_root(username, project_id)
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'github.com' or parsed.port not in {None, 443}
        or parsed.username or parsed.password or parsed.query or parsed.fragment
        or not re.fullmatch(r'/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?/?', parsed.path)):
        raise HTTPException(400, 'Use a GitHub HTTPS repository URL without credentials')
    if not token.strip() or any(c in token for c in '\r\n'):
        raise HTTPException(422, 'A GitHub token with repository write access is required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}', branch):
        raise HTTPException(400, 'Invalid branch')
    # Publish a clean snapshot; never upload workspace configuration or Git metadata.
    with storage.temporary_tree(username, 'project:' + project_id) as source:
        with tempfile.TemporaryDirectory(prefix='bob-publish-') as directory:
            root = Path(directory)
            archive = validate_zip(download(source))
            with archive:
                archive.extractall(root)
            git(root, 'check-ref-format', '--branch', branch)
            git(root, 'init')
            git(root, 'add', '--all')
            git(root, '-c', brand_text('user.name=Buddy Workspace'), '-c', 'user.email=bob@localhost',
                'commit', '--allow-empty', '-m', brand_text('Export project from Buddy Workspace'))
            # A normal push rejects an existing branch with unrelated history.
            git(root, 'push', '--', url, 'HEAD:refs/heads/' + branch, auth_token=token.strip())
    return {'url': url.removesuffix('.git'), 'branch': branch}
