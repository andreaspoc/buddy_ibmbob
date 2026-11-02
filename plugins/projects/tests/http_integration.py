"""Run inside Buddy runtime. Uses one rolled-back DB transaction; no persistent fixtures."""
import os
import uuid
from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import auth, job_queue
from buddy_projects import service

conn = psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row)
@contextmanager
def connection():
    yield conn
job_queue._connect = connection
prefix = 'test-projects-' + uuid.uuid4().hex[:12]
realm = 'https://projects-test.invalid/realms/' + prefix
os.environ['KEYCLOAK_ISSUER'] = realm
actor = {'username': prefix+'admin', 'is_admin': True}
async def user():
    return actor
app = FastAPI()
app.include_router(service.router)
app.dependency_overrides[auth.current_user] = user
client = TestClient(app)
# Existing CRUD cases submit the revision currently shown by their loaded form.
raw_patch = client.patch
def patch(url, **kwargs):
    import re
    match = re.fullmatch(r'/api/projects/(projects|work-items)/(\d+)', url)
    if match and 'expected_revision' not in kwargs.get('json', {}):
        table = 'projects' if match[1] == 'projects' else 'work_items'
        row = conn.execute(f'SELECT revision FROM projects.{table} WHERE id=%s', (int(match[2]),)).fetchone()
        kwargs['json'] = {**kwargs.get('json', {}), 'expected_revision': row['revision'] if row else 1}
    return raw_patch(url, **kwargs)
client.patch = patch
try:
    service.ensure_schema()
    # Existing auth schema is from the real runtime. All changes roll back at the end.
    conn.execute('''CREATE TABLE IF NOT EXISTS bob_keycloak_identities (
      issuer TEXT NOT NULL,subject TEXT NOT NULL,username TEXT NOT NULL REFERENCES users(username),PRIMARY KEY(issuer,subject))''')
    for suffix in ('admin','member','other','local'):
        name = prefix+suffix
        conn.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,%s)', (name,'unusable-test-hash',suffix=='admin'))
        if suffix != 'local':
            conn.execute('INSERT INTO bob_keycloak_identities VALUES (%s,%s,%s)', (realm,suffix,name))
    response = client.get('/api/projects')
    assert response.status_code == 200, response.text
    baseline = len(response.json()['events'])
    assert len(response.json()['people']) == 3
    def project(name):
        r = client.post('/api/projects/projects', json={'name':name,'status':'active'})
        assert r.status_code == 201, r.text
        return r.json()['id']
    first, second, hidden = project('Test one'), project('Test two'), project('Hidden test')
    r = client.post('/api/projects/assignments', json={'project_id':first,'person_id':prefix+'member','responsibility':'Approval','role':'owner'})
    assert r.status_code == 201, r.text
    assert client.post('/api/projects/assignments', json={'project_id':first,'person_id':prefix+'local','responsibility':'Invalid'}).status_code == 422
    assert client.post('/api/projects/dependencies',json={'source_project_id':first,'target_project_id':second}).status_code == 201
    assert client.post('/api/projects/dependencies',json={'source_project_id':second,'target_project_id':hidden}).status_code == 201
    assert client.post('/api/projects/dependencies',json={'source_project_id':first,'target_project_id':first}).status_code == 422
    assert next(p for p in client.get('/api/projects').json()['projects'] if p['id']==first)['start_date'] is None
    assert client.post('/api/projects/projects',json={'name':'Invalid dates','start_date':'2027-03-01','due_date':'2027-02-01'}).status_code==422
    updated = client.patch(f'/api/projects/projects/{first}', json={'start_date':'2027-01-01','due_date':'2027-02-01','milestone':'Reviewed release'} )
    assert updated.status_code == 200, updated.text
    assert updated.json()['impact']['summary'] == {'confirmed':1,'risks':2,'affected_projects':3}
    assert updated.json()['start_date']=='2027-01-01'
    assert client.patch(f'/api/projects/projects/{first}',json={'start_date':'2027-03-01'}).status_code==422
    assert client.patch(f'/api/projects/projects/{first}',json={'due_date':'2026-12-01'}).status_code==422
    assert client.post('/api/projects/impact/preview',json={'kind':'project_change','project_id':first,'start_date':'2027-03-01'}).status_code==422
    scenario=client.post('/api/projects/impact/preview',json={'kind':'project_change','project_id':first,'start_date':'2027-01-15'})
    assert scenario.status_code==200,scenario.text
    assert scenario.json()['summary']['affected_projects']==3

    recent = client.get('/api/projects').json()['recent_change_impacts']
    saved = next(r for r in recent if r['project_id'] == first)
    assert saved['change']['due_date'] == {'before':None,'after':'2027-02-01'}
    assert saved['impact']['summary']['affected_projects'] == 3
    no_change = client.patch(f'/api/projects/projects/{first}', json={'due_date':'2027-02-01'})
    assert no_change.status_code == 200
    assert next(r for r in client.get('/api/projects').json()['recent_change_impacts'] if r['project_id']==first)['event_id'] == saved['event_id']
    for kind, valid_status in [('task','blocked'),('risk','mitigating'),('issue','in_progress'),('decision','proposed')]:
        created = client.post('/api/projects/work-items',json={'project_id':first,'kind':kind,'title':'Test '+kind,'owner_id':prefix+'member'})
        assert created.status_code==201,created.text
        item_id=created.json()['id']
        assert created.json()['status']==service.WORK_STATUSES[kind][0]
        updated=client.patch(f'/api/projects/work-items/{item_id}',json={'status':valid_status,'start_date':'2027-01-01','due_date':'2027-02-05','resolution':'Review recorded'})
        assert updated.status_code==200,updated.text
        assert updated.json()['resolution']=='Review recorded'
        assert updated.json()['start_date']=='2027-01-01'
        assert client.patch(f'/api/projects/work-items/{item_id}',json={'start_date':'2027-03-01'}).status_code==422
        assert client.patch(f'/api/projects/work-items/{item_id}',json={'due_date':'2026-12-01'}).status_code==422
        cleared=client.patch(f'/api/projects/work-items/{item_id}',json={'start_date':None})
        assert cleared.status_code==200 and cleared.json()['start_date'] is None

        assert client.patch(f'/api/projects/work-items/{item_id}',json={'status':'invalid'}).status_code==422
        assert client.patch(f'/api/projects/work-items/{item_id}',json={'kind':'task'}).status_code==422
        assert any(w['id']==item_id for w in client.get('/api/projects/context',params={'project_id':first}).json()['portfolio']['work_items'])
        assert client.delete(f'/api/projects/work-items/{item_id}').status_code==200
        assert client.delete(f'/api/projects/work-items/{item_id}').status_code==404
    assert client.post('/api/projects/work-items',json={'project_id':first,'kind':'task','title':' ','owner_id':prefix+'member'}).status_code==422
    assert client.post('/api/projects/work-items',json={'project_id':first,'kind':'task','title':'Invalid owner','owner_id':prefix+'local'}).status_code==422
    assert client.post('/api/projects/work-items',json={'project_id':first,'kind':'risk','title':'Invalid status','status':'done'}).status_code==422
    # New planning and governance validation, including stale forms and unchanged records.
    current = next(p for p in client.get('/api/projects').json()['projects'] if p['id']==first)
    assert client.post('/api/projects/impact/preview',json={'kind':'project_change','project_id':first,'status':'paused','expected_revision':current['revision']-1}).status_code==409
    assert client.post('/api/projects/impact/preview',json={'kind':'project_change','project_id':first,'status':'paused'}).status_code==200
    assert raw_patch(f'/api/projects/projects/{first}',json={'name':'Missing revision'}).status_code==422
    assert raw_patch(f'/api/projects/projects/{first}',json={'expected_revision':current['revision']-1,'name':'Stale'}).status_code==409
    milestone = client.post('/api/projects/work-items',json={'project_id':first,'kind':'milestone','title':'Gate','due_date':'2027-01-20'}).json()
    assert milestone['revision']==1
    assert client.post('/api/projects/work-items',json={'project_id':first,'kind':'milestone','title':'Undated'}).status_code==422
    child = client.post('/api/projects/work-items',json={'project_id':first,'kind':'task','title':'Child','parent_id':milestone['id'],'predecessor_ids':[milestone['id']]}).json()
    assert child['predecessor_ids']==[milestone['id']]
    assert client.patch(f"/api/projects/work-items/{milestone['id']}",json={'parent_id':child['id']}).status_code==422
    assert client.patch(f"/api/projects/work-items/{milestone['id']}",json={'predecessor_ids':[child['id']]}).status_code==422
    assert client.post('/api/projects/work-items',json={'project_id':second,'kind':'task','title':'Cross project','parent_id':milestone['id']}).status_code==422
    product = client.post('/api/projects/work-items',json={'project_id':first,'kind':'deliverable','title':'Product'}).json()
    assert client.patch(f"/api/projects/work-items/{product['id']}",json={'status':'accepted'}).status_code==422
    accepted = client.patch(f"/api/projects/work-items/{product['id']}",json={'status':'accepted','acceptance_criteria':'Reviewed criteria','reviewer_id':prefix+'admin','acceptance_evidence':'Recorded review'})
    assert accepted.status_code==200,accepted.text
    assert accepted.json()['revision']==2
    assert raw_patch(f"/api/projects/work-items/{product['id']}",json={'expected_revision':1,'title':'Stale'}).status_code==409
    approval = client.post(f'/api/projects/projects/{first}/stage-approvals',json={'expected_revision':current['revision'],'stage':'initiation','approver_id':prefix+'admin','decision':'approved','evidence':'Review record'})
    assert client.post(f'/api/projects/projects/{first}/stage-approvals',json={'expected_revision':current['revision'],'stage':'planning','approver_id':prefix+'admin','decision':'approved','evidence':'Wrong stage'}).status_code==422
    assert approval.status_code==201,approval.text
    assert approval.json()['project_revision']==current['revision']
    unchanged = client.post('/api/projects/impact/apply',json={'kind':'project_change','project_id':first,'status':current['status'],'expected_revision':current['revision']})
    assert unchanged.status_code==200,unchanged.text
    assert next(p for p in unchanged.json()['portfolio']['projects'] if p['id']==first)['revision']==current['revision']
    assert client.post('/api/projects/impact/apply',json={'kind':'project_change','project_id':first,'status':'paused'}).status_code==422
    assert client.post('/api/projects/impact/apply',json={'kind':'project_change','project_id':first,'status':'paused','expected_revision':current['revision']-1}).status_code==409
    for item in (child, milestone, product):
        assert client.delete(f"/api/projects/work-items/{item['id']}").status_code==200
    owned = client.post('/api/projects/work-items',json={'project_id':second,'kind':'task','title':'Owner access','owner_id':prefix+'other'}).json()
    private = client.post('/api/projects/work-items',json={'project_id':hidden,'kind':'task','title':'Hidden work'}).json()
    assert owned['id'] and private['id']
    change={'kind':'person_departure','person_id':prefix+'member','status':'departed'}
    before = client.get('/api/projects').json()
    preview=client.post('/api/projects/impact/preview',json=change)
    assert preview.status_code == 200, preview.text
    assert preview.json()['summary'] == {'confirmed':1,'risks':2,'affected_projects':3}
    after = client.get('/api/projects').json()
    assert len(before['events']) == len(after['events'])
    assert next(p for p in after['people'] if p['id']==prefix+'member')['status']=='active'
    applied=client.post('/api/projects/impact/apply',json=change)
    assert applied.status_code == 200, applied.text
    assert applied.json()['impact']['summary']['confirmed']==1
    assert len(applied.json()['portfolio']['events'])==len(after['events'])+1
    context=client.get('/api/projects/context',params={'project_id':first}).json()['portfolio']
    assert context['impact']['summary']['affected_projects']==1
    assert {p['id'] for p in context['people']} == {prefix+'member',prefix+'admin'}
    actor.update(username=prefix+'member',is_admin=False)
    scoped=client.get('/api/projects').json()
    assert [p['id'] for p in scoped['projects']]==[first]
    assert scoped['dependencies']==[] and scoped['events']==[]
    assert scoped['recent_change_impacts'][0]['impact']['summary']['affected_projects']==1
    assert all(set(item['path'])=={first} for item in scoped['recent_change_impacts'][0]['impact']['items'])
    assert scoped['impact']['summary']=={'confirmed':1,'risks':0,'affected_projects':1}
    assert client.get('/api/projects/context',params={'project_id':hidden}).status_code==404
    assert client.post('/api/projects/projects',json={'name':'Forbidden'}).status_code==403
    assert all(w['project_id']==first for w in scoped['work_items'])
    assert client.post('/api/projects/work-items',json={'project_id':first,'kind':'task','title':'Forbidden'}).status_code==403
    actor.update(username=prefix+'other',is_admin=False)
    own_scope=client.get('/api/projects').json()
    assert [p['id'] for p in own_scope['projects']]==[second]
    assert [w['id'] for w in own_scope['work_items']]==[owned['id']]
    assert own_scope['work_items'][0]['can_update'] is True
    own_updated=client.patch(f"/api/projects/work-items/{owned['id']}",json={'status':'in_progress','resolution':'Owner progress update'})
    assert own_updated.status_code==200,own_updated.text
    assert own_updated.json()['status']=='in_progress'
    for forbidden in [{'start_date':'2027-01-01'},{'owner_id':prefix+'admin'},{'title':'Escalation'},{'due_date':None},{'priority':'high'}]:
        assert client.patch(f"/api/projects/work-items/{owned['id']}",json=forbidden).status_code==403
    assert client.delete(f"/api/projects/work-items/{owned['id']}").status_code==403
    assert client.patch(f"/api/projects/work-items/{private['id']}",json={'status':'done'}).status_code==403
    actor.update(username=prefix+'member',is_admin=False)
    assert client.patch(f"/api/projects/work-items/{owned['id']}",json={'status':'done'}).status_code==403

    assert own_scope['dependencies']==[]
    assert client.get('/api/projects/context',params={'project_id':hidden}).status_code==404
    actor.update(username=prefix+'local',is_admin=False)
    assert client.get('/api/projects').status_code==403
    actor.update(username=prefix+'admin',is_admin=True)
    assert client.post('/api/projects/projects',headers={'Origin':'https://evil.invalid'},json={'name':'Forbidden'}).status_code==403
    print('Projects HTTP integration: directory identity, CRUD, graph, preview nonmutation, atomic apply, scoped access, context, CSRF passed')
finally:
    conn.rollback()
    conn.close()
