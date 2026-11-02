"""Comprehensive unit tests covering app/mcp_catalog.py."""
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, Response
from pydantic import ValidationError

from app import mcp_catalog


class MCPCatalogCoverageTests(unittest.TestCase):
    def setUp(self):
        self.admin = {'username': 'alice', 'is_admin': True}
        self.user = {'username': 'bob', 'is_admin': False}

    def test_credential_field_validations(self):
        # Invalid env target name
        with self.assertRaises(ValidationError):
            mcp_catalog.CredentialField(key='k', label='L', location='env', target='123_BAD')
        # Invalid header target name
        with self.assertRaises(ValidationError):
            mcp_catalog.CredentialField(key='k', label='L', location='header', target='Bad Header Space')
        # Prefix with newline
        with self.assertRaises(ValidationError):
            mcp_catalog.CredentialField(key='k', label='L', location='header', target='Auth', prefix='Prefix\n')

        # Valid field
        f = mcp_catalog.CredentialField(key='tok', label='Token', location='header', target='Authorization', prefix='Bearer ')
        self.assertEqual(f.key, 'tok')

    def test_template_validations(self):
        base = {
            'id': 'my-server',
            'name': 'My Server',
            'transport': 'http',
            'url': 'https://example.com/mcp',
        }
        # Keycloak requires specific fields
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**base, 'auth_mode': 'keycloak'})

        # Keycloak invalid url (not https or realm)
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(
                id='keycloak', name='KC', transport='stdio', command='python3',
                args=['-m', 'app.mcp_keycloak'], auth_mode='keycloak',
                url='http://bad.com',
            )

        # Valid keycloak template
        kc = mcp_catalog.Template(
            id='keycloak', name='KC', transport='stdio', command='python3',
            args=['-m', 'app.mcp_keycloak'], auth_mode='keycloak',
            url='https://sso.example.com/auth/realms/master',
        )
        self.assertEqual(kc.id, 'keycloak')

        # OAuth token auth method requires client secret env
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**base, 'auth_mode': 'oauth', 'oauth_token_auth_method': 'client_secret_post', 'oauth_client_secret_env': ''})

        # OAuth with fields rejected
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**base, 'auth_mode': 'oauth', 'fields': [mcp_catalog.CredentialField(key='t', label='T', target='H')]})

        # OAuth non-http transport rejected
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(id='srv', name='Srv', auth_mode='oauth', transport='stdio', command='python3')

        # Docs url non-https
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**base, 'docs_url': 'http://insecure.example.com'})

        # Stdio empty command
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(id='srv', name='Srv', transport='stdio', command='   ')

        # Duplicate field keys
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{
                **base,
                'fields': [
                    mcp_catalog.CredentialField(key='k', label='L1', target='H1'),
                    mcp_catalog.CredentialField(key='k', label='L2', target='H2'),
                ]
            })

        # Duplicate field targets
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{
                **base,
                'fields': [
                    mcp_catalog.CredentialField(key='k1', label='L1', target='H1'),
                    mcp_catalog.CredentialField(key='k2', label='L2', target='h1'),
                ]
            })

        # Invalid username in users list
        with self.assertRaises(ValidationError):
            mcp_catalog.Template(**{**base, 'users': ['BAD USER!!']})

    def test_ensure_schema(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(mcp_catalog, '_connect', mock_conn), patch.dict(os.environ, {'DATABASE_URL': 'postgres://fake'}):
            mcp_catalog._schema_database = None
            mcp_catalog.ensure_schema()
            self.assertEqual(mcp_catalog._schema_database, 'postgres://fake')
            self.assertGreater(db.execute.call_count, 1)

    def test_permitted_and_access_groups(self):
        # item disabled or None profile
        self.assertFalse(mcp_catalog.permitted({'enabled': False}, self.admin, 'alice'))
        self.assertFalse(mcp_catalog.permitted({'enabled': True}, None, 'alice'))

        # access_groups
        item_grants = {'access_mode': 'grants', 'groups': ['group-id', 'company']}
        self.assertEqual(mcp_catalog.access_groups(item_grants), ['group-id', 'company'])

        item_users = {'access_mode': 'users', 'users': ['alice']}
        self.assertEqual(mcp_catalog.access_groups(item_users), [])

        item_group = {'access_mode': 'groups', 'knowledge_base': 'company', 'audience': 'group-id'}
        self.assertEqual(mcp_catalog.access_groups(item_group), ['group-id'])

        item_company_both = {'access_mode': 'groups', 'knowledge_base': 'company', 'audience': 'both'}
        self.assertEqual(mcp_catalog.access_groups(item_company_both), ['company'])

    def test_assemble_branches(self):
        # Missing URL for non-stdio
        with self.assertRaises(ValueError):
            mcp_catalog.assemble({'id': 's', 'name': 'S', 'transport': 'http', 'url': ''}, {})

        template_item = {
            'id': 's',
            'name': 'S',
            'transport': 'http',
            'url': 'https://example.com/mcp',
            'fields': [
                {'key': 'token', 'label': 'Token', 'location': 'header', 'target': 'Authorization', 'prefix': 'Bearer ', 'required': True},
            ]
        }
        # Unknown credential
        with self.assertRaises(ValueError):
            mcp_catalog.assemble(template_item, {'token': 'val', 'extra': 'bad'})

        # Missing required field
        with self.assertRaises(ValueError):
            mcp_catalog.assemble(template_item, {'token': '   '})

        # Credential too long
        with self.assertRaises(ValueError):
            mcp_catalog.assemble(template_item, {'token': 'x' * 9000})

        # Newline in header value
        with self.assertRaises(ValueError):
            mcp_catalog.assemble(template_item, {'token': 'val\nnewline'})

        # Success
        cfg = mcp_catalog.assemble(template_item, {'token': 'secret123'})
        self.assertEqual(cfg['headers']['Authorization'], 'Bearer secret123')

    def test_microsoft_connected_and_native_policy_active(self):
        with patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test.json')), \
             patch('app.postgres_storage.read_user_file', return_value=b'{"access_token": "token123"}'):
            self.assertTrue(mcp_catalog.microsoft_connected('alice'))

        with patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test.json')), \
             patch('app.postgres_storage.read_user_file', return_value=b'invalid json'):
            self.assertFalse(mcp_catalog.microsoft_connected('alice'))

        with patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test.json')), \
             patch('app.postgres_storage.read_user_file', return_value=None):
            self.assertFalse(mcp_catalog.microsoft_connected('alice'))

        # native_policy_active offline
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(mcp_catalog.native_policy_active())

        # native_policy_active with DB
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch.object(mcp_catalog, '_connect', mock_conn), patch.object(mcp_catalog, 'ensure_schema'), patch.dict(os.environ, {'DATABASE_URL': 'postgres://user:pass@localhost:5432/db'}):
            db.execute.return_value.fetchone.return_value = [{'native_policy_active': True}]
            self.assertTrue(mcp_catalog.native_policy_active())

    def test_allowed_connections(self):
        # Offline returns empty dict
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(mcp_catalog.allowed_connections('alice'), {})

        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        ms_def = {'id': 'microsoft365', 'name': 'MS', 'auth_mode': 'microsoft', 'transport': 'stdio', 'command': 'python3', 'args': ['-m', 'app.mcp_microsoft'], 'enabled': True}
        oauth_def = {'id': 'docmost', 'name': 'Docmost', 'auth_mode': 'oauth', 'transport': 'http', 'url': 'https://docmost.example.com/mcp', 'enabled': True}
        cred_def = {'id': 'github', 'name': 'GitHub', 'auth_mode': 'credentials', 'transport': 'http', 'url': 'https://api.github.com/mcp', 'enabled': True, 'fields': [{'key': 'token', 'label': 'Tok', 'location': 'header', 'target': 'Auth'}]}

        rows = [
            ('microsoft365', ms_def, None),
            ('docmost', oauth_def, None),
            ('github', cred_def, {'token': 'mytoken'}),
        ]

        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch.object(mcp_catalog, 'permitted', return_value=True), \
             patch.object(mcp_catalog, 'microsoft_connected', return_value=True), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test.json')), \
             patch('app.mcp_oauth.ensure_schema'), \
             patch('app.mcp_oauth.access_token', return_value='oauth_token_val'), \
             patch.dict(os.environ, {'DATABASE_URL': 'postgres://user:pass@localhost:5432/db'}):

            db.execute.side_effect = [
                MagicMock(fetchall=lambda: rows), # initial fetch
                MagicMock(fetchall=lambda: [('docmost',)]), # oauth_ids fetch
            ]
            conns = mcp_catalog.allowed_connections('alice', self.admin)
            self.assertIn('microsoft365', conns)
            self.assertIn('catalog-docmost', conns)
            self.assertIn('catalog-github', conns)

    def test_catalog_listing(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        items = [
            ({'id': 'gh', 'name': 'GitHub', 'transport': 'http', 'url': 'https://api.github.com/mcp', 'auth_mode': 'credentials', 'enabled': True, 'fields': []}, None),
            ({'id': 'microsoft365', 'name': 'MS365', 'auth_mode': 'microsoft', 'transport': 'stdio', 'command': 'python3', 'args': ['-m', 'app.mcp_microsoft'], 'enabled': True, 'fields': []}, 'microsoft365'),
        ]
        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_catalog.knowledge_access', return_value=self.admin), \
             patch('app.mcp_access.configured_providers', return_value=set()), \
             patch.object(mcp_catalog, 'permitted', return_value=True), \
             patch.object(mcp_catalog, 'microsoft_connected', return_value=True):

            db.execute.return_value.fetchall.return_value = items
            cat = mcp_catalog.catalog('alice', admin=True)
            self.assertEqual(len(cat), 2)
            self.assertTrue(cat[1]['connected'])

    def test_save_template_and_save_access(self):
        tmpl = mcp_catalog.Template(id='custom', name='Custom', transport='http', url='https://custom.example.com/mcp', users=['bob'])

        # User check fail
        db1 = MagicMock()
        @contextmanager
        def mock_conn1():
            yield db1

        with patch.object(mcp_catalog, '_connect', mock_conn1), patch.object(mcp_catalog, 'ensure_schema'), patch('app.mcp_oauth.ensure_schema'):
            db1.execute.return_value.fetchall.return_value = []
            with self.assertRaises(ValueError):
                mcp_catalog.save_template(tmpl, 'alice')

        # Success with previous template invalidate
        db2 = MagicMock()
        @contextmanager
        def mock_conn2():
            yield db2

        with patch.object(mcp_catalog, '_connect', mock_conn2), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_oauth.ensure_schema'), \
             patch('app.mcp_oauth.invalidate_template'):
            db2.execute.side_effect = [
                MagicMock(fetchall=lambda: [('bob',)]), # user exists
                MagicMock(fetchone=lambda: [{'id': 'custom', 'name': 'Old', 'transport': 'http', 'url': 'https://old.example.com/mcp'}]), # previous
                MagicMock(), # delete connections
                MagicMock(), # upsert template
                MagicMock(), # audit
            ]
            res = mcp_catalog.save_template(tmpl, 'alice')
            self.assertEqual(res['id'], 'custom')

        # save_access not found
        db3 = MagicMock()
        @contextmanager
        def mock_conn3():
            yield db3

        with patch.object(mcp_catalog, '_connect', mock_conn3), patch.object(mcp_catalog, 'ensure_schema'):
            db3.execute.return_value.fetchone.return_value = None
            with self.assertRaises(HTTPException) as exc:
                mcp_catalog.save_access('unknown', mcp_catalog.AccessUpdate(groups=['11111111-1111-4111-8111-111111111111']), 'alice')
            self.assertEqual(exc.exception.status_code, 404)

        # save_access success
        db4 = MagicMock()
        @contextmanager
        def mock_conn4():
            yield db4

        with patch.object(mcp_catalog, '_connect', mock_conn4), patch.object(mcp_catalog, 'ensure_schema'):
            prev_def = tmpl.model_dump()
            db4.execute.side_effect = [
                MagicMock(fetchone=lambda: [prev_def]), # previous
                MagicMock(fetchall=lambda: [('bob',)]), # existing users
                MagicMock(), # update
                MagicMock(), # audit
            ]
            res2 = mcp_catalog.save_access('custom', mcp_catalog.AccessUpdate(users=['bob'], groups=['11111111-1111-4111-8111-111111111111']), 'alice')
            self.assertEqual(res2['id'], 'custom')

    def test_connect_function(self):
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        # Not found or not permitted
        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_catalog.knowledge_access', return_value=self.user), \
             patch.object(mcp_catalog, 'permitted', return_value=False):
            db.execute.return_value.fetchone.return_value = [{'auth_mode': 'credentials'}]
            with self.assertRaises(HTTPException) as exc:
                mcp_catalog.connect('bob', 'server', {})
            self.assertEqual(exc.exception.status_code, 404)

        # OAuth mode error
        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_catalog.knowledge_access', return_value=self.user), \
             patch.object(mcp_catalog, 'permitted', return_value=True):
            db.execute.return_value.fetchone.return_value = [{'auth_mode': 'oauth', 'fields': []}]
            with self.assertRaises(ValueError):
                mcp_catalog.connect('bob', 'server', {})

        # Microsoft mode error
        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_catalog.knowledge_access', return_value=self.user), \
             patch.object(mcp_catalog, 'permitted', return_value=True):
            db.execute.return_value.fetchone.return_value = [{'auth_mode': 'microsoft', 'fields': []}]
            with self.assertRaises(ValueError):
                mcp_catalog.connect('bob', 'server', {})

        # Success connect
        tmpl_def = {
            'id': 'github',
            'name': 'GitHub',
            'auth_mode': 'credentials',
            'transport': 'http',
            'url': 'https://api.github.com/mcp',
            'fields': [{'key': 'token', 'label': 'Tok', 'location': 'header', 'target': 'Authorization', 'prefix': 'Bearer '}]
        }
        with patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.mcp_catalog.knowledge_access', return_value=self.user), \
             patch.object(mcp_catalog, 'permitted', return_value=True):
            db.execute.side_effect = [
                MagicMock(fetchone=lambda: [tmpl_def]), # select def
                MagicMock(fetchone=lambda: None), # select old creds
                MagicMock(), # insert
            ]
            res = mcp_catalog.connect('bob', 'github', {'token': 'mytoken'})
            self.assertTrue(res['connected'])
            self.assertEqual(res['server_name'], 'catalog-github')

    def test_router_handlers(self):
        # list_catalog
        res = Response()
        with patch('app.mcp_catalog.catalog', return_value=[]):
            out = asyncio.run(mcp_catalog.list_catalog(res, self.admin))
            self.assertEqual(out, [])
            self.assertEqual(res.headers.get('cache-control'), 'no-store')

        # put_template non-admin
        with self.assertRaises(HTTPException) as exc:
            asyncio.run(mcp_catalog.put_template('id1', MagicMock(id='id1'), self.user))
        self.assertEqual(exc.exception.status_code, 403)

        # put_template id mismatch
        with self.assertRaises(HTTPException) as exc2:
            asyncio.run(mcp_catalog.put_template('id1', MagicMock(id='id2'), self.admin))
        self.assertEqual(exc2.exception.status_code, 422)

        # connect_template
        with patch('app.mcp_catalog.connect', return_value={'connected': True}):
            out = asyncio.run(mcp_catalog.connect_template('id1', mcp_catalog.ConnectRequest(credentials={}), self.user))
            self.assertTrue(out['connected'])

        # assign_access non-admin
        with self.assertRaises(HTTPException) as exc3:
            asyncio.run(mcp_catalog.assign_access('id1', mcp_catalog.AccessUpdate(), self.user))
        self.assertEqual(exc3.exception.status_code, 403)

        # disconnect_template
        db = MagicMock()
        @contextmanager
        def mock_conn():
            yield db

        with patch('app.mcp_oauth.disconnect'), \
             patch.object(mcp_catalog, '_connect', mock_conn), \
             patch.object(mcp_catalog, 'ensure_schema'), \
             patch('app.microsoft_auth._user_token_file', return_value=Path('/tmp/test.json')), \
             patch('app.postgres_storage.remove_user_file'):
            asyncio.run(mcp_catalog.disconnect_template('microsoft365', self.admin))
            self.assertEqual(db.execute.call_count, 1)

        # check_template not found
        with patch.object(mcp_catalog, 'allowed_connections', return_value={}):
            with self.assertRaises(HTTPException) as exc4:
                asyncio.run(mcp_catalog.check_template('id1', self.admin))
            self.assertEqual(exc4.exception.status_code, 404)

        # check_template found
        with patch.object(mcp_catalog, 'allowed_connections', return_value={'catalog-id1': {'command': 'test'}}), \
             patch('app.mcp_health.probe_mcp', return_value={'healthy': True}):
            res_chk = asyncio.run(mcp_catalog.check_template('id1', self.admin))
            self.assertEqual(res_chk, {'healthy': True})


if __name__ == '__main__':
    unittest.main()
