"""Shared-library lifecycle and access checks against an isolated PostgreSQL schema."""
import asyncio
import io
import json
import logging
import os
import secrets
from unittest.mock import patch, AsyncMock
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from openpyxl import Workbook
from app import rag, job_queue, postgres_storage as storage, worker
from app.main import app
from app.auth import current_user, create_user
from app.sessions import user_root, workspace_key
from app.workspace_config import select_root


def main():
    logging.getLogger('httpx').setLevel(logging.WARNING)
    original=os.environ['DATABASE_URL']
    schema='shared_test_'+secrets.token_hex(5)
    with psycopg.connect(original,autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    os.environ['DATABASE_URL']=make_conninfo(original,options=f'-c search_path={schema}')
    rag._schema_ready=False
    actor={'username':'uploader','is_admin':True}
    async def auth():
        select_root(user_root(actor['username'],create=True))
        return dict(actor)
    app.dependency_overrides[current_user]=auth
    try:
        create_user('uploader',secrets.token_urlsafe(20),admin=True)
        create_user('reader',secrets.token_urlsafe(20))
        storage.ensure_schema()
        # Simulate a pre-upgrade document in a private chat. The schema migration shares it.
        with job_queue._connect() as db:
            db.execute('''CREATE TABLE bob_knowledge_documents (
                id UUID PRIMARY KEY,username TEXT NOT NULL,workspace_id TEXT NOT NULL,
                filename TEXT NOT NULL,content BYTEA NOT NULL,sha256 TEXT NOT NULL,
                status TEXT NOT NULL,error TEXT,model TEXT,model_digest TEXT,dimensions INTEGER,
                chunk_count INTEGER NOT NULL DEFAULT 0,prepared_text TEXT,attempts INTEGER DEFAULT 0,
                worker_token UUID,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE(username,workspace_id,sha256))''')
            db.execute("INSERT INTO bob_knowledge_documents(id,username,workspace_id,filename,content,sha256,status) VALUES (gen_random_uuid(),'uploader','old-chat','existing.md',%s,'legacy-digest','queued')",(b'Existing library source.',))
        rag.ensure_schema()
        with TestClient(app) as client:
            first=client.post('/sessions').json()['id']
            second=client.post('/sessions').json()['id']
            source=b'# Shared policy\nThe shared service desk opens at 09:15.'
            result=client.post('/knowledge',files={'file':('policy.md',source)})
            assert result.status_code==201,result.text
            document=result.json();doc_id=document['id']
            assert document['shared'] and document['can_manage']
            assert client.post('/knowledge',files={'file':('copy.md',source)}).json()['id']==doc_id
            assert len(client.get('/knowledge').json())==2
            assert client.get(f'/sessions/{second}/knowledge/{doc_id}/file').content==source
            # Give sources a ready index without depending on the embedding network.
            while pending:=rag.claim():
                text=bytes(pending['content']).decode()
                rag.save_index(pending,[{'location':'text','text':text,'embedding':[1.0,0.0]}],'test-digest',text)
            actor.update(username='reader',is_admin=False)
            listed=client.get('/knowledge').json()
            assert len(listed)==2 and all(not d['can_manage'] for d in listed)
            assert client.get(f'/knowledge/{doc_id}/file').content==source
            assert client.get(f'/knowledge/{doc_id}/prepared').status_code==200
            assert client.delete(f'/knowledge/{doc_id}').status_code==403
            assert client.post(f'/knowledge/{doc_id}/retry').status_code==403
            assert client.get(f'/sessions/{first}/knowledge').status_code==200
            assert len(rag.ready_chunks('reader','any-session'))==2
            with patch.object(rag,'model_digest',AsyncMock(return_value='test-digest')),patch.object(rag,'embed_passage',AsyncMock(return_value=[{'embedding':[1.0,0.0]}])):
                passages=asyncio.run(rag.retrieve('reader','other-session','When does the desk open?'))
                response=client.post('/knowledge/search',json={'query':'desk opening time'})
                assert response.status_code==200,response.text
                assert response.json()
            passage=next(p for p in passages if str(p['id'])==doc_id)
            params={'citation':passage['citation_id'],'quote':'The shared service desk opens at 09:15.'}
            assert client.get(f'/knowledge/{doc_id}/preview',params=params).json()['exact']
            assert client.get(f'/sessions/{first}/knowledge/{doc_id}/preview',params=params).json()['exact']
            assert f'/knowledge/{doc_id}/file' in rag.attach_context('question',[passage],first)
            actor.update(username='uploader',is_admin=True)
            assert client.delete(f'/sessions/{first}').status_code==200
            assert client.get(f'/knowledge/{doc_id}/file').status_code==200
            # Ordinary attachments remain private and are never added to the library.
            assert client.post(f'/sessions/{second}/upload',files={'file':('private.txt',b'Personal attachment')}).status_code==201
            assert len(client.get('/knowledge').json())==2
            # New uploads through the legacy knowledge endpoint also become shared.
            pending=client.post(f'/sessions/{second}/knowledge',files={'file':('new.txt',b'New shared source.')}).json()
            actor.update(username='reader',is_admin=False)
            assert client.get(f"/knowledge/{pending['id']}/file").status_code==200
            # Administrators can remove source bytes and dependent records.
            actor.update(username='uploader',is_admin=True)
            assert client.post(f'/knowledge/{doc_id}/retry').status_code==202
            assert client.get(f'/knowledge/{doc_id}/preview',params=params).json()['exact']
            assert client.delete(f'/knowledge/{doc_id}').status_code==204
            assert client.get(f'/knowledge/{doc_id}/file').status_code==404
            assert client.get(f'/knowledge/{doc_id}/preview',params=params).status_code==404
            with job_queue._connect() as db:
                assert not db.execute('SELECT 1 FROM bob_knowledge_chunks WHERE document_id=%s',(doc_id,)).fetchone()
                assert not db.execute('SELECT 1 FROM bob_knowledge_citations WHERE document_id=%s',(doc_id,)).fetchone()
            actor.update(username='uploader',is_admin=True)
            assert client.post('/knowledge',files={'file':('dupe-new.txt',b'New shared source.')}).json()['id']==pending['id']
            # Spreadsheet extraction preserves row provenance and does not truncate rows.
            csv_sections=rag.extract('hours.csv',b'Team,Hours\nSupport,40\nSales,32\n')
            assert len(csv_sections)==2 and 'Hours: 40' in csv_sections[0][1]
            book=Workbook();book.active.append(['Team','Hours']);book.active.append(['Support',40])
            buf=io.BytesIO();book.save(buf)
            excel=rag.extract('hours.xlsx',buf.getvalue())
            assert 'Hours: 40' in excel[0][1]
            app.dependency_overrides.clear()
            assert client.get('/knowledge').status_code==401
        print('PASS: existing-source migration, all-user/all-session access, global deduplication, retrieval/search/citations, administrator management, chat deletion survival, private attachment separation, spreadsheet extraction and anonymous access rejection')
    finally:
        app.dependency_overrides.clear()
        rag._schema_ready=False
        os.environ['DATABASE_URL']=original
        with psycopg.connect(original,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))

if __name__=='__main__': main()
