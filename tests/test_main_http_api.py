"""HTTP contract of app.main: authentication, authorization and error mapping.

All persistence is replaced with mocks and the identity is injected, so no
database or user data is read or written.
"""
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.testclient import TestClient

from app import main

ADMIN = {'username': 'root', 'is_admin': True}
MEMBER = {'username': 'alice', 'is_admin': False}


class MainApiCase(TestCase):
    user = MEMBER

    def setUp(self):
        user = self.user

        async def identity(request=None):
            if user is None:
                raise HTTPException(401, 'Sign in required')
            return user

        # The access-boundary middleware resolves current_user when the stack
        # is built, so rebuild it with the injected identity for each test.
        patcher = patch('app.auth.current_user', identity)
        patcher.start()
        self.addCleanup(patcher.stop)
        main.app.dependency_overrides[main.current_user] = identity
        main.app.middleware_stack = None
        self.addCleanup(setattr, main.app, 'middleware_stack', None)
        self.addCleanup(main.app.dependency_overrides.clear)
        self.http = TestClient(main.app)
        self.addCleanup(self.http.close)


class AnonymousAccessTests(MainApiCase):
    user = None

    def test_protected_routes_reject_anonymous_callers(self):
        for method, path in (('GET', '/sessions'), ('POST', '/sessions'), ('GET', '/auth/users'),
                             ('GET', '/projects'), ('DELETE', '/sessions/abc'),
                             ('GET', '/sessions/abc/history')):
            with self.subTest(route=f'{method} {path}'):
                self.assertEqual(self.http.request(method, path).status_code, 401)

    def test_auth_status_reports_anonymous_state(self):
        with patch.object(main, 'has_users', return_value=True), \
                patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'keycloak_configured', return_value=False):
            body = self.http.get('/auth/status').json()
        self.assertEqual(body, {'setup_required': False, 'user': None,
                                'keycloak_configured': False, 'local_login_enabled': True})

    def test_auth_status_requires_setup_only_for_local_login_without_users(self):
        for local, users, expected in ((True, False, True), (True, True, False), (False, False, False)):
            with self.subTest(local=local, users=users), \
                    patch.object(main, 'has_users', return_value=users), \
                    patch.object(main, 'local_login_enabled', return_value=local), \
                    patch.object(main, 'keycloak_configured', return_value=False):
                self.assertEqual(self.http.get('/auth/status').json()['setup_required'], expected)


class LoginTests(MainApiCase):
    user = None
    credentials = {'username': 'alice', 'password': 'correct horse'}

    def test_local_login_is_refused_when_sso_is_enforced(self):
        with patch.object(main, 'local_login_enabled', return_value=False):
            for path in ('/auth/login', '/auth/setup'):
                with self.subTest(path=path):
                    self.assertEqual(self.http.post(path, json=self.credentials).status_code, 403)

    def test_throttled_login_returns_429_with_retry_after(self):
        throttled = main.LoginThrottled(30)
        with patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'reserve_login_attempt', side_effect=throttled), \
                patch.object(main, 'authenticate') as authenticate:
            response = self.http.post('/auth/login', json=self.credentials)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['retry-after'], '30')
        authenticate.assert_not_called()

    def test_wrong_password_is_401_and_keeps_attempt_budget(self):
        with patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'reserve_login_attempt'), \
                patch.object(main, 'authenticate', return_value=None), \
                patch.object(main, 'clear_account_attempts') as clear:
            response = self.http.post('/auth/login', json=self.credentials)
        self.assertEqual(response.status_code, 401)
        clear.assert_not_called()

    def test_successful_login_clears_attempts_and_starts_session(self):
        with patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'reserve_login_attempt') as reserve, \
                patch.object(main, 'authenticate', return_value=MEMBER), \
                patch.object(main, 'clear_account_attempts') as clear, \
                patch.object(main, 'start_session') as start:
            response = self.http.post('/auth/login', json=self.credentials)
        self.assertEqual(response.json(), MEMBER)
        reserve.assert_called_once_with('alice', 'testclient')
        clear.assert_called_once_with('alice')
        start.assert_called_once()

    def test_credential_length_limits_are_validated(self):
        for payload in ({'username': 'u' * 65, 'password': 'x'}, {'username': 'u', 'password': 'p' * 257},
                        {'username': 'u'}, {}):
            with self.subTest(payload=list(payload)), patch.object(main, 'local_login_enabled', return_value=True):
                self.assertEqual(self.http.post('/auth/login', json=payload).status_code, 422)

    def test_register_guards(self):
        cases = (
            ('sso managed', dict(keycloak=True, local=True, users=True), 403),
            ('local login off', dict(keycloak=False, local=False, users=True), 403),
            ('no admin yet', dict(keycloak=False, local=True, users=False), 409),
        )
        for name, state, status in cases:
            with self.subTest(name), patch.object(main, 'keycloak_configured', return_value=state['keycloak']), \
                    patch.object(main, 'local_login_enabled', return_value=state['local']), \
                    patch.object(main, 'has_users', return_value=state['users']), \
                    patch.object(main, 'create_user') as create:
                self.assertEqual(self.http.post('/auth/register', json=self.credentials).status_code, status)
                create.assert_not_called()

    def test_register_creates_member_and_session(self):
        with patch.object(main, 'keycloak_configured', return_value=False), \
                patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'has_users', return_value=True), \
                patch.object(main, 'create_user', return_value=MEMBER) as create, \
                patch.object(main, 'user_root') as root, patch.object(main, 'start_session') as start:
            response = self.http.post('/auth/register', json=self.credentials)
        self.assertEqual(response.status_code, 201)
        create.assert_called_once_with('alice', 'correct horse')
        root.assert_called_once_with('alice', create=True)
        start.assert_called_once()

    def test_register_maps_validation_errors_to_400(self):
        with patch.object(main, 'keycloak_configured', return_value=False), \
                patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'has_users', return_value=True), \
                patch.object(main, 'create_user', side_effect=ValueError('Username taken')):
            response = self.http.post('/auth/register', json=self.credentials)
        self.assertEqual((response.status_code, response.json()['detail']), (400, 'Username taken'))

    def test_first_admin_setup(self):
        with patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'create_user', return_value=ADMIN) as create, \
                patch.object(main, 'user_root'), patch.object(main, 'start_session') as start, \
                patch.dict('os.environ', {'BOB_WORKSPACE': '/nonexistent-workspace'}):
            response = self.http.post('/auth/setup', json={'username': 'root', 'password': 'pw'})
        self.assertEqual(response.json(), ADMIN)
        create.assert_called_once_with('root', 'pw', admin=True, setup=True)
        start.assert_called_once()

    def test_setup_error_is_400(self):
        with patch.object(main, 'local_login_enabled', return_value=True), \
                patch.object(main, 'create_user', side_effect=ValueError('already configured')):
            response = self.http.post('/auth/setup', json={'username': 'root', 'password': 'pw'})
        self.assertEqual(response.status_code, 400)

    def test_logout_ends_session_for_anyone(self):
        with patch.object(main, 'end_session') as end:
            self.assertEqual(self.http.post('/auth/logout').json(), {'ok': True})
        end.assert_called_once()


class UserAdministrationTests(MainApiCase):
    def test_member_cannot_list_or_create_users(self):
        with patch.object(main, 'list_users') as listing, patch.object(main, 'create_user') as create:
            self.assertEqual(self.http.get('/auth/users').status_code, 403)
            response = self.http.post('/auth/users', json={'username': 'bob', 'password': 'pw'})
        self.assertEqual(response.status_code, 403)
        listing.assert_not_called()
        create.assert_not_called()


class AdministratorTests(MainApiCase):
    user = ADMIN

    def test_admin_lists_users(self):
        with patch.object(main, 'list_users', return_value=[ADMIN, MEMBER]):
            self.assertEqual(self.http.get('/auth/users').json(), [ADMIN, MEMBER])

    def test_admin_creates_user_and_workspace(self):
        with patch.object(main, 'create_user', return_value=MEMBER), patch.object(main, 'user_root') as root:
            response = self.http.post('/auth/users', json={'username': 'alice', 'password': 'pw'})
        self.assertEqual((response.status_code, response.json()), (201, MEMBER))
        root.assert_called_once_with('alice', create=True)

    def test_admin_create_duplicate_is_400(self):
        with patch.object(main, 'create_user', side_effect=ValueError('exists')):
            self.assertEqual(self.http.post('/auth/users', json={'username': 'a', 'password': 'p'}).status_code, 400)


class SessionTests(MainApiCase):
    def test_list_hides_deleted_and_flags_pending_deletions(self):
        stored = [{'id': 'a', 'title': 'kept'}, {'id': 'b', 'title': 'gone'}, {'id': 'c', 'title': 'pending'}]
        states = {'b': {'status': 'deleted'}, 'c': {'status': 'deleting'},
                  'd': {'status': 'deleting', 'project_id': 'p1'}, 'e': {'status': 'deleting', 'project_id': 'other'}}
        with patch.object(main.job_queue, 'deletion_states', return_value=states), \
                patch.object(main, 'list_sessions', return_value=stored) as listing:
            records = self.http.get('/sessions', params={'project_id': 'p1'}).json()
        listing.assert_called_once_with('alice', 'p1')
        by_id = {item['id']: item for item in records}
        self.assertEqual(set(by_id), {'a', 'c', 'd'})
        self.assertNotIn('deletion_pending', by_id['a'])
        self.assertTrue(by_id['c']['deletion_pending'])
        self.assertEqual(by_id['d']['title'], 'Deletion pending')

    def test_create_session_is_scoped_to_caller(self):
        with patch.object(main, 'create_session', return_value={'id': 's1'}) as create:
            response = self.http.post('/sessions')
        self.assertEqual((response.status_code, response.json()), (201, {'id': 's1'}))
        create.assert_called_once_with('alice', None)

    def test_delete_success_merges_result(self):
        with patch.object(main, 'delete_conversation', return_value={'files': 2}) as delete:
            response = self.http.delete('/sessions/s1')
        self.assertEqual(response.json(), {'deleted': True, 'files': 2})
        delete.assert_called_once_with('alice', 's1')

    def test_delete_error_mapping(self):
        cases = (
            (FileNotFoundError(), 404, 'Conversation not found'),
            (ValueError('Conversation is active'), 409, 'Conversation is active'),
            (ValueError('bad id'), 400, 'bad id'),
            (RuntimeError('database down'), 503, None),
        )
        for error, status, detail in cases:
            with self.subTest(error=type(error).__name__, status=status), \
                    patch.object(main, 'delete_conversation', side_effect=error), \
                    self.assertLogs(main.logger, level='ERROR') if status == 503 else patch.object(main, 'logger'):
                response = self.http.delete('/sessions/s1')
            self.assertEqual(response.status_code, status)
            if detail:
                self.assertEqual(response.json()['detail'], detail)
            else:
                self.assertNotIn('database down', response.text)

    def test_history_hides_missing_or_foreign_conversations(self):
        for error in (ValueError('foreign'), FileNotFoundError()):
            with self.subTest(error=type(error).__name__), patch.object(main, 'read_history', side_effect=error):
                response = self.http.get('/sessions/s1/history')
            self.assertEqual((response.status_code, response.json()['detail']), (404, 'Conversation not found'))

    def test_history_returns_messages(self):
        with patch.object(main, 'read_history', return_value=[{'role': 'user'}]) as read:
            self.assertEqual(self.http.get('/sessions/s1/history').json(), [{'role': 'user'}])
        read.assert_called_once_with('s1', 'alice')


class ProjectTests(MainApiCase):
    def test_list_returns_json_with_vary_header(self):
        with patch.object(main.project_store, 'list_projects', return_value=[{'id': 'p'}]) as listing:
            response = self.http.get('/projects')
        self.assertEqual(response.json(), [{'id': 'p'}])
        self.assertEqual(response.headers['vary'], 'Accept')
        listing.assert_called_once_with('alice')

    def test_browser_navigation_gets_the_app_shell(self):
        shell = main.JSONResponse({'shell': True})
        with patch.object(main, 'root', AsyncMock(return_value=shell)), \
                patch.object(main.project_store, 'list_projects') as listing:
            response = self.http.get('/projects/', headers={'accept': 'text/html'})
        self.assertEqual(response.json(), {'shell': True})
        self.assertEqual(response.headers['vary'], 'Accept')
        listing.assert_not_called()

    def test_create_project_selects_source_kind(self):
        for body, kind in (({'name': 'empty'}, 'empty'), ({'name': 'repo', 'url': 'https://example.com/r.git'}, 'git')):
            with self.subTest(kind=kind), patch.object(main.project_store, 'create_project', return_value={'id': 'p'}) as create:
                response = self.http.post('/projects', json=body)
            self.assertEqual(response.status_code, 201)
            self.assertEqual(create.call_args.args[:3], ('alice', body['name'], kind))

    def test_project_name_validation(self):
        for body in ({}, {'name': ''}, {'name': 'n' * 101}, {'name': 'ok', 'url': 'u' * 2001}):
            with self.subTest(body=list(body)):
                self.assertEqual(self.http.post('/projects', json=body).status_code, 422)

    def test_upload_enforces_size_limit(self):
        with patch.object(main.project_store, 'MAX_ZIP', 8), \
                patch.object(main.project_store, 'create_project') as create:
            response = self.http.post('/projects/upload', params={'name': 'big'}, content=b'x' * 9)
        self.assertEqual(response.status_code, 413)
        create.assert_not_called()

    def test_upload_passes_archive_to_store(self):
        with patch.object(main.project_store, 'create_project', return_value={'id': 'p'}) as create:
            response = self.http.post('/projects/upload', params={'name': 'zipped'}, content=b'PK-data')
        self.assertEqual(response.status_code, 201)
        create.assert_called_once_with('alice', 'zipped', 'zip', data=b'PK-data')

    def test_file_read_write_and_download_use_callers_namespace(self):
        store = main.project_store
        with patch.object(store, 'stored_files', return_value=['a.txt']) as files, \
                patch.object(store, 'stored_read_file', return_value={'content': 'x'}) as read, \
                patch.object(store, 'stored_edit_file', return_value={'saved': True}) as edit, \
                patch.object(store, 'stored_changes', return_value=[]) as changes, \
                patch.object(store, 'stored_download', return_value=b'zip') as download:
            self.assertEqual(self.http.get('/projects/p1/files').json(), ['a.txt'])
            self.assertEqual(self.http.get('/projects/p1/file', params={'path': 'a.txt'}).json(), {'content': 'x'})
            self.assertEqual(self.http.put('/projects/p1/file', json={'path': 'a.txt', 'content': 'new', 'original': 'old'}).json(), {'saved': True})
            self.assertEqual(self.http.get('/projects/p1/changes').json(), [])
            archive = self.http.get('/projects/p1/download', headers={'X-Personal-Data-Confirmed': '1'})
        for mock in (files, read, edit, changes, download):
            self.assertEqual(mock.call_args.args[:2], ('alice', 'p1'))
        edit.assert_called_once_with('alice', 'p1', 'a.txt', 'new', 'old')
        self.assertEqual((archive.content, archive.headers['content-type']), (b'zip', 'application/zip'))

    def test_save_file_rejects_oversized_or_incomplete_payloads(self):
        with patch.object(main.project_store, 'stored_edit_file') as edit:
            too_large = {'path': 'a', 'content': 'x' * (1024 * 1024 + 1), 'original': ''}
            self.assertEqual(self.http.put('/projects/p/file', json=too_large).status_code, 422)
            self.assertEqual(self.http.put('/projects/p/file', json={'path': 'a'}).status_code, 422)
        edit.assert_not_called()

    def test_multibyte_content_over_limit_is_413(self):
        text = '€' * (1024 * 1024 // 3 + 1)  # under the character cap, over the byte cap
        with patch.object(main.project_store, 'stored_edit_file') as edit:
            response = self.http.put('/projects/p/file', json={'path': 'a', 'content': text, 'original': ''})
        self.assertEqual(response.status_code, 413)
        edit.assert_not_called()

    def test_publish_requires_target_and_token(self):
        with patch.object(main.project_store, 'stored_publish', return_value={'ok': True}) as publish:
            self.assertEqual(self.http.post('/projects/p/publish', json={'url': 'https://x/r.git'}).status_code, 422)
            ok = self.http.post('/projects/p/publish', json={'url': 'https://x/r.git', 'token': 't'})
        self.assertEqual(ok.json(), {'ok': True})
        publish.assert_called_once_with('alice', 'p', 'https://x/r.git', 'main', 't')

    def test_delete_project_conflict_and_success(self):
        with patch('app.conversation_delete.delete_project', side_effect=ValueError('project busy')):
            conflict = self.http.delete('/projects/p1')
        self.assertEqual((conflict.status_code, conflict.json()['detail']), (409, 'project busy'))
        with patch('app.conversation_delete.delete_project', return_value={'sessions': 1}) as remove:
            self.assertEqual(self.http.delete('/projects/p1').json(), {'deleted': True, 'sessions': 1})
        remove.assert_called_once_with('alice', 'p1')
