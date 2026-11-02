"""Run inside the application container with PYTHONPATH=/opt/bob-a2a."""
import io
import os
import secrets
import shutil
import stat
import zipfile
import httpx
from app.auth import _connect
from app.sessions import user_root, workspace_for, append_history, read_history

suffix=secrets.token_hex(4)
users=['projecttest-'+suffix,'projectother-'+suffix]
password=secrets.token_urlsafe(20)
base='http://127.0.0.1:8080'
def archive(entries):
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w') as z:
        for name,data in entries.items(): z.writestr(name,data)
    return buf.getvalue()
def ok(response, status=200):
    assert response.status_code==status, (response.status_code,response.text[:400])
    return response.json()
try:
    with httpx.Client(base_url=base, timeout=140) as a, httpx.Client(base_url=base, timeout=140) as b:
        ok(a.post('/auth/register',json={'username':users[0],'password':password}),201)
        ok(b.post('/auth/register',json={'username':users[1],'password':password}),201)
        p=ok(a.post('/projects/upload',params={'name':'Uploaded application'},content=archive({'sample/README.md':'# Sample\n','sample/app.py':'print("hello")\n'})),201)
        pid=p['id']
        assert {f['path'] for f in ok(a.get(f'/projects/{pid}/files'))}=={'README.md','app.py'}
        assert b.get(f'/projects/{pid}/files').status_code==404
        assert b.post('/sessions',params={'project_id':pid}).status_code==404
        assert a.get(f'/projects/{pid}/file',params={'path':'../../.env'}).status_code==400
        assert a.get(f'/projects/{pid}/file',params={'path':'.git/config'}).status_code==400
        text=ok(a.get(f'/projects/{pid}/file',params={'path':'app.py'}))['content']
        ok(a.put(f'/projects/{pid}/file',json={'path':'app.py','content':'print("changed")\n','original':text}))
        assert a.put(f'/projects/{pid}/file',json={'path':'app.py','content':'stale','original':text}).status_code==409
        diff=ok(a.get(f'/projects/{pid}/changes'))
        assert '+print("changed")' in diff['diff']
        assert '.bob' not in diff['untracked']
        s1=ok(a.post('/sessions',params={'project_id':pid}),201)
        s2=ok(a.post('/sessions',params={'project_id':pid}),201)
        assert workspace_for(s1['id'],users[0])==workspace_for(s2['id'],users[0])
        append_history(s1['id'],users[0],{'type':'test','value':'private'})
        assert read_history(s1['id'],users[0]) and not read_history(s2['id'],users[0])
        exported=a.get(f'/projects/{pid}/download');assert exported.status_code==200
        with zipfile.ZipFile(io.BytesIO(exported.content)) as z:
            assert z.read('app.py')==b'print("changed")\n'
            assert not any(p.startswith('.git/') for p in z.namelist())
        for bad in ['../escape.txt','/escape.txt','repo/.git/config','repo/.bob/skills/bad.md']:
            assert a.post('/projects/upload',params={'name':'Bad'},content=archive({bad:'bad'})).status_code==400
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:
            entry=zipfile.ZipInfo('link');entry.create_system=3;entry.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(entry,'/etc/passwd')
        assert a.post('/projects/upload',params={'name':'Symlink'},content=buf.getvalue()).status_code==400
        assert a.post('/projects',json={'name':'Bad URL','url':'file:///etc'}).status_code==400
        assert a.post('/projects',json={'name':'Credentials','url':'https://user:password@github.com/owner/repo'}).status_code==400
        empty=ok(a.post('/projects',json={'name':'Empty project'}),201)
        assert ok(a.get(f'/projects/{empty["id"]}/files'))==[]
        # Optional network integration: public clone, no credentials or execution.
        if os.getenv('TEST_GIT_IMPORT')=='1':
            cloned=ok(a.post('/projects',json={'name':'Public clone','url':'https://github.com/octocat/Hello-World.git'}),201)
            assert ok(a.get(f'/projects/{cloned["id"]}/files'))
        assert ok(a.get('/ready'))['ok']
        print('PASS: ZIP import/export, Git URL checks, ownership, traversal/symlink rejection, editing, stale-write conflict, diffs, shared project context, separate chat histories, readiness')
finally:
    with _connect() as db:
        for name in users:
            db.execute('DELETE FROM projects WHERE username=%s',(name,))
            db.execute('DELETE FROM sessions WHERE username=%s',(name,))
            db.execute('DELETE FROM users WHERE username=%s',(name,))
    for name in users:
        try: shutil.rmtree(user_root(name))
        except FileNotFoundError: pass
