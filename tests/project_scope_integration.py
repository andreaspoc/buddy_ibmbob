"""Synthetic projects in an isolated DB schema verify file/context boundaries."""
import os, secrets
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import auth, projects, postgres_storage as storage
from app.main import app
from app.auth import current_user
from app.sessions import create_session, storage_scope

original=os.environ['DATABASE_URL']
schema='project_scope_'+secrets.token_hex(5)
with psycopg.connect(original,autocommit=True) as db:
 db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
os.environ['DATABASE_URL']=make_conninfo(original,options=f'-c search_path={schema}')
username='scope-test'
try:
 password=secrets.token_urlsafe(20)
 auth.create_user(username,password)
 first=projects.create_project(username,'Synthetic project A','empty')
 second=projects.create_project(username,'Synthetic project B','empty')
 personal=create_session(username)
 private_other=create_session(username)
 project_a=create_session(username,first['id'])
 project_a_other=create_session(username,first['id'])
 project_b=create_session(username,second['id'])
 for session,name in ((personal,'personal.txt'),(private_other,'other-personal.txt'),(project_a,'project-a.csv'),(project_b,'project-b.csv')):
  storage.put_file(username,storage_scope(session['id'],username),name,b'Synthetic test data',session_id=session['id'])
 async def owner(): return {'username':username,'is_admin':False}
 app.dependency_overrides[current_user]=owner
 with TestClient(app, headers={'Origin': 'http://testserver'}) as client:
  with patch.dict(os.environ, {'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_UI_SECURE_COOKIE': '0'}):
   login=client.post('/auth/login',json={'username':username,'password':password})
   assert login.status_code == 200, login.text
  assert {s['id'] for s in client.get('/sessions').json()}=={personal['id'],private_other['id']}
  for project,expected in ((first,{project_a['id'],project_a_other['id']}),(second,{project_b['id']})):
   assert {s['id'] for s in client.get('/sessions',params={'project_id':project['id']}).json()}==expected
  for session,allowed,forbidden in ((personal,'personal.txt','project-a.csv'),(project_a,'project-a.csv','project-b.csv'),(project_b,'project-b.csv','project-a.csv')):
   base='/sessions/'+session['id']
   assert client.get(base+'/file',params={'path':allowed}).status_code==200
   assert client.get(base+'/file',params={'path':forbidden}).status_code==404
  assert client.get('/sessions/'+project_a_other['id']+'/file',params={'path':'project-a.csv'}).status_code==200
 for session,expected in ((personal,{'personal.txt'}),(project_a,{'project-a.csv'}),(project_b,{'project-b.csv'})):
  with storage.job_workspace(username,session['id']) as (user,workspace):
   assert {p.name for p in workspace.iterdir() if p.is_file()} <= expected|{'AGENTS.md'}
   assert (workspace/next(iter(expected))).is_file()
   visible={p.name for p in user.rglob('*') if p.is_file()}
   assert not (({'personal.txt','other-personal.txt','project-a.csv','project-b.csv'}-expected)&visible),visible
 print('PASS: personal/project catalog segregation, file API isolation, same-project sharing, isolated agent runtime trees')
finally:
 app.dependency_overrides.pop(current_user,None)
 os.environ['DATABASE_URL']=original
 with psycopg.connect(original,autocommit=True) as db:
  db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
