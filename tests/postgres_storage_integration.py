"""Real PostgreSQL round trips, temporary workers, deletion and ownership checks."""
import asyncio
import io
import logging
import os
import json
import secrets
import tempfile
import uuid
import zipfile
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from app import job_queue, postgres_storage as storage, worker, projects
from app.auth import create_user, current_user, _connect
from app.main import app
from app.sessions import create_session, read_history, append_history, user_root, workspace_key
from app.workspace_config import select_root, create_skill, list_skills
from app.migrate_storage import migrate


def main():
    logging.getLogger('httpx').setLevel(logging.WARNING)
    # Keep the cleanup scan inside a private fixture root; never inspect other
    # users' or running services' scratch directories.
    with tempfile.TemporaryDirectory(prefix='bob-cleanup-fixture-') as fixture:
        with patch.object(storage.tempfile, 'gettempdir', return_value=fixture):
            with tempfile.TemporaryDirectory(prefix='bob-job-', dir=fixture) as scratch:
                (Path(scratch)/'.bob-storage-process').write_text(str(os.getpid()))
                storage.cleanup_abandoned_workspaces()
                assert Path(scratch).exists(), 'Cleanup must preserve active jobs'
            with tempfile.TemporaryDirectory(prefix='bob-job-', dir=fixture) as scratch:
                (Path(scratch)/'.bob-storage-process').write_text('1000000000')
                storage.cleanup_abandoned_workspaces()
                assert not Path(scratch).exists(), 'Cleanup must remove abandoned jobs'
    suffix=secrets.token_hex(5)
    original_database=os.environ['DATABASE_URL']
    schema='bob_test_'+suffix
    with psycopg.connect(original_database,autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    os.environ['DATABASE_URL']=make_conninfo(original_database,options=f'-c search_path={schema}')
    username='pgtest-'+suffix
    other='pgother-'+suffix
    password=secrets.token_urlsafe(20)
    create_user(username,password)
    create_user(other,password)
    storage.ensure_schema()
    owner={'username':username,'is_admin':False}
    async def auth():
        select_root(user_root(owner['username'],create=True))
        return owner
    app.dependency_overrides[current_user]=auth
    try:
        with TestClient(app) as client:
            first=client.post('/sessions').json()['id']
            second=client.post('/sessions').json()['id']
            root=user_root(username)
            assert not root.exists(), 'Authentication must not create a durable file cache'
            upload=client.post(f'/sessions/{first}/upload',files={'file':('data.bin',b'\x00\xffbytes')})
            assert upload.status_code==201,upload.text
            assert client.get(f'/sessions/{first}/file',params={'path':'data.bin'}).content==b'\x00\xffbytes'
            assert not root.exists(),'Downloading must not materialize files'
            assert client.put(f'/sessions/{first}/file',json={'path':'nested/page.html','content':'<html>stored</html>'}).status_code==200
            assert client.get('/workspace/page',params={'session_id':first,'path':'nested/page.html'}).json()['html']=='<html>stored</html>'
            assert client.get('/workspace/pages',params={'session_id':first}).json()[0]['path']=='nested/page.html'
            assert client.put(f'/sessions/{first}/file',json={'path':'presentation.bobdeck','content':json.dumps({'title':'DB deck','slides':[{}]})}).status_code==200
            assert client.get('/presentation/decks',params={'session_id':first}).json()[0]['slidesCount']==1
            assert client.get('/presentation/deck',params={'session_id':first}).json()['title']=='DB deck'
            append_history(first,username,{'type':'request','prompt':'test'})
            assert read_history(first,username)[0]['prompt']=='test'
            for path in ('../escape','/etc/passwd','.bob/secret','.git/config','a\\b'):
                assert client.put(f'/sessions/{first}/file',json={'path':path,'content':'bad'}).status_code==400
                assert client.delete(f'/sessions/{first}/file',params={'path':path}).status_code==400
            owner['username']=other
            assert client.get(f'/sessions/{first}/file',params={'path':'data.bin'}).status_code==404
            assert client.delete(f'/sessions/{first}').status_code==404
            owner['username']=username

            payload={'prompt':'test','bob_prompt':'test','mode':'agent','session_id':None}
            job_id=job_queue.enqueue(username,first,workspace_key(first,username),payload)
            assert client.delete(f'/sessions/{first}/file',params={'path':'data.bin'}).status_code==409
            assert client.put(f'/sessions/{first}/file',json={'path':'bad','content':'bad'}).status_code==409
            assert client.delete(f'/sessions/{first}').status_code==409
            token=str(uuid.uuid4())
            job=job_queue.claim(token)
            assert str(job['id'])==job_id
            scratch=[]
            async def fake_stream(*args,**kwargs):
                folder=Path(kwargs['workspace'])
                scratch.append(folder)
                assert (folder/'data.bin').read_bytes()==b'\x00\xffbytes'
                (folder/'result.txt').write_text('generated and saved')
                (folder/'nested'/'page.html').unlink()
                yield {'type':'delta','text':'done'}
                yield {'type':'done','session_id':'task-test'}
            with patch.object(worker.bridge,'stream',fake_stream), patch.object(worker.bridge,'stream_with_approvals',fake_stream), patch.object(worker.rag,'retrieve',side_effect=AssertionError('Retrieval must be chosen by Bob, not run before every turn')):
                asyncio.run(worker._run(job))
            assert not scratch[0].exists(),'Completed jobs must remove scratch files'
            assert storage.get_file(username,'session:'+first,'result.txt')['content']==b'generated and saved'
            assert storage.get_file(username,'session:'+first,'nested/page.html') is None,'Agent file deletion must persist'
            assert read_history(first,username)[-1]['type']=='done'
            assert client.delete(f'/sessions/{first}/file',params={'path':'data.bin'}).status_code==204
            assert storage.get_file(username,'session:'+first,'data.bin') is None
            select_root(user_root(username))
            created_skill = create_skill('test-skill','Postgres test skill','stored instructions')
            assert any(s['name']==created_skill['name'] for s in list_skills())
            assert not root.exists(),'User settings must remain in PostgreSQL'

            buf=io.BytesIO()
            with zipfile.ZipFile(buf,'w') as archive: archive.writestr('repo/app.py','print("hello")\n')
            response=client.post('/projects/upload',params={'name':'DB repository'},content=buf.getvalue())
            assert response.status_code==201,response.text
            pid=response.json()['id']
            assert client.get(f'/projects/{pid}/files').json()==[{'path':'app.py','size':15}]
            original=client.get(f'/projects/{pid}/file',params={'path':'app.py'}).json()['content']
            assert client.put(f'/projects/{pid}/file',json={'path':'app.py','content':'changed\n','original':original}).status_code==200
            assert '+changed' in client.get(f'/projects/{pid}/changes').json()['diff']
            with zipfile.ZipFile(io.BytesIO(client.get(f'/projects/{pid}/download').content)) as archive:
                assert archive.read('app.py')==b'changed\n'
            linked=client.post('/sessions',params={'project_id':pid}).json()['id']
            assert client.delete(f'/sessions/{linked}').status_code==200
            assert storage.get_file(username,'project:'+pid,'app.py')['content']==b'changed\n'
            linked=client.post('/sessions',params={'project_id':pid}).json()['id']
            assert client.delete(f'/projects/{pid}').status_code==200
            assert not storage.list_files(username,'project:'+pid,internal=True)
            assert client.get(f'/sessions/{linked}/history').status_code==404
            assert client.delete(f'/sessions/{first}').status_code==200
            assert client.delete(f'/sessions/{first}').status_code==200
            assert not storage.list_files(username,'session:'+first,internal=True)
            assert not storage.list_files(username,'home:'+first,internal=True)
            with job_queue._connect() as db:
                assert not db.execute('SELECT 1 FROM bob_conversation_history WHERE username=%s AND session_id=%s',(username,first)).fetchone()
                assert not db.execute('SELECT 1 FROM bob_jobs WHERE username=%s AND workspace_id=%s',(username,first)).fetchone()
            assert client.get(f'/sessions/{second}/history').status_code==200
            # A cancelled run retains generated files and always cleans scratch.
            job_id=job_queue.enqueue(username,second,workspace_key(second,username),payload)
            job=job_queue.claim(str(uuid.uuid4()))
            async def cancelled_stream(*args,**kwargs):
                folder=Path(kwargs['workspace']);scratch.append(folder)
                (folder/'partial.txt').write_text('keep cancelled output')
                job_queue.request_cancel(job_id,username)
                raise asyncio.CancelledError()
                yield
            with patch.object(worker.bridge,'stream',cancelled_stream), patch.object(worker.bridge,'stream_with_approvals',cancelled_stream): asyncio.run(worker.execute_job(job,str(job['worker_token'])))
            assert not scratch[-1].exists()
            assert storage.get_file(username,'session:'+second,'partial.txt')['content']==b'keep cancelled output'
            assert job_queue.get_job(job_id)['status']=='failed'
            direct_scratch=[]
            async def fake_ask(*args,**kwargs):
                path=Path(kwargs['workspace']);direct_scratch.append(path)
                (path/'direct.txt').write_text('direct endpoint output')
                return {'text':'done','session_id':'fake-task','prompt_response':{},'events':[]}
            with patch('app.main.bridge.ask',fake_ask),patch('app.main.rag.retrieve',return_value=[]):
                response=client.post('/ask',json={'prompt':'direct test'})
                assert response.status_code==200,response.text
            assert not direct_scratch[0].exists()
            assert storage.get_file(username,'session:legacy','direct.txt')['content']==b'direct endpoint output'
            # Migration commits and verifies before removing original files.
            with tempfile.TemporaryDirectory() as directory:
                source=Path(directory)
                session_id=uuid.uuid4().hex
                old=source/'users'/username/'sessions'/session_id
                old.mkdir(parents=True)
                (old/'.conversation.json').write_text(json.dumps({'id':session_id,'title':'Migrated','updated':'2026-01-01'}))
                (old/'.history.jsonl').write_text(json.dumps({'type':'delta','text':'old history'})+'\n')
                (old/'old.txt').write_text('old file')
                migrate(source,apply=True,remove_local=True)
                assert not old.exists()
                assert read_history(session_id,username)[0]['text']=='old history'
                assert storage.get_file(username,'session:'+session_id,'old.txt')['content']==b'old file'
            print('PASS: uploads/downloads, history, previews, decks, worker cleanup, cancelled output, ownership, traversal, active-job guards, project diffs/export, file/chat/project deletion, settings, verified migration')
    finally:
        app.dependency_overrides.clear()
        # Dropping the disposable schema also works if setup failed before a
        # table was created; per-table cleanup could mask the original failure.
        os.environ['DATABASE_URL']=original_database
        with psycopg.connect(original_database,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))

if __name__=='__main__': main()
