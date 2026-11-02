"""Two-turn CSV analysis survives a missing Bob task and temporary workspace changes."""
import asyncio
import csv
import os
import uuid
from pathlib import Path
from unittest.mock import patch
from contextlib import nullcontext
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import job_queue, worker, postgres_storage as storage
from app.auth import current_user, create_user
from app.main import app
from app.sessions import create_session, append_history, read_history, workspace_key, user_root
from app.workspace_config import select_root


def main():
    original=os.environ['DATABASE_URL']
    schema='csvfollowup_'+uuid.uuid4().hex[:12]
    with psycopg.connect(original,autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    owner='csv-followup-test'
    calls=[]
    async def fake_stream(prompt,session_id=None,mode='agent',workspace=None,user_home=None):
        path=Path(workspace)/'sales.csv'
        assert path.is_file()
        assert 'sales.csv' in prompt
        assert str(workspace) in prompt
        assert 'private-other.csv' not in prompt
        with path.open() as file:
            rows=list(csv.DictReader(file))
        if calls:
            assert 'Analyze the total revenue' in prompt
            assert 'Total revenue: 150' in prompt
            assert 'Previous turns from this conversation' in prompt
            result=sum(int(row['revenue']) for row in rows if row['region']=='South')
            text=f'South revenue: {result}'
        else:
            text=f'Total revenue: {sum(int(row["revenue"]) for row in rows)}'
        calls.append(workspace)
        yield {'type':'delta','text':text}
        yield {'type':'done','session_id':'missing-native-task'}
    try:
        with patch.dict(os.environ,{'DATABASE_URL':make_conninfo(original,options='-c search_path='+schema)}):
            create_user(owner,'temporary-followup-password',False)
            select_root(user_root(owner,create=True))
            app.dependency_overrides[current_user]=lambda:{'username':owner,'is_admin':False}
            with TestClient(app) as client:
                sid=client.post('/sessions').json()['id']
                response=client.post(f'/sessions/{sid}/upload',files={'file':('sales.csv',b'region,revenue\nNorth,100\nSouth,20\nSouth,30\n')})
                assert response.status_code==201,response.text
                storage.put_file('csv-other','session:other','private-other.csv',b'secret,data\n1,2\n')
                for question in ('[Attached spreadsheet: sales.csv]\nAnalyze the total revenue','What about South?'):
                    append_history(sid,owner,{'type':'request','prompt':question})
                    payload={'prompt':question,'bob_prompt':question,'mode':'agent','session_id':'missing-native-task'}
                    job_queue.enqueue(owner,sid,workspace_key(sid,owner),payload)
                    token=str(uuid.uuid4()); job=job_queue.claim(token)
                    with nullcontext() if os.getenv('REAL_BOB')=='1' else patch.object(worker.bridge,'stream',fake_stream):
                        asyncio.run(worker.execute_job(job,token))
                    assert job_queue.get_job(str(job['id']))['status']=='completed'
                if os.getenv('REAL_BOB')!='1':
                    assert len(calls)==2 and calls[0]!=calls[1]
                history=read_history(sid,owner)
                if os.getenv('REAL_BOB')=='1':
                    assert '50' in history[-2]['text'], history[-2:]
                    print('Real Bob follow-up computed South revenue of 50.')
                else:
                    assert history[-2]['text']=='South revenue: 50',history[-2:]
                assert any(file['name']=='sales.csv' for file in client.get(f'/sessions/{sid}/files').json())
        print('CSV follow-up integration passed: upload, restored full file, new workspaces, missing native session, prior context and owner isolation')
    finally:
        app.dependency_overrides.pop(current_user,None)
        with psycopg.connect(original,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__=='__main__':
    main()
