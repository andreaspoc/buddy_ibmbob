"""Save real generated revisions twice through leased workspace persistence."""
import hashlib
import json
import os
import secrets
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import artifacts, job_queue, postgres_storage as storage
from app.chat_correlation import request_ids, turn_metadata

original=os.environ['DATABASE_URL']
schema='provenance_'+secrets.token_hex(6)
with psycopg.connect(original,autocommit=True) as db:
    db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
try:
    scoped=make_conninfo(original,options=f'-c search_path={schema}')
    with patch.dict(os.environ,{'DATABASE_URL':scoped,'BOB_FILE_STORAGE':'postgres'}), patch('app.sessions.storage_scope',return_value='session:chat'), patch('app.artifacts.scope_for',return_value='session:chat'):
        storage.ensure_schema()
        payload=request_ids({})
        job=job_queue.enqueue('fixture-owner','chat','fixture-owner:chat',payload,request_event={'type':'request','prompt':'Synthetic provenance fixture'})
        token=str(uuid.uuid4())
        assert str(job_queue.claim(token)['id'])==str(job)
        with tempfile.TemporaryDirectory() as directory:
            user=Path(directory)
            workspace=user/'workspace'
            workspace.mkdir()
            digests=[]
            for content in ('<h1>Synthetic revision one</h1>','<h1>Synthetic revision two</h1>'):
                (workspace/'page.html').write_text(content)
                digest=hashlib.sha256(content.encode()).hexdigest()
                digests.append(digest)
                job_queue.append_event(job,token,{'type':'artifact','path':'page.html','sha256':digest,'content':content,'kind':'html'})
                storage.persist_job({'id':job,'worker_token':token,'username':'fixture-owner','workspace_id':'chat'},user,workspace)
            versions=artifacts.history('fixture-owner','chat','page.html')
            assert [version['id'] for version in versions]==digests,versions
            assert all(version['provenance']['job_id']==str(job) for version in versions)
            assert artifacts.read('fixture-owner','chat','page.html')['provenance']['assistant_message_id']==payload['assistant_message_id']
            # Deleted workspace files disappear; server-owned revision history survives.
            (workspace/'page.html').unlink()
            storage.persist_job({'id':job,'worker_token':token,'username':'fixture-owner','workspace_id':'chat'},user,workspace)
            assert storage.get_file('fixture-owner','session:chat','page.html') is None
            assert len(artifacts.history('fixture-owner','chat','page.html'))==2
    print('PASS: leased persistence captures exact generated revisions, preserves older provenance across tree saves, and still deletes removed files')
finally:
    with psycopg.connect(original,autocommit=True) as db:
        db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
