"""Synthetic templates in a disposable database schema; real auth and persistence."""
import json
import os
import secrets
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from fastapi.testclient import TestClient
from app import auth, postgres_storage as storage
from app.main import app
from app.presentation import PresentationTemplateCreate


def main():
    original = os.environ['DATABASE_URL']
    schema = 'template_studio_test_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_LOCAL_LOGIN_ENABLED': '1', 'BOB_FILE_STORAGE': 'postgres', 'BOB_UI_SECURE_COOKIE': '0'}):
            password = secrets.token_urlsafe(24)
            auth.create_user('templateowner', password)
            auth.create_user('templateother', password)
            config = {'title':'Synthetic saved template', 'brand':'Test fixture', 'colors':{'primary':'#137A52','secondary':'#E7F4ED','accent':'#E8AE36','background':'#FFFFFF','text':'#172A21'}, 'fonts':{'heading':'Arial','body':'Calibri'}, 'design':{'shape':'ellipse','decoration':'topbar','cardBorderWidth':2}}
            config = PresentationTemplateCreate(**config).model_dump()
            with TestClient(app) as owner, TestClient(app) as other, TestClient(app) as anonymous:
                for client, name in [(owner,'templateowner'), (other,'templateother')]:
                    assert client.post('/auth/login', json={'username':name,'password':password}).status_code == 200
                assert anonymous.post('/presentation/templates', json=config).status_code == 401
                assert owner.post('/presentation/templates', json={**config,'design':{'shape':'invalid'}}).status_code == 422
                response = owner.post('/presentation/templates', json=config)
                assert response.status_code == 201, response.text
                item = response.json(); path = '/presentation/templates/' + item['id']
                assert owner.get(path).json()['metadata']['studioConfig'] == config
                assert other.get(path).status_code == 404
                assert item in owner.get('/presentation/templates').json()
                assert item not in other.get('/presentation/templates').json()
                assert item in owner.post('/presentation/intent', json={'prompt':'Create a presentation','mode':'agent'}).json()['templates']
                # Draft loading uses the current conversation owner's authenticated scope.
                storage.put_file('templateowner', 'session:legacy', 'studio.presentation-template.json', json.dumps(config).encode())
                storage.put_file('templateowner', 'session:legacy', 'invalid.presentation-template.json', b'{broken}')
                drafts = owner.get('/presentation/template-drafts?session_id=legacy')
                assert drafts.status_code == 200, drafts.text
                assert drafts.json() == [{'path':'studio.presentation-template.json','config':config}], drafts.text
                assert other.get('/presentation/template-drafts?session_id=legacy').json() == []
                assert owner.get('/presentation/template-drafts?session_id=../invalid').status_code == 422
            with TestClient(app) as fresh:
                assert fresh.post('/auth/login', json={'username':'templateowner','password':password}).status_code == 200
                assert item in fresh.get('/presentation/templates').json(), 'Templates must survive fresh sessions'
            print('Template catalog HTTP integration passed: real authentication, durable save/reload, owner isolation, contextual catalog, validated draft loading.')
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))

if __name__ == '__main__':
    main()
