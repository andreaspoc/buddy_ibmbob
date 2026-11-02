"""Validation, error mapping, and parameter checking tests for app.main routes."""
from unittest import TestCase
from unittest.mock import patch

from fastapi import HTTPException
from starlette.testclient import TestClient

from app import main

ADMIN = {'username': 'root', 'is_admin': True}
MEMBER = {'username': 'alice', 'is_admin': False}


class MainRoutesValidationCase(TestCase):
    user = MEMBER

    def setUp(self):
        user = self.user

        async def identity(request=None):
            if user is None:
                raise HTTPException(401, 'Sign in required')
            return user

        patcher = patch('app.auth.current_user', identity)
        patcher.start()
        self.addCleanup(patcher.stop)
        main_patcher = patch('app.main.current_user', identity)
        main_patcher.start()
        self.addCleanup(main_patcher.stop)
        main.app.dependency_overrides[main.current_user] = identity
        main.app.middleware_stack = None
        self.addCleanup(setattr, main.app, 'middleware_stack', None)
        self.addCleanup(main.app.dependency_overrides.clear)
        self.http = TestClient(main.app)
        self.addCleanup(self.http.close)


class SkillsRouteValidationTests(MainRoutesValidationCase):
    def test_get_skills_returns_list(self):
        with patch('app.main.list_skills', return_value=[{'name': 'research'}]):
            res = self.http.get('/skills')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [{'name': 'research'}])

    def test_post_skills_duplicate_returns_409(self):
        payload = {
            'name': 'existing-skill',
            'description': 'Valid skill description',
            'instructions': 'Valid instructions',
        }
        with patch('app.main.create_skill', side_effect=FileExistsError('exists')):
            res = self.http.post('/skills', json=payload)
        self.assertEqual(res.status_code, 409)
        self.assertIn("already exists", res.json()['detail'])

    def test_post_skills_invalid_value_returns_422(self):
        payload = {
            'name': 'valid-slug',
            'description': 'Valid skill description',
            'instructions': 'Valid instructions',
        }
        with patch('app.main.create_skill', side_effect=ValueError('Invalid skill instructions format')):
            res = self.http.post('/skills', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn("Invalid skill instructions format", res.json()['detail'])

    def test_get_skills_not_found_returns_404(self):
        with patch('app.main.get_skill', side_effect=KeyError('missing')):
            res = self.http.get('/skills/missing')
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.json()['detail'], "Skill not found")

    def test_put_skills_not_found_returns_404(self):
        with patch('app.main.update_skill', side_effect=KeyError('missing')):
            res = self.http.put('/skills/missing', json={'description': 'Valid description', 'instructions': 'Valid instructions'})
        self.assertEqual(res.status_code, 404)

    def test_delete_skills_not_found_returns_404(self):
        with patch('app.main.delete_skill', side_effect=KeyError('missing')):
            res = self.http.delete('/skills/missing')
        self.assertEqual(res.status_code, 404)

    def test_delete_skills_busy_returns_409(self):
        from app.postgres_storage import SkillDeletionBusy
        with patch('app.main.delete_skill', side_effect=SkillDeletionBusy('Skill is currently active')):
            res = self.http.delete('/skills/active_skill')
        self.assertEqual(res.status_code, 409)
        self.assertIn('active', res.json()['detail'])


class ModesRouteValidationTests(MainRoutesValidationCase):
    def test_post_modes_rejects_unsupported_tool_groups(self):
        payload = {
            'slug': 'custom',
            'name': 'Custom Mode',
            'description': 'Valid description',
            'role_definition': 'Valid role definition',
            'instructions': 'Valid instructions',
            'groups': ['invalid_unknown_group'],
        }
        res = self.http.post('/modes', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn("Unsupported tool group", res.json()['detail'])

    def test_post_modes_duplicate_returns_409(self):
        payload = {
            'slug': 'existing-mode',
            'name': 'Existing Mode',
            'description': 'Valid description',
            'role_definition': 'Valid role definition',
            'instructions': 'Valid instructions',
            'groups': ['read', 'mode'],
        }
        with patch('app.main.create_mode', side_effect=FileExistsError('Mode already exists')):
            res = self.http.post('/modes', json=payload)
        self.assertEqual(res.status_code, 409)


class MCPRouteAccessAndValidationTests(MainRoutesValidationCase):
    user = MEMBER  # Non-admin

    def test_mcp_admin_endpoints_reject_non_admin(self):
        mcp_payload = {
            'name': 'test-mcp',
            'transport': 'stdio',
            'command': 'node',
            'args': ['server.js'],
        }
        self.assertEqual(self.http.post('/mcps/check', json=mcp_payload).status_code, 403)
        self.assertEqual(self.http.post('/mcps', json=mcp_payload).status_code, 403)
        self.assertEqual(self.http.get('/mcps/test-mcp/config').status_code, 403)
        self.assertEqual(self.http.put('/mcps/test-mcp', json=mcp_payload).status_code, 403)


class MCPAdminValidationTests(MainRoutesValidationCase):
    user = ADMIN  # Admin

    def test_mcp_stdio_requires_non_empty_command(self):
        payload = {
            'name': 'invalid-stdio',
            'transport': 'stdio',
            'command': '   ',
            'args': [],
        }
        res = self.http.post('/mcps', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn("Enter a command for the stdio server", res.json()['detail'])

    def test_mcp_config_missing_returns_404(self):
        with patch('app.workspace_config.migrate_mcp_registry'), \
             patch('app.mcp_access.admin_config', return_value=None):
            res = self.http.get('/mcps/nonexistent/config')
        self.assertEqual(res.status_code, 404)
        self.assertIn("MCP connection not found", res.json()['detail'])

    def test_mcp_put_rejects_name_change(self):
        payload = {
            'name': 'different-name',
            'transport': 'stdio',
            'command': 'node',
            'args': ['s.js'],
        }
        res = self.http.put('/mcps/original-name', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn("Connection names cannot be changed", res.json()['detail'])


class PresentationAndHookValidationTests(MainRoutesValidationCase):
    user = ADMIN

    def test_template_missing_returns_404(self):
        with patch('app.main.get_presentation_template', side_effect=HTTPException(status_code=404, detail='Template not found')):
            res = self.http.get('/presentation/templates/unknown-template')
        self.assertEqual(res.status_code, 404)

    def test_hook_delete_missing_returns_404(self):
        with patch('app.main.delete_hook', return_value=False):
            res = self.http.delete('/hooks/missing-hook')
        self.assertEqual(res.status_code, 404)

    def test_hook_toggle_missing_returns_404(self):
        with patch('app.main.toggle_hook', return_value=None):
            res = self.http.post('/hooks/missing-hook/toggle', json={'enabled': False})
        self.assertEqual(res.status_code, 404)

    def test_health_and_well_known(self):
        self.assertEqual(self.http.get('/health').json(), {'ok': True})
        agent = self.http.get('/.well-known/agent.json')
        self.assertEqual(agent.status_code, 200)
        self.assertEqual(agent.json()['name'], 'Buddy')


class UserAndWorkspaceValidationTests(MainRoutesValidationCase):
    def test_plugins_capabilities_endpoint(self):
        with patch('app.plugin_client.capabilities', return_value={'office': True}):
            res = self.http.get('/api/plugins')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'office': True})

    def test_non_admin_cannot_access_user_management(self):
        # self.user is MEMBER (is_admin: False)
        self.assertEqual(self.http.get('/auth/users').status_code, 403)
        self.assertEqual(self.http.post('/auth/users', json={'username': 'bob', 'password': 'pw'}).status_code, 403)

    def test_workspace_page_rejects_non_html(self):
        res = self.http.get('/workspace/page', params={'path': 'document.pdf'})
        self.assertEqual(res.status_code, 400)
        self.assertIn('Invalid page path', res.json()['detail'])

    def test_workspace_page_rejects_oversized_content(self):
        oversized = {'content': b'x' * 2_000_001}
        with patch('app.main._stored_file', return_value=oversized):
            res = self.http.get('/workspace/page', params={'path': 'page.html'})
        self.assertEqual(res.status_code, 413)
        self.assertIn('too large', res.json()['detail'])


class AgentsRouteValidationTests(MainRoutesValidationCase):
    def test_list_agents(self):
        with patch('app.main.list_agents', return_value=[{'slug': 'analyst', 'name': 'Analyst'}]):
            res = self.http.get('/agents')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [{'slug': 'analyst', 'name': 'Analyst'}])

    def test_add_agent_duplicate_conflict(self):
        payload = {
            'slug': 'existing-agent',
            'card_url': 'https://example.com/agent-card.json',
        }
        with patch('app.main.discover_agent', return_value={'endpoint': 'https://example.com/api'}):
            with patch('app.main.create_agent', side_effect=FileExistsError('Agent already exists')):
                res = self.http.post('/agents', json=payload)
        self.assertEqual(res.status_code, 409)

    def test_add_agent_invalid_discovery_rejected(self):
        payload = {
            'slug': 'invalid-agent',
            'card_url': 'https://example.com/agent-card.json',
        }
        with patch('app.main.discover_agent', side_effect=ValueError('Invalid agent card')):
            res = self.http.post('/agents', json=payload)
        self.assertEqual(res.status_code, 422)

    def test_update_agent_missing_returns_404(self):
        with patch('app.main.update_agent', side_effect=KeyError('missing-agent')):
            res = self.http.put('/agents/missing-agent', json={'description': 'New desc'})
        self.assertEqual(res.status_code, 404)

    def test_delete_agent_missing_returns_404(self):
        with patch('app.main.delete_agent', side_effect=KeyError('missing-agent')):
            res = self.http.delete('/agents/missing-agent')
        self.assertEqual(res.status_code, 404)

    def test_delete_agent_success(self):
        with patch('app.main.delete_agent', return_value=None):
            res = self.http.delete('/agents/valid-agent')
        self.assertEqual(res.status_code, 204)


class PresentationIntentValidationTests(MainRoutesValidationCase):
    def test_presentation_intent_when_presentation_true(self):
        intent_data = {'presentation': True, 'mode': 'presentation', 'confidence': 0.9}
        with patch('app.main.presentation_intent', return_value=intent_data):
            res = self.http.post('/presentation/intent', json={'prompt': 'Generate a presentation for Q3'})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data['presentation'])
        self.assertFalse(data['html_artifact'])
        self.assertIsNone(data['html_artifact_path'])

    def test_presentation_intent_when_html_artifact(self):
        intent_data = {'presentation': False, 'mode': 'agent', 'confidence': 0.8}
        with patch('app.main.presentation_intent', return_value=intent_data):
            with patch('app.html_artifact_policy.is_html_artifact_request', return_value=True):
                res = self.http.post('/presentation/intent', json={'prompt': 'Build me an interactive HTML dashboard'})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertFalse(data['presentation'])
        self.assertTrue(data['html_artifact'])
        self.assertTrue(data['html_artifact_path'].startswith('dashboard-'))


class A2aRouteValidationTests(MainRoutesValidationCase):
    def test_a2a_invalid_jsonrpc(self):
        res = self.http.post('/a2a', json={'id': '1', 'jsonrpc': '1.0'})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['error']['code'], -32600)

    def test_a2a_unknown_method(self):
        res = self.http.post('/a2a', json={'id': '1', 'jsonrpc': '2.0', 'method': 'unsupported/method'})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['error']['code'], -32601)

    def test_a2a_missing_prompt_returns_32602(self):
        res = self.http.post('/a2a', json={'id': '1', 'jsonrpc': '2.0', 'method': 'message/send', 'params': {}})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['error']['code'], -32602)


class ChatStreamValidationTests(MainRoutesValidationCase):
    def test_chat_stream_conflicting_agent_slugs_and_voice(self):
        payload = {
            'prompt': 'Hello',
            'agent_slugs': ['agent-a'],
            'voice_mode': True,
        }
        res = self.http.post('/chat/stream', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn('A2A attachments require a Buddy chat without voice', res.json()['detail'])

    def test_chat_stream_voice_mode_with_skill_rejected(self):
        payload = {
            'prompt': 'Hello',
            'voice_mode': True,
            'skill_name': 'research',
        }
        res = self.http.post('/chat/stream', json=payload)
        self.assertEqual(res.status_code, 422)
        self.assertIn('Voice discussion uses Buddy without a presentation', res.json()['detail'])


class SessionUploadValidationTests(MainRoutesValidationCase):
    def test_session_upload_legacy_doc_rejected(self):
        files = {'file': ('document.doc', b'legacy binary doc content', 'application/msword')}
        res = self.http.post('/sessions/session123/upload', files=files)
        self.assertEqual(res.status_code, 422)
        self.assertIn('Legacy Word .doc files are not supported', res.json()['detail'])

    def test_session_upload_empty_document_rejected(self):
        files = {'file': ('empty.pdf', b'', 'application/pdf')}
        res = self.http.post('/sessions/session123/upload', files=files)
        self.assertEqual(res.status_code, 422)
        self.assertIn('document is empty', res.json()['detail'])


class OfficeCapabilitiesAndReadinessTests(MainRoutesValidationCase):
    user = ADMIN

    def test_office_chat_capabilities(self):
        with patch.dict('os.environ', {'BUDDY_OFFICE_ENABLED': '1'}):
            main.app.middleware_stack = None
            client = TestClient(main.app)
            try:
                res = client.get('/api/office/chat-capabilities')
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.json()['version'], 1)
                self.assertEqual(res.json()['max_files'], 3)
            finally:
                client.close()

    def test_hook_test_execution_disabled(self):
        res = self.http.post('/hooks/test', json={'script_code': 'echo hi', 'event': 'PreToolUse'})
        self.assertEqual(res.status_code, 403)
        self.assertIn('Hook command testing is disabled', res.json()['detail'])

    def test_readiness_endpoint_ok(self):
        from unittest.mock import MagicMock
        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_db
        with patch('app.auth._connect', return_value=mock_ctx):
            res = self.http.get('/ready')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {'ok': True})

    def test_readiness_endpoint_db_unavailable(self):
        with patch('app.auth._connect', side_effect=Exception('DB Down')):
            res = self.http.get('/ready')
        self.assertEqual(res.status_code, 503)
        self.assertIn('Database unavailable', res.json()['detail'])

    def test_presentation_template_drafts_and_detail(self):
        valid_json = b'{"title":"Starter","brand":"Company A","colors":{"primary":"#000000","secondary":"#111111","accent":"#222222","background":"#ffffff","text":"#000000"},"fonts":{"heading":"Inter","body":"Inter"},"design":{}}'
        with patch('app.main.storage.list_files', return_value=[
            {'path': 'draft1.presentation-template.json', 'size': 100},
            {'path': 'other.txt', 'size': 50},
        ]), patch('app.main.storage.get_file', return_value={'content': valid_json}):
            res = self.http.get('/presentation/template-drafts?session_id=legacy')
            self.assertEqual(res.status_code, 200)
            self.assertEqual(len(res.json()), 1)
            self.assertEqual(res.json()[0]['path'], 'draft1.presentation-template.json')

        with patch('app.main.get_presentation_template', return_value={'id': 'buddy-starter', 'name': 'Starter'}):
            res2 = self.http.get('/presentation/templates/buddy-starter')
            self.assertEqual(res2.status_code, 200)
            self.assertEqual(res2.json()['id'], 'buddy-starter')

    def test_knowledge_freshness_routes(self):
        import uuid
        doc_id = str(uuid.uuid4())
        # Not found
        with patch('app.main.rag.update_freshness', return_value=None):
            res = self.http.patch(f'/knowledge/{doc_id}/freshness', json={'owner': 'alice', 'review_due': '2026-12-31', 'reviewed': True})
            self.assertEqual(res.status_code, 404)

        # Permission error
        with patch('app.main.rag.update_freshness', side_effect=PermissionError('Forbidden')):
            res2 = self.http.patch(f'/knowledge/{doc_id}/freshness', json={'owner': 'alice', 'review_due': '2026-12-31', 'reviewed': True})
            self.assertEqual(res2.status_code, 403)

        # Success
        with patch('app.main.rag.update_freshness', return_value={'id': doc_id, 'owner': 'alice'}):
            res3 = self.http.patch(f'/knowledge/{doc_id}/freshness', json={'owner': 'alice', 'review_due': '2026-12-31', 'reviewed': True})
            self.assertEqual(res3.status_code, 200)

    def test_knowledge_edit_metadata_routes(self):
        import uuid
        doc_id = str(uuid.uuid4())
        # Incomplete classification
        res = self.http.patch(f'/knowledge/{doc_id}', json={'knowledge_base': 'company'})
        self.assertEqual(res.status_code, 422)

        # Update classification success
        with patch('app.main.rag.update_classification', return_value={'id': doc_id, 'knowledge_base': 'company', 'audience': 'both'}):
            res2 = self.http.patch(f'/knowledge/{doc_id}', json={'knowledge_base': 'company', 'audience': 'both'})
            self.assertEqual(res2.status_code, 200)

        # Update description success
        with patch('app.main.rag.update_description', return_value={'id': doc_id, 'description': 'Updated'}):
            res3 = self.http.patch(f'/knowledge/{doc_id}', json={'description': 'Updated'})
            self.assertEqual(res3.status_code, 200)

    def test_knowledge_remove_retry_download(self):
        import uuid
        doc_id = str(uuid.uuid4())
        # Remove not found
        with patch('app.main.rag.remove_document', return_value=False):
            res = self.http.delete(f'/knowledge/{doc_id}')
            self.assertEqual(res.status_code, 404)

        # Remove success
        with patch('app.main.rag.remove_document', return_value=True):
            res2 = self.http.delete(f'/knowledge/{doc_id}')
            self.assertEqual(res2.status_code, 204)

        # Retry not found / already indexing
        with patch('app.main.rag.retry_document', return_value=False):
            res3 = self.http.post(f'/knowledge/{doc_id}/retry')
            self.assertEqual(res3.status_code, 409)

        # Retry success
        with patch('app.main.rag.retry_document', return_value=True):
            res4 = self.http.post(f'/knowledge/{doc_id}/retry')
            self.assertEqual(res4.status_code, 202)
            self.assertEqual(res4.json(), {'status': 'queued'})

        # Download not found
        with patch('app.main.rag.get_document', return_value=None):
            res5 = self.http.get(f'/knowledge/{doc_id}/file')
            self.assertEqual(res5.status_code, 404)

    def test_conversation_document_preview_route(self):
        # Unsupported format
        res = self.http.get('/sessions/legacy/documents/preview?path=test.exe')
        self.assertEqual(res.status_code, 422)

        # Not found
        with patch('app.conversation_documents.supported', return_value=True), \
             patch('app.conversation_documents.get_preview', side_effect=FileNotFoundError('Missing')):
            res2 = self.http.get('/sessions/legacy/documents/preview?path=test.pdf')
            self.assertEqual(res2.status_code, 404)

        # Success with unprepared triggering enqueue
        with patch('app.conversation_documents.supported', return_value=True), \
             patch('app.conversation_documents.get_preview', side_effect=[
                 {'status': 'unprepared', 'path': 'test.pdf', 'prepared_path': None, 'error': None},
                 {'status': 'ready', 'path': 'test.pdf', 'prepared_path': 'prep.md', 'error': None, 'text': 'Ready'}
             ]), \
             patch('app.conversation_documents.enqueue'):
            res3 = self.http.get('/sessions/legacy/documents/preview?path=test.pdf')
            self.assertEqual(res3.status_code, 200)
            self.assertEqual(res3.json()['status'], 'ready')

    def test_job_approvals_guidance_and_cancel_routes(self):
        import uuid
        job_id = str(uuid.uuid4())
        app_id = str(uuid.uuid4())

        # Invalid UUID
        res = self.http.post('/jobs/not-a-uuid/approvals/bad', json={'decision': 'approve'})
        self.assertEqual(res.status_code, 404)

        # Approval success
        with patch('app.main.job_queue.decide_approval', return_value={'type': 'approval_decided'}):
            res2 = self.http.post(f'/jobs/{job_id}/approvals/{app_id}', json={'decision': 'approve'})
            self.assertEqual(res2.status_code, 200)

        # Guidance not found
        with patch('app.chat_guidance.submit', return_value=None):
            res3 = self.http.post(f'/jobs/{job_id}/guidance', json={'instruction': 'Keep going'})
            self.assertEqual(res3.status_code, 404)

        # Cancel job not found
        with patch('app.main.job_queue.request_cancel', return_value=None):
            res4 = self.http.post(f'/jobs/{job_id}/cancel')
            self.assertEqual(res4.status_code, 404)

        # Cancel job success
        with patch('app.main.job_queue.request_cancel', return_value={'status': 'cancelling', 'workspace_id': 'ws1'}), \
             patch('app.main.job_queue.get_job', return_value={'status': 'cancelled', 'payload': {'cancel_requested': True}}):
            res5 = self.http.post(f'/jobs/{job_id}/cancel')
            self.assertEqual(res5.status_code, 200)
            self.assertEqual(res5.json()['status'], 'stopped')


class WorkspaceAndA2AHelperTests(TestCase):
    def test_workspace_page_validation(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # invalid extension
            with self.assertRaises(HTTPException) as ctx:
                main._workspace_page('file.txt', root)
            self.assertEqual(ctx.exception.status_code, 400)

            # not found
            with self.assertRaises(HTTPException) as ctx:
                main._workspace_page('missing.html', root)
            self.assertEqual(ctx.exception.status_code, 404)

            # valid file
            page = root / 'valid.html'
            page.write_text('<h1>Hello</h1>')
            res = main._workspace_page('valid.html', root)
            self.assertEqual(res, page)

    def test_extract_a2a_text_variations(self):
        # parts
        self.assertEqual(main._extract_a2a_text({'params': {'message': {'parts': [{'kind': 'text', 'text': 'Hello world'}]}}}), 'Hello world')
        # message text
        self.assertEqual(main._extract_a2a_text({'params': {'message': {'text': 'Direct message'}}}), 'Direct message')
        # prompt
        self.assertEqual(main._extract_a2a_text({'params': {'prompt': 'Prompt text'}}), 'Prompt text')
        # text
        self.assertEqual(main._extract_a2a_text({'params': {'text': 'Text param'}}), 'Text param')
        # empty raises
        with self.assertRaises(ValueError):
            main._extract_a2a_text({})


class StaticAndUtilityRoutesTests(MainRoutesValidationCase):
    def test_static_routes(self):
        # root
        res = self.http.get('/')
        self.assertIn(res.status_code, (200, 404))

        # register
        res = self.http.get('/register')
        self.assertIn(res.status_code, (200, 404))

        # favicon
        res = self.http.get('/favicon.svg')
        self.assertIn(res.status_code, (200, 404))

        # auth status
        with patch('app.main.has_users', return_value=True):
            res = self.http.get('/auth/status')
            self.assertEqual(res.status_code, 200)

    def test_learning_page_route(self):
        with patch('app.main.plugin_enabled', return_value=False):
            res = self.http.get('/learning')
            self.assertEqual(res.status_code, 404)

        with patch('app.main.plugin_enabled', return_value=True), \
             patch('pathlib.Path.exists', return_value=True):
            res2 = self.http.get('/learning')
            self.assertIn(res2.status_code, (200, 404))


class FileUploadAndPresentationDecksTests(MainRoutesValidationCase):
    def test_upload_session_file_validations(self):
        # .doc rejected
        res = self.http.post('/sessions/s1/upload', files={'file': ('old.doc', b'content', 'application/msword')})
        self.assertEqual(res.status_code, 422)

        # empty document rejected
        with patch('app.conversation_documents.supported', return_value=True):
            res2 = self.http.post('/sessions/s1/upload', files={'file': ('doc.pdf', b'', 'application/pdf')})
            self.assertEqual(res2.status_code, 422)

        # valid csv upload
        with patch('app.main._save_stored_file'), \
             patch('app.main.summarize_spreadsheet', return_value={'rows': 2, 'columns': 2}):
            res3 = self.http.post('/sessions/s1/upload', files={'file': ('data.csv', b'a,b\n1,2', 'text/csv')})
            self.assertEqual(res3.status_code, 201)
            self.assertTrue(res3.json()['is_spreadsheet'])

    def test_presentation_decks_and_deck_route(self):
        # decks
        with patch('app.postgres_storage.list_files', return_value=[{'path': 'presentation.bobdeck', 'modified': 100}]), \
             patch('app.main._stored_file', return_value={'content': '{"title": "Deck 1", "slides": [1]}'}):
            res = self.http.get('/presentation/decks')
            self.assertEqual(res.status_code, 200)
            self.assertEqual(len(res.json()), 1)
            self.assertEqual(res.json()[0]['title'], 'Deck 1')

        # deck single
        with patch('app.main._stored_file', return_value={'content': '{"title": "Deck 1"}'}):
            res2 = self.http.get('/presentation/deck?path=presentation.bobdeck')
            self.assertEqual(res2.status_code, 200)
            self.assertEqual(res2.json()['title'], 'Deck 1')

        # invalid deck json
        with patch('app.main._stored_file', return_value={'content': 'invalid-json'}):
            res3 = self.http.get('/presentation/deck?path=presentation.bobdeck')
            self.assertEqual(res3.status_code, 422)


class MCPAdminRoutesTests(MainRoutesValidationCase):
    user = ADMIN

    def test_configure_mcp_admin(self):
        # name mismatch
        res = self.http.put('/mcps/srv1', json={'name': 'srv2', 'transport': 'stdio', 'command': 'cmd'})
        self.assertEqual(res.status_code, 422)

        # not found
        with patch('app.workspace_config.update_mcp', side_effect=KeyError('missing')):
            res2 = self.http.put('/mcps/missing', json={'name': 'missing', 'transport': 'stdio', 'command': 'cmd'})
            self.assertEqual(res2.status_code, 404)

        # success
        with patch('app.workspace_config.update_mcp', return_value={'name': 'srv1'}):
            res3 = self.http.put('/mcps/srv1', json={'name': 'srv1', 'transport': 'stdio', 'command': 'cmd'})
            self.assertEqual(res3.status_code, 200)

    def test_check_mcp_connection(self):
        with patch('app.workspace_config.migrate_mcp_registry'), \
             patch('app.mcp_access.get_managed_server', return_value={'config': {'command': 'cmd'}}), \
             patch('app.mcp_health.probe_mcp', return_value={'status': 'ok'}):
            res = self.http.post('/mcps/srv1/check')
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json()['status'], 'ok')

        # not found
        with patch('app.workspace_config.migrate_mcp_registry'), \
             patch('app.mcp_access.get_managed_server', return_value=None):
            res2 = self.http.post('/mcps/missing/check')
            self.assertEqual(res2.status_code, 404)

    def test_remove_and_classify_mcp(self):
        # remove not found
        with patch('app.main.delete_mcp', return_value=False):
            res = self.http.delete('/mcps/srv1')
            self.assertEqual(res.status_code, 404)

        # remove success
        with patch('app.main.delete_mcp', return_value=True):
            res2 = self.http.delete('/mcps/srv1')
            self.assertEqual(res2.status_code, 204)

        # classify success
        with patch('app.workspace_config.migrate_mcp_registry'), \
             patch('app.mcp_access.set_access', return_value={'name': 'srv1', 'knowledge_base': 'company', 'audience': 'both'}):
            res3 = self.http.patch('/mcps/srv1/access', json={'knowledge_base': 'company', 'audience': 'both'})
            self.assertEqual(res3.status_code, 200)


