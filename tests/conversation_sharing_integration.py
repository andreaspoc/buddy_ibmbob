"""Account-gated share URLs with conversation IDs, tested in an isolated DB schema."""
import os, secrets
from urllib.parse import urlsplit
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from fastapi import Request, Response
from http.cookies import SimpleCookie
from app import postgres_storage as storage
from app import auth
from app.main import app
from app.auth import current_user
from app.sessions import create_session, append_history

original=os.environ['DATABASE_URL']
schema='sharing_test_'+secrets.token_hex(5)
with psycopg.connect(original,autocommit=True) as db:
 db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
os.environ['DATABASE_URL']=make_conninfo(original,options=f'-c search_path={schema}')
try:
 auth.create_user('share-test',secrets.token_urlsafe(20))
 auth.create_user('share-reader',secrets.token_urlsafe(20))
 session=create_session('share-test')['id']
 other=create_session('share-test')['id']
 storage.put_file('share-test','session:'+session,'private.txt',b'Synthetic private file',session_id=session)
 append_history(session,'share-test',{'type':'request','prompt':'Synthetic question'})
 append_history(session,'share-test',{'type':'delta','text':'Synthetic answer <script>unsafe()</script>'})
 append_history(session,'share-test',{'type':'tool','password':'PRIVATE_TEST_SECRET'})
 async def owner(): return {'username':'share-test','is_admin':False}
 app.dependency_overrides[current_user]=owner
 with TestClient(app,base_url='http://192.0.2.10:3000') as client:
  with patch.dict(os.environ,{'PUBLIC_BASE_URL':'http://192.0.2.10:3000'}):
   response=client.post('/sessions/'+session+'/share')
  assert response.status_code==201,response.text
  url=response.json()['url']
  assert url.startswith('http://192.0.2.10:3000/shared/'+session+'/'),url
  path=urlsplit(url).path
  token=path.rsplit('/',1)[-1]
  app.dependency_overrides.pop(current_user)
  page=client.get(path)
  assert page.status_code==200,page.text
  assert 'Synthetic question' not in page.text, 'Unauthenticated shell exposed messages'
  assert 'type="module"' in page.text, 'Shared page did not serve the normal UI'
  assert client.get('/api'+path).status_code==401
  assert client.get('/api/shared/'+token).status_code==401
  login_response=Response()
  request=Request({'type':'http','scheme':'http','server':('192.0.2.10',3000),'headers':[],'root_path':'','path':'/'})
  auth.start_session(login_response,{'username':'share-reader','is_admin':False},request)
  cookie=SimpleCookie();cookie.load(login_response.headers['set-cookie'])
  client.cookies.set(auth.COOKIE,cookie[auth.COOKIE].value)
  data=client.get('/api'+path)
  assert data.status_code==200,data.text
  assert data.json()['session_id']==session
  assert 'Synthetic answer' in data.text and 'PRIVATE_TEST_SECRET' not in data.text
  assert client.get('/api/shared/'+other+'/'+token).status_code==404
  assert client.get('/api/shared/'+token).status_code==200,'Legacy token-only link stopped working'
  assert client.get('/sessions/'+session+'/history').status_code==404
  assert client.get('/sessions/'+session+'/file',params={'path':'private.txt'}).status_code==404
  assert client.delete('/sessions/'+session+'/share').status_code==404
  append_history(session,'share-test',{'type':'delta','text':'Later synthetic message'})
  assert 'Later synthetic message' not in client.get('/api'+path).text
  app.dependency_overrides[current_user]=owner
  assert client.delete('/sessions/'+session+'/share').status_code==204
  app.dependency_overrides.pop(current_user)
  assert client.get('/api'+path).status_code==404
  assert client.get('/api/shared/'+token).status_code==404
 print('PASS: normal UI shell, account-required snapshot, authenticated recipient access, ID/token binding, private file isolation, immutable snapshots and revocation')
finally:
 app.dependency_overrides.pop(current_user,None)
 os.environ['DATABASE_URL']=original
 with psycopg.connect(original,autocommit=True) as db:
  db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
