"""Feedback HTTP permissions and durable records using an isolated database schema."""
import os
import secrets
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from tests.group_fixtures import make_group
from app import auth, rag, sessions, job_queue, answer_feedback
from app.main import app


def main():
    original = os.environ['DATABASE_URL']
    schema = 'buddy_feedback_http_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED':'1', 'BOB_FILE_STORAGE':'postgres', 'BOB_UI_SECURE_COOKIE':'0'}):
            rag._schema_ready = False
            answer_feedback._ready = False
            password = secrets.token_urlsafe(24)
            for username, admin in [('fixtureadmin',True),('fixtureemployee',False),('fixtureother',False)]:
                auth.create_user(username, password, admin=admin)
            with TestClient(app) as admin, TestClient(app) as employee, TestClient(app) as other, TestClient(app) as anonymous:
                for client in (admin, employee, other, anonymous):
                    client.headers['Origin'] = 'http://testserver'
                for client, username in [(admin,'fixtureadmin'),(employee,'fixtureemployee'),(other,'fixtureother')]:
                    response = client.post('/auth/login', json={'username':username,'password':password})
                    assert response.status_code == 200, response.text
                group_a = make_group('feedback-alpha', 'fixtureemployee')
                group_b = make_group('feedback-beta')
                documents = []
                for audience in [group_a,group_b,'both']:
                    response = admin.post('/knowledge', files={'file':(f'{audience}-fixture.txt',f'Explicit synthetic {audience} policy fixture.'.encode())}, data={'knowledge_base':'company','audience':audience})
                    assert response.status_code == 201, response.text
                    documents.append(response.json())
                buddy, blocked, uncited = documents
                session = sessions.create_session('fixtureemployee')['id']
                text = f"Final fixture answer [source](/knowledge/{buddy['id']}/file) and [restricted](/knowledge/{blocked['id']}/file)"
                def answer(content, terminal=True):
                    sessions.append_history(session,'fixtureemployee',{'type':'request','prompt':'Explicit fixture question'})
                    sessions.append_history(session,'fixtureemployee',{'type':'delta','text':'discarded fixture draft'})
                    sessions.append_history(session,'fixtureemployee',{'type':'delta','text':content,'replace':True})
                    if terminal:
                        sessions.append_history(session,'fixtureemployee',{'type':'done'})
                answer(text)
                args = {'session_id':session,'answer_index':0}
                body = {**args,'category':'outdated_policy','comment':'Review this fixture policy','source_document_id':buddy['id']}
                assert anonymous.post('/feedback',json=body).status_code == 401
                assert other.get('/feedback/answer',params=args).status_code == 404
                assert other.post('/feedback',json=body).status_code == 404
                assert employee.get('/admin/feedback').status_code == 403
                assert employee.get('/admin/feedback/quality').status_code == 403
                assert anonymous.get('/admin/feedback/quality').status_code == 401
                assert employee.patch('/admin/feedback/1',json={'status':'resolved'}).status_code == 403
                preview = employee.get('/feedback/answer',params=args)
                assert preview.status_code == 200, preview.text
                assert [item['id'] for item in preview.json()['sources']] == [buddy['id']]
                for document in [blocked,uncited]:
                    denied = employee.post('/feedback',json={**body,'source_document_id':document['id']})
                    assert denied.status_code == 403, denied.text
                response = employee.post('/feedback',json=body)
                assert response.status_code == 201, response.text
                identifier = response.json()['id']
                assert employee.post('/feedback',json=body).status_code == 409
                assert employee.get('/feedback/answer',params=args).json()['submitted']['id'] == identifier
                with job_queue._connect() as db:
                    saved = db.execute('SELECT * FROM bob_answer_feedback WHERE id=%s',(identifier,)).fetchone()
                    assert saved['answer_text'] == text
                    assert saved['source_filename'] == buddy['filename']
                    assert saved['request_history_id'] is not None
                answer('Second explicit fixture answer')
                second = employee.post('/feedback',json={**body,'answer_index':1,'category':'incorrect_answer','source_document_id':None})
                assert second.status_code == 201, second.text
                inbox = admin.get('/admin/feedback',params={'limit':1,'status':'open'}).json()
                assert len(inbox['items']) == 1 and inbox['next_before_id'] == second.json()['id']
                older = admin.get('/admin/feedback',params={'limit':1,'before_id':inbox['next_before_id']}).json()
                assert older['items'][0]['id'] == identifier and older['next_before_id'] is None
                assert admin.patch(f'/admin/feedback/{identifier}',json={'status':'resolved'}).status_code == 200
                assert admin.get('/admin/feedback',params={'status':'resolved'}).json()['items'][0]['id'] == identifier
                quality_response = admin.get('/admin/feedback/quality', params={'days':7})
                assert quality_response.status_code == 200, quality_response.text
                quality = quality_response.json()
                assert quality['totals'] == {'reports':2,'open':1,'reviewed':0,'resolved':1,'reporters':1}, quality
                assert quality['sources'][0]['reports'] == 1 and quality['sources'][0]['unresolved'] == 0
                assert quality['trend'][0]['reports'] == 2
                assert admin.get('/admin/feedback/quality', params={'days':0}).status_code == 422
                # Historical reports outside the window must not affect any aggregate.
                with job_queue._connect() as db:
                    db.execute("UPDATE bob_answer_feedback SET created_at=now()-interval '40 days' WHERE id=%s", (identifier,))
                recent = admin.get('/admin/feedback/quality', params={'days':7}).json()
                assert recent['totals']['reports'] == 1 and recent['sources'] == []
                assert recent['categories'] == [{'category':'incorrect_answer','reports':1}]
                assert recent['trend'][0]['reports'] == 1
                assert admin.get('/admin/feedback/quality', params={'days':90}).json()['totals']['reports'] == 2
                with auth._connect() as db:
                    audit = db.execute("SELECT details FROM bob_access_audit WHERE action='review-answer-feedback' AND target=%s",(str(identifier),)).fetchone()
                    assert audit[0] == {'before':{'status':'open'},'after':{'status':'resolved'}}
                assert admin.patch('/admin/feedback/99999999',json={'status':'reviewed'}).status_code == 404
                answer('Incomplete fixture answer',False)
                assert employee.post('/feedback',json={**body,'answer_index':2,'source_document_id':None}).status_code == 409
                # The current ACL applies even when the old answer still cites the document.
                assert admin.patch('/knowledge/'+buddy['id'],json={'knowledge_base':'company','audience':group_b}).status_code == 200
                assert employee.get('/feedback/answer',params=args).json()['sources'] == []
                assert employee.post('/feedback',json={**body}).status_code == 403
                print('Feedback HTTP integration passed: real cookies, saved answer snapshots, source ACL, ownership, duplicate protection, admin reviews, pagination and atomic audit.')
    finally:
        answer_feedback._ready = False
        rag._schema_ready = False
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))

if __name__ == '__main__':
    main()
