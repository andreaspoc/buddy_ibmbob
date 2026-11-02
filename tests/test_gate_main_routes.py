"""app.main routes with injected identity and mocked persistence; no database or network is used."""
import asyncio
import json
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.testclient import TestClient

from app import main

ADMIN = {'username': 'root', 'is_admin': True}
MEMBER = {'username': 'alice', 'is_admin': False}
DOC = str(uuid4())
JOB = str(uuid4())
WORKSPACE = 'a' * 32
PRESET = 'c' * 32


class RouteCase(TestCase):
    user = ADMIN

    def setUp(self):
        user = self.user

        async def identity(request=None):
            return user

        self.enterContext(patch('app.auth.current_user', identity))
        self.enterContext(patch('app.main.current_user', identity))
        main.app.dependency_overrides[main.current_user] = identity
        main.app.dependency_overrides[main.administrator] = identity
        main.app.middleware_stack = None
        self.addCleanup(setattr, main.app, 'middleware_stack', None)
        self.addCleanup(main.app.dependency_overrides.clear)
        self.http = TestClient(main.app)
        self.addCleanup(self.http.close)

    def assertOutcome(self, target, error, method, path, status, **kwargs):
        with self.subTest(error=type(error).__name__, path=path), patch(target, side_effect=error):
            self.assertEqual(self.http.request(method, path, **kwargs).status_code, status)

    def assertHttp(self, response, expected):
        self.assertEqual(response.status_code, expected, response.text)
        return response


class KnowledgeTests(RouteCase):
    def test_listing_passes_role(self):
        with patch.object(main.rag, 'list_documents', return_value=[{'id': DOC}]) as listing:
            self.assertEqual(self.http.get('/knowledge').json(), [{'id': DOC}])
        self.assertTrue(listing.call_args.kwargs['admin'])

    def test_upload_maps_errors(self):
        files = {'file': ('a.txt', b'x')}
        self.assertOutcome('app.main.rag.add_document', ValueError('bad'), 'POST', '/knowledge', 422, files=files)
        self.assertOutcome('app.main.rag.add_document', PermissionError('no'), 'POST', '/knowledge', 403, files=files)

    def test_metadata_edit_outcomes(self):
        url = f'/knowledge/{DOC}'
        self.assertHttp(self.http.patch(url, json={}), 422)
        self.assertHttp(self.http.patch(url, json={'knowledge_base': 'company'}), 422)
        with patch.object(main.rag, 'update_classification', return_value=None):
            self.assertHttp(self.http.patch(url, json={'knowledge_base': 'company', 'audience': 'both'}), 404)
        with patch.object(main.rag, 'update_description', return_value={'id': DOC}):
            self.assertEqual(self.http.patch(url, json={'description': 'd'}).json(), {'id': DOC})
        with patch.object(main.rag, 'update_description', return_value=None):
            self.assertHttp(self.http.patch(url, json={'description': 'd'}), 404)
        self.assertOutcome('app.main.rag.update_description', ValueError('bad'), 'PATCH', url, 422, json={'description': 'd'})
        self.assertOutcome('app.main.rag.update_description', PermissionError('no'), 'PATCH', url, 403, json={'description': 'd'})

    def test_freshness_outcomes(self):
        url = f'/knowledge/{DOC}/freshness'
        for result, status in (({'id': DOC}, 200), (None, 404)):
            with self.subTest(result=result), patch.object(main.rag, 'update_freshness', return_value=result):
                self.assertHttp(self.http.patch(url, json={'owner': 'o'}), status)
        self.assertOutcome('app.main.rag.update_freshness', ValueError('bad'), 'PATCH', url, 422, json={})
        self.assertOutcome('app.main.rag.update_freshness', PermissionError('no'), 'PATCH', url, 403, json={})

    def test_replace_outcomes(self):
        url, files = f'/knowledge/{DOC}', {'file': ('a.txt', b'x')}
        for result, status in (({'id': DOC}, 202), (None, 404)):
            with self.subTest(result=result), patch.object(main.rag, 'replace_document', return_value=result):
                self.assertHttp(self.http.put(url, files=files), status)
        self.assertOutcome('app.main.rag.replace_document', ValueError('bad'), 'PUT', url, 422, files=files)
        self.assertOutcome('app.main.rag.replace_document', PermissionError('no'), 'PUT', url, 403, files=files)

    def test_remove_and_retry_errors(self):
        self.assertOutcome('app.main.rag.remove_document', PermissionError('no'), 'DELETE', f'/knowledge/{DOC}', 403)
        self.assertOutcome('app.main.rag.retry_document', PermissionError('no'), 'POST', f'/knowledge/{DOC}/retry', 403)
        self.assertOutcome('app.main.rag.retry_document', ValueError('busy'), 'POST', f'/knowledge/{DOC}/retry', 409)

    def test_download_sets_private_attachment_headers(self):
        with patch.object(main.rag, 'get_document', return_value={'content': b'data', 'filename': 'a b.txt'}):
            response = self.http.get(f'/knowledge/{DOC}/file')
        self.assertEqual(response.content, b'data')
        self.assertIn('a%20b.txt', response.headers['content-disposition'])
        self.assertIn('no-store', response.headers['cache-control'])
        with patch.object(main.rag, 'get_document', return_value=None):
            self.assertHttp(self.http.get(f'/knowledge/{DOC}/file'), 404)

    def test_search_returns_only_public_fields(self):
        rows = [{'id': uuid4(), 'filename': 'f', 'location': 'l', 'text': 't', 'score': 1, 'citation_id': 'c', 'secret': 's'}]
        with patch.object(main.rag, 'retrieve', AsyncMock(return_value=rows)):
            body = self.http.post('/knowledge/search', json={'query': 'hello'}).json()
        self.assertNotIn('secret', body[0])
        self.assertEqual(body[0]['id'], str(rows[0]['id']))


class MemberKnowledgeTests(RouteCase):
    user = MEMBER

    def test_members_cannot_upload(self):
        self.assertHttp(self.http.post('/knowledge', files={'file': ('a.txt', b'x')}), 403)


class FileTests(RouteCase):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(main, '_file_scope', return_value='scope'))

    def test_save_error_statuses(self):
        for error, status in ((ValueError('session deleted'), 409), (ValueError('bad path'), 400), (FileNotFoundError('gone'), 404)):
            self.assertOutcome('app.main.storage.put_file', error, 'PUT', '/workspace/page', status, json={'path': 'a.html', 'content': 'x'})

    def test_save_page(self):
        with patch.object(main.storage, 'put_file') as put:
            self.assertEqual(self.http.put('/workspace/page', json={'path': 'a.html', 'content': 'é'}).json(), {'ok': True, 'path': 'a.html'})
        self.assertEqual(put.call_args.args[3], 'é'.encode())

    def test_page_read_rejects_invalid_path_and_oversize(self):
        self.assertOutcome('app.main.storage.get_file', ValueError('bad'), 'GET', '/workspace/page?path=a.html', 400)
        with patch.object(main.storage, 'get_file', return_value={'content': b'x' * 2_000_001}):
            self.assertHttp(self.http.get('/workspace/page?path=a.html'), 413)

    def test_pages_listing_sorts_newest_first(self):
        rows = [{'path': 'old.html', 'modified': 1}, {'path': 'deck.pptx', 'modified': 3}, {'path': 'note.txt', 'modified': 9}]
        with patch.object(main.storage, 'list_files', return_value=rows), \
                patch.object(main.storage, 'get_file', return_value={'content': b'<html></html>'}) as read:
            body = self.http.get('/workspace/pages').json()
        self.assertEqual([page['name'] for page in body], ['deck.pptx', 'old.html'])
        read.assert_called_once()

    def test_presentation_files_delete_through_presentation_store(self):
        with patch.object(main, 'delete_presentation', return_value=True) as remove, patch.object(main.storage, 'delete_file') as plain:
            self.assertIsNone(self.run_delete('deck.html'))
        remove.assert_called_once()
        plain.assert_not_called()

    def run_delete(self, path):
        return asyncio.run(main._delete_stored_file('alice', 'scope', path))

    def test_delete_missing_file_is_not_found(self):
        with patch.object(main.storage, 'delete_file', return_value=False), self.assertRaises(HTTPException) as failure:
            self.run_delete('a.txt')
        self.assertEqual(failure.exception.status_code, 404)

    def test_delete_supported_document_removes_derived_text(self):
        with patch.object(main.storage, 'delete_file', return_value=True), \
                patch('app.conversation_documents.supported', return_value=True), \
                patch('app.conversation_documents.remove') as remove:
            self.run_delete('a.pdf')
        remove.assert_called_once()

    def upload(self, name, content=b'a,b\n1,2\n'):
        with patch.object(main, '_save_stored_file', AsyncMock()):
            return self.http.post(f'/sessions/{WORKSPACE}/upload', files={'file': (name, content)})

    def test_upload_hidden_names_are_made_safe(self):
        with patch('app.conversation_documents.supported', return_value=False):
            self.assertEqual(self.upload('.env').json()['filename'], 'file_env')
            self.assertEqual(self.upload('...').json()['filename'], 'uploaded_file')

    def test_upload_document_queue_failure_is_reported_not_raised(self):
        with patch('app.conversation_documents.supported', return_value=True), \
                patch('app.conversation_documents.enqueue', side_effect=ValueError('cannot prepare')):
            body = self.upload('a.pdf').json()
        self.assertEqual(body['document']['status'], 'failed')
        self.assertEqual(body['document']['error'], 'cannot prepare')

    def test_upload_bad_spreadsheet_reports_parse_error(self):
        with patch('app.conversation_documents.supported', return_value=False), \
                patch.object(main, 'summarize_spreadsheet', side_effect=RuntimeError('corrupt')):
            body = self.upload('a.csv').json()
        self.assertIn('corrupt', body['summary']['error'])
        self.assertTrue(body['is_spreadsheet'])

    def test_template_drafts_skip_invalid_entries(self):
        rows = [{'path': f'{name}.presentation-template.json', 'size': size} for name, size in (('big', 40000), ('gone', 1), ('huge', 1), ('bad', 1))]
        rows.append({'path': 'other.txt', 'size': 1})
        contents = {'gone.presentation-template.json': None, 'huge.presentation-template.json': {'content': b'x' * 40000},
                    'bad.presentation-template.json': {'content': b'{not json'}}
        with patch.object(main.storage, 'list_files', return_value=rows), \
                patch.object(main.storage, 'get_file', side_effect=lambda user, scope, path: contents[path]):
            self.assertEqual(self.http.get('/presentation/template-drafts', params={'session_id': WORKSPACE}).json(), [])

    def test_decks_ignore_other_files_and_invalid_json(self):
        rows = [{'path': 'a.bobdeck', 'modified': 1}, {'path': 'b.bobdeck', 'modified': 2}, {'path': 'c.txt', 'modified': 3}]
        contents = {'a.bobdeck': {'content': b'{"title":"A","slides":[1,2]}'}, 'b.bobdeck': {'content': b'nope'}}
        with patch.object(main.storage, 'list_files', return_value=rows), \
                patch.object(main.storage, 'get_file', side_effect=lambda user, scope, path: contents[path]):
            self.assertEqual(self.http.get('/presentation/decks').json(), [{'path': 'a.bobdeck', 'title': 'A', 'slidesCount': 2, 'modified': 1}])


class CatalogTests(RouteCase):
    def test_skill_errors(self):
        self.assertOutcome('app.main.get_skill', ValueError('bad'), 'GET', '/skills/x', 422)
        self.assertOutcome('app.main.update_skill', ValueError('bad'), 'PUT', '/skills/x', 422, json={'description': 'd', 'instructions': 'i'})
        self.assertOutcome('app.main.delete_skill', ValueError('bad'), 'DELETE', '/skills/x', 422)

    def test_template_routes_delegate(self):
        with patch.object(main, 'list_presentation_templates', return_value=[{'id': 't'}]):
            self.assertEqual(self.http.get('/presentation/templates').json(), [{'id': 't'}])

    def test_agent_routes(self):
        details = {'endpoint': 'https://agent.invalid/x'}
        body = {'slug': 'a', 'card_url': 'https://agent.invalid/card', 'auth_token': ' token ', 'api_key': 'k', 'api_key_header': 'x-k'}
        with patch.object(main, 'discover_agent', AsyncMock(return_value=dict(details))), \
                patch.object(main, 'create_agent', side_effect=lambda slug, values: values) as create:
            self.assertHttp(self.http.post('/agents', json=body), 201)
        stored = create.call_args.args[1]
        self.assertEqual((stored['auth_token'], stored['api_key'], stored['api_key_header']), ('token', 'k', 'x-k'))

    def test_authenticated_agent_with_foreign_endpoint_is_refused(self):
        body = {'slug': 'a', 'card_url': 'https://agent.invalid/card', 'auth_token': 'token'}
        with patch.object(main, 'discover_agent', AsyncMock(return_value={'endpoint': 'https://other.invalid/x'})):
            self.assertHttp(self.http.post('/agents', json=body), 422)

    def test_update_agent_validates_endpoint(self):
        with patch.object(main, 'validate_url') as validate, patch.object(main, 'update_agent', return_value={'slug': 'a'}):
            self.assertHttp(self.http.put('/agents/a', json={'endpoint': 'https://agent.invalid'}), 200)
        validate.assert_called_once_with('https://agent.invalid')
        self.assertOutcome('app.main.update_agent', ValueError('bad'), 'PUT', '/agents/a', 422, json={'name': 'n'})


class McpTests(RouteCase):
    BODY = {'name': 'm', 'transport': 'http', 'url': 'https://mcp.invalid'}
    STDIO = {'name': 'm', 'transport': 'stdio', 'command': 'run', 'api_key': 'k'}

    def setUp(self):
        super().setUp()
        self.enterContext(patch('app.workspace_config.migrate_mcp_registry'))
        self.enterContext(patch.object(main, 'validate_mcp_url'))

    def test_listing(self):
        with patch.object(main, 'list_mcps', return_value=[]) as listing:
            self.assertEqual(self.http.get('/mcps').json(), [])
        self.assertTrue(listing.call_args.kwargs['admin'])

    def test_draft_check_probes_built_config(self):
        with patch('app.workspace_config.build_mcp_config', return_value={'c': 1}), \
                patch('app.mcp_health.probe_mcp', AsyncMock(return_value={'ok': True})) as probe:
            self.assertEqual(self.http.post('/mcps/check', json=self.BODY).json(), {'ok': True})
            self.assertEqual(self.http.post('/mcps/check', json=self.STDIO).json(), {'ok': True})
        self.assertEqual(probe.await_args.args[0], {'c': 1})

    def test_create_defaults_key_name_by_transport(self):
        for body, name in ((self.STDIO, 'API_KEY'), ({**self.BODY, 'api_key': 'k'}, 'Authorization')):
            with self.subTest(transport=body['transport']), patch.object(main, 'create_mcp', return_value={'name': 'm'}) as create:
                self.assertHttp(self.http.post('/mcps', json=body), 201)
                self.assertEqual(create.call_args.args[9], name)

    def test_config_outcomes(self):
        self.assertOutcome('app.mcp_access.admin_config', PermissionError('no'), 'GET', '/mcps/m/config', 403)
        with patch('app.mcp_access.admin_config', return_value={'c': 1}):
            self.assertEqual(self.http.get('/mcps/m/config').json(), {'c': 1})
        with patch('app.mcp_access.admin_config', return_value=None):
            self.assertHttp(self.http.get('/mcps/m/config'), 404)

    def test_update_errors(self):
        for error, status in ((PermissionError('no'), 403), (KeyError('m'), 404), (ValueError('bad'), 422)):
            self.assertOutcome('app.workspace_config.update_mcp', error, 'PUT', '/mcps/m', status, json=self.BODY)

    def test_delete_errors(self):
        self.assertOutcome('app.main.delete_mcp', ValueError('in use'), 'DELETE', '/mcps/m', 409)
        self.assertOutcome('app.main.delete_mcp', PermissionError('no'), 'DELETE', '/mcps/m', 403)

    def test_access_errors(self):
        body = {'knowledge_base': 'company', 'audience': 'both'}
        for error, status in ((KeyError('m'), 404), (PermissionError('no'), 403), (ValueError('bad'), 422)):
            self.assertOutcome('app.mcp_access.set_access', error, 'PATCH', '/mcps/m/access', status, json=body)

    def test_health_check_for_administrator(self):
        with patch('app.mcp_access.get_managed_server', return_value=None):
            self.assertHttp(self.http.post('/mcps/m/check'), 404)


class MemberMcpTests(RouteCase):
    user = MEMBER

    def test_member_check_uses_authorized_server(self):
        with patch('app.workspace_config.migrate_mcp_registry'), \
                patch('app.mcp_access.get_authorized_server', return_value={'c': 1}) as authorized, \
                patch('app.mcp_health.probe_mcp', AsyncMock(return_value={'ok': True})):
            self.assertEqual(self.http.post('/mcps/m/check').json(), {'ok': True})
        authorized.assert_called_once_with('alice', 'm')


class HookTests(RouteCase):
    def test_validation_errors_are_unprocessable(self):
        body = {'name': 'h', 'event': 'UserPromptSubmit', 'command': 'x'}
        self.assertOutcome('app.main.delete_hook', ValueError('bad'), 'DELETE', '/hooks/h', 422)
        self.assertOutcome('app.main.toggle_hook', ValueError('bad'), 'POST', '/hooks/h/toggle', 422, json={'enabled': True})
        with patch.object(main, 'save_hook', side_effect=ValueError('bad')):
            response = self.http.post('/hooks', json=body)
        self.assertEqual(response.status_code, 422)


class JobTests(RouteCase):
    def test_approval_decision_outcomes(self):
        url = f'/jobs/{JOB}/approvals/{uuid4()}'
        with patch.object(main.job_queue, 'decide_approval', return_value=None):
            self.assertHttp(self.http.post(url, json={'decision': 'approve'}), 404)
        self.assertOutcome('app.main.job_queue.decide_approval', ValueError('late'), 'POST', url, 409, json={'decision': 'approve'})

    def test_guidance_outcomes(self):
        url = f'/jobs/{JOB}/guidance'
        self.assertOutcome('app.chat_guidance.submit', ValueError('closed'), 'POST', url, 409, json={'instruction': 'go'})
        with patch('app.chat_guidance.submit', return_value={'queued': True}):
            self.assertEqual(self.assertHttp(self.http.post(url, json={'instruction': 'go'}), 202).json(), {'queued': True})

    def test_events_require_owned_job(self):
        with patch.object(main.job_queue, 'get_job', return_value=None):
            self.assertHttp(self.http.get(f'/jobs/{JOB}/events'), 404)

    def test_event_replay_is_streamed_with_correlation(self):
        async def replay(job, after):
            yield json.dumps({'type': 'done', 'event_id': 3}) + '\n'
        job = {'payload': {'correlation_id': 'c'}, 'workspace_id': WORKSPACE}
        with patch.object(main.job_queue, 'get_job', return_value=job), patch.object(main, '_replay_job_events', replay):
            response = self.http.get(f'/jobs/{JOB}/events', params={'after_id': -5})
        self.assertEqual(response.headers['content-type'].split(';')[0], 'application/x-ndjson')
        self.assertIn('"done"', response.text)


class HelperTests(TestCase):
    def test_a2a_text_extraction_skips_invalid_parts(self):
        body = {'params': {'message': {'parts': ['bad', {'kind': 'text', 'text': 'one'}, {'text': 'two'}, {'kind': 'file'}]}}}
        self.assertEqual(main._extract_a2a_text(body), 'one\ntwo')

    def test_workspace_page_falls_back_to_shared_workspace(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as shared, patch.dict('os.environ', {'BOB_WORKSPACE': shared}):
            (Path(shared) / 'p.html').write_text('x')
            self.assertEqual(main._workspace_page('p.html', Path(root)), (Path(shared) / 'p.html').resolve())
            with self.assertRaises(HTTPException) as failure:
                main._workspace_page('q.txt', Path(root))
            self.assertEqual(failure.exception.status_code, 400)


class ChatCase(RouteCase):
    user = MEMBER
    modes = [{'slug': 'agent'}, {'slug': 'presentation'}]

    def setUp(self):
        super().setUp()
        self.db = MagicMock()
        self.db.execute.return_value.fetchone.return_value = None
        connection = self.enterContext(patch.object(main.job_queue, '_connect'))
        connection.return_value.__enter__.return_value = self.db
        for name, value in (('workspace_for', MagicMock()), ('storage_scope', 'scope'), ('workspace_key', 'key'), ('touch_session', None),
                            ('read_history', []), ('list_modes', self.modes)):
            self.enterContext(patch.object(main, name, return_value=value))
        self.enterContext(patch.object(main, 'presentation_intent', return_value={'presentation': False, 'slide_count': None, 'format': None}))
        self.enterContext(patch.object(main, 'execute_event_hooks', AsyncMock(return_value=(True, '', ''))))
        self.enterContext(patch.object(main.storage, 'get_file', return_value=None))
        self.enterContext(patch.object(main.job_queue, 'find_submission', return_value=None))
        self.enqueue = self.enterContext(patch.object(main.job_queue, 'enqueue', return_value=JOB))
        self.enterContext(patch.object(main, '_chat_submission_response',
                                       side_effect=lambda job, payload, workspace, reused=False: JSONResponse({'payload': payload, 'reused': reused})))

    def chat(self, prompt='hello', **values):
        return self.http.post('/chat/stream', json={'prompt': prompt, 'workspace_id': WORKSPACE, **values})

    def payload(self, prompt='hello', **values):
        response = self.chat(prompt, **values)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['payload']


class ChatRoutingTests(ChatCase):
    def test_refused_combinations(self):
        for values in ({'agent_slugs': ['a'], 'voice_mode': True}, {'voice_mode': True, 'skill_name': 'x'}, {'note_ids': [1], 'voice_mode': True},
                       {'office_file_ids': [str(uuid4())], 'voice_mode': True}, {'note_ids': [0]}, {'idempotency_key': '!!'}):
            with self.subTest(values=values):
                self.assertEqual(self.chat(**values).status_code, 422)

    def test_attachments_require_access(self):
        with patch('app.agent_attachments.selected_agents', side_effect=PermissionError('denied')):
            self.assertEqual(self.chat(agent_slugs=['a']).status_code, 403)

    def test_conflicting_idempotency_keys_are_refused(self):
        response = self.http.post('/chat/stream', headers={'idempotency-key': 'one'},
                                  json={'prompt': 'x', 'workspace_id': WORKSPACE, 'idempotency_key': 'two'})
        self.assertEqual(response.status_code, 422)

    def test_invalid_workspace_is_not_found(self):
        with patch.object(main, 'workspace_for', side_effect=FileNotFoundError):
            self.assertEqual(self.chat().status_code, 404)

    def test_retry_with_changed_payload_conflicts_and_identical_retry_reuses(self):
        with patch.object(main.job_queue, 'find_submission', side_effect=ValueError('changed')):
            self.assertEqual(self.chat().status_code, 409)
        existing = MagicMock(payload={'mode': 'agent'})
        with patch.object(main.job_queue, 'find_submission', return_value=existing):
            self.assertTrue(self.chat().json()['reused'])

    def test_enqueue_conflict_and_skip_touch_on_reuse(self):
        self.enqueue.side_effect = ValueError('busy')
        self.assertEqual(self.chat().status_code, 409)
        self.enqueue.side_effect = None
        self.enqueue.return_value = MagicMock(reused=True, payload={'mode': 'agent'})
        self.assertTrue(self.chat().json()['reused'])
        main.touch_session.assert_not_called()

    def test_chat_mode_is_agent_and_unknown_mode_is_not_found(self):
        self.assertEqual(self.payload(mode='chat')['mode'], 'agent')
        self.assertEqual(self.chat(mode='ghost').status_code, 404)

    def test_template_studio_prompt_clears_skills(self):
        payload = self.payload(template_studio=True, skill_names=['x'], preset_id=None)
        self.assertEqual(payload['skill_names'], [])
        self.assertTrue(payload['bob_prompt'].startswith('Create a reusable presentation design template'))

    def test_skill_limit(self):
        self.assertEqual(self.chat(skill_names=[f's{i}' for i in range(7)]).status_code, 422)

    def test_unknown_remote_agent(self):
        with patch.object(main, 'get_agent', return_value=None):
            self.assertEqual(self.chat(agent_name='ghost').status_code, 404)

    def test_force_auto_approve_overrides_policy(self):
        with patch.dict('os.environ', {'BOB_FORCE_AUTO_APPROVE': '1'}):
            self.assertEqual(self.payload()['approval_policy']['mode'], 'auto')

    def test_selected_approvals_need_built_in_agent(self):
        with patch.object(main, 'get_agent', return_value={'slug': 'r'}):
            response = self.chat(agent_name='r', approval_policy={'mode': 'selected', 'actions': []})
        self.assertEqual(response.status_code, 422)

    def test_remote_context_is_recovered_from_history(self):
        history = [{'type': 'done', 'agent_context_id': 'ctx'}, {'type': 'request'}]
        with patch.object(main, 'get_agent', return_value={'slug': 'r'}), patch.object(main, 'read_history', return_value=history):
            self.assertEqual(self.payload(agent_name='r')['agent_context_id'], 'ctx')

    def test_hook_context_is_appended_and_block_is_streamed(self):
        with patch.object(main, 'execute_event_hooks', AsyncMock(return_value=(True, 'extra', ''))):
            self.assertIn('[Context from lifecycle hook]:\nextra', self.payload()['bob_prompt'])
        with patch.object(main, 'execute_event_hooks', AsyncMock(return_value=(False, '', 'nope'))):
            self.assertIn('blocked by policy hook: nope', self.chat().text)
        self.enqueue.assert_called_once()

    def test_voice_mode_uses_discussion_prompt(self):
        with patch('app.voice_policy.discussion_prompt', return_value='VOICE') as prompt:
            payload = self.payload(voice_mode=True)
        self.assertEqual(payload['bob_prompt'], 'VOICE')
        self.assertTrue(payload['voice_mode'])
        prompt.assert_called_once()

    def test_note_and_office_references_are_loaded(self):
        with patch('app.note_integration.chat_context', return_value=('\nNOTES', [{'id': 1}])):
            payload = self.payload(note_ids=[1])
        self.assertTrue(payload['bob_prompt'].endswith('\nNOTES'))
        self.assertEqual(payload['note_references'], [{'id': 1}])
        with patch('app.plugin_client.office_context', AsyncMock(return_value=('\nOFFICE', [{'id': 'f'}]))):
            self.assertEqual(self.payload(office_file_ids=[str(uuid4())])['office_references'], [{'id': 'f'}])

    def test_research_sessions_skip_html_artifact_scaffold(self):
        self.db.execute.return_value.fetchone.return_value = {'record': {'research': True}}
        with patch('app.html_artifact_policy.is_html_artifact_request', return_value=True):
            self.assertIsNone(self.payload()['html_artifact_output_path'])

    def test_quiz_submission_uses_grading_context(self):
        with patch('app.quiz.submission_context', return_value='GRADING'):
            payload = self.payload('Quiz submission: {}', skill_names=['x'])
        self.assertEqual((payload['quiz_grading_context'], payload['mode'], payload['skill_names']), ('GRADING', 'agent', []))
        with patch('app.quiz.submission_context', side_effect=ValueError('forged')):
            self.assertEqual(self.chat('Quiz submission: {}').status_code, 422)


class ChatPresetTests(ChatCase):
    def preset(self, **changes):
        return patch.object(main, 'get_preset', return_value={'mode': 'agent', 'skill_name': None, 'web_search': True, **changes})

    def test_preset_refused_for_remote_agent(self):
        with self.preset(), patch.object(main, 'get_agent', return_value={'slug': 'r'}):
            self.assertEqual(self.chat(preset_id=PRESET, agent_name='r').status_code, 422)

    def test_web_search_preset_requires_access_and_key(self):
        with self.preset(), patch('app.workspace_config.ensure_brave_mcp'):
            with patch('app.mcp_access.get_authorized_server', return_value=None):
                self.assertEqual(self.chat(preset_id=PRESET).status_code, 403)
            with patch('app.mcp_access.get_authorized_server', return_value={'c': 1}), patch.dict('os.environ', {'BRAVE_API_KEY': ' '}):
                self.assertEqual(self.chat(preset_id=PRESET).status_code, 422)
            with patch('app.mcp_access.get_authorized_server', return_value={'c': 1}), patch.dict('os.environ', {'BRAVE_API_KEY': 'synthetic'}):
                self.assertIn('/research-buddy hello', self.payload(preset_id=PRESET)['prompt'])


class ChatPresentationTests(ChatCase):
    def intent(self, **values):
        return patch.object(main, 'presentation_intent', return_value={'presentation': True, 'slide_count': 5, 'format': 'pptx', **values})

    def test_setup_is_required_without_template(self):
        with self.intent():
            response = self.chat('deck')
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail']['code'], 'presentation_setup_required')

    def test_pptx_and_html_prompts(self):
        with self.intent(), patch.object(main, 'get_presentation_template'), patch.object(main, 'build_presentation_prompt', return_value='PPTX'), \
                patch.object(main, 'list_skills', return_value=[{'name': 'extra'}]), \
                patch('app.workspace_config.resolve_skill_name', side_effect=lambda name: name):
            payload = self.payload('deck', template_id='t', skill_names=['extra'])
        self.assertEqual(payload['mode'], 'presentation')
        self.assertIn('$extra PPTX', payload['bob_prompt'])
        with self.intent(format='html'), patch.object(main, 'get_presentation_template'), patch.object(main, 'build_html_presentation_prompt', return_value='HTML'):
            payload = self.payload('deck', template_id='t')
        self.assertEqual(payload['bob_prompt'], 'HTML')
        self.assertTrue(payload['presentation_output_path'].endswith('.html'))


class ChatArtifactTests(ChatCase):
    def test_existing_dashboard_requires_new_submission(self):
        with patch('app.html_artifact_policy.is_html_artifact_request', return_value=True), \
                patch.object(main.storage, 'get_file', side_effect=lambda user, scope, path: None if path == 'research-report.md' else {'content': b'x'}):
            self.assertEqual(self.chat(html_artifact_path='dashboard-' + 'b' * 32 + '.html').status_code, 409)
        with patch('app.html_artifact_policy.is_html_artifact_request', return_value=True):
            self.assertTrue(self.payload()['html_artifact_output_path'].startswith('dashboard-'))


class FakeCursor:
    def __init__(self, rows=(), one=None):
        self.rows, self.one = list(rows), one

    async def fetchall(self):
        return self.rows

    async def fetchone(self):
        return self.one


class FakeListener:
    """Scripted psycopg connection: canned replay rows, job status and notifications."""

    def __init__(self, early=(), status=None, notices=()):
        self.early, self.status, self.notices = early, status, notices
        self.closed = False

    async def execute(self, statement, parameters=None):
        return FakeCursor(rows=self.early) if 'bob_job_events' in statement else FakeCursor(one=(self.status,) if self.status else None)

    def notifies(self, timeout=None):
        async def stream():
            for notice in self.notices:
                yield notice
        return stream()

    async def close(self):
        self.closed = True


class JobStreamTests(TestCase):
    def collect(self, listener):
        async def run():
            with patch.dict('os.environ', {'DATABASE_URL': 'postgresql://synthetic.invalid/none'}), \
                    patch.object(main.psycopg.AsyncConnection, 'connect', AsyncMock(return_value=listener)):
                return [json.loads(item) async for item in main._stream_job_events(JOB)]
        items = asyncio.run(run())
        self.assertTrue(listener.closed)
        self.assertEqual(items[0], {'type': 'start'})
        return items[1:]

    def notice(self, payload):
        return MagicMock(channel=f"bob_job_{JOB.replace('-', '')}", payload=payload)

    def test_recorded_terminal_event_ends_the_stream(self):
        early = [(1, {'type': 'delta'}), (2, {'type': 'done'})]
        self.assertEqual(self.collect(FakeListener(early)), [{'type': 'delta', 'event_id': 1}, {'type': 'done', 'event_id': 2}])

    def test_finished_job_without_terminal_event_ends_the_stream(self):
        self.assertEqual(self.collect(FakeListener(status='completed')), [])

    def test_live_notifications_flow_until_terminal(self):
        notices = [MagicMock(channel='other', payload='{"type":"ignored"}'), self.notice('{"type":"delta"}'),
                   self.notice('{"type":"error"}'), self.notice('{"type":"after"}')]
        items = self.collect(FakeListener(status='running', notices=notices))
        self.assertEqual([item['type'] for item in items], ['delta', 'error'])

    def test_notification_stream_end_stops_cleanly(self):
        self.assertEqual(self.collect(FakeListener(status='running')), [])


class ReplayTests(TestCase):
    def replay(self, pages):
        connection = AsyncMock()
        async def run():
            with patch.object(main.job_queue, 'stream_reader', AsyncMock(return_value=connection)), \
                    patch.object(main.job_queue, 'read_stream_events', AsyncMock(side_effect=pages)), \
                    patch.object(main.asyncio, 'sleep', AsyncMock()):
                return [json.loads(item) async for item in main._replay_job_events(JOB, -1)]
        items = asyncio.run(run())
        connection.close.assert_awaited_once()
        return items

    def test_replay_waits_for_running_jobs_and_stops_when_finished(self):
        row = {'id': 7, 'event': {'type': 'delta'}}
        self.assertEqual(self.replay([([row], 'running'), ([], 'completed')]), [{'type': 'delta', 'event_id': 7}])

    def test_full_page_is_followed_immediately(self):
        page = [{'id': index, 'event': {'type': 'delta'}} for index in range(200)]
        self.assertEqual(len(self.replay([(page, 'completed'), ([], 'completed')])), 200)


class ArtifactSocketTests(TestCase):
    def socket(self, **headers):
        socket = AsyncMock()
        socket.headers = headers
        return socket

    def test_foreign_origin_is_closed_without_lookup(self):
        socket = self.socket(origin='https://evil.invalid', host='buddy.invalid')
        with patch.object(main.job_queue, 'get_job') as lookup:
            asyncio.run(main.artifact_socket(socket, uuid4()))
        socket.close.assert_awaited_once_with(code=1008)
        lookup.assert_not_called()

    def test_failed_login_or_foreign_job_is_closed_before_accept(self):
        for auth, job in ((AsyncMock(side_effect=HTTPException(401)), None), (AsyncMock(return_value=MEMBER), None)):
            with self.subTest(job=job, auth=auth.side_effect):
                socket = self.socket()
                with patch.object(main, 'current_user', auth), patch.object(main.job_queue, 'get_job', return_value=job):
                    asyncio.run(main.artifact_socket(socket, uuid4()))
                socket.close.assert_awaited_once_with(code=1008)
                socket.accept.assert_not_called()

    def test_owned_job_streams_events_with_metadata(self):
        socket = self.socket()
        async def receive():
            await asyncio.sleep(3600)
        socket.receive_text.side_effect = receive
        connection = AsyncMock()
        async def events(connection_, job, reader, after):
            yield {'type': 'artifact', 'path': 'a.html'}
        job = {'payload': {}, 'workspace_id': WORKSPACE}
        with patch.object(main, 'current_user', AsyncMock(return_value=MEMBER)), \
                patch.object(main.job_queue, 'get_job', return_value=job), \
                patch.object(main.job_queue, 'stream_reader', AsyncMock(return_value=connection)), \
                patch('app.live_artifacts.artifact_events', events):
            asyncio.run(main.artifact_socket(socket, uuid4()))
        socket.accept.assert_awaited_once()
        self.assertEqual(socket.send_json.await_args.args[0]['path'], 'a.html')
        connection.close.assert_awaited_once()
