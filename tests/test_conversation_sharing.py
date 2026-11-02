import unittest
from unittest.mock import patch
from fastapi import HTTPException, Request
from app.conversation_sharing import snapshot, markdown_export, shared_conversation, shared_session_conversation, export_conversation, share_conversation, router

class SharingTests(unittest.TestCase):
    def test_share_url_uses_public_ip_and_conversation_id(self):
        request = Request({'type':'http','scheme':'http','server':('localhost',3000),'headers':[], 'root_path':'','path':'/', 'router':router})
        session_id = 'b' * 32
        with patch.dict('os.environ', {'PUBLIC_BASE_URL':'http://192.0.2.10:3000'}), patch('app.conversation_sharing._owned_snapshot', return_value={'title':'Test','messages':[]}), patch('app.conversation_sharing.job_queue._connect'):
            result = share_conversation(session_id, request, {'username':'test'})
        self.assertTrue(result['url'].startswith('http://192.0.2.10:3000/shared/' + session_id + '/'))

    def test_localhost_configuration_falls_back_to_browser_address(self):
        request = Request({'type':'http','scheme':'http','server':('192.0.2.20',8080),'headers':[], 'root_path':'','path':'/', 'router':router})
        with patch.dict('os.environ', {'PUBLIC_BASE_URL':'http://localhost:3000'}), patch('app.conversation_sharing._owned_snapshot', return_value={'title':'Test','messages':[]}), patch('app.conversation_sharing.job_queue._connect'):
            result = share_conversation('b' * 32, request, {'username':'test'})
        self.assertTrue(result['url'].startswith('http://192.0.2.20:8080/shared/' + 'b' * 32 + '/'))

    def test_invalid_conversation_id_rejected_before_storage(self):
        with patch('app.conversation_sharing.job_queue._connect') as connect:
            with self.assertRaises(HTTPException):
                shared_session_conversation('another-conversation', 'a' * 43)
            connect.assert_not_called()

    def test_snapshot_excludes_private_event_fields_and_reconstructs_visible_text(self):
        data = snapshot('Chat', [
            {'type': 'request', 'prompt': 'internal attachment prompt', 'display_prompt': 'Hello', 'secret': 'credential'},
            {'type': 'delta', 'text': 'old'}, {'type': 'delta', 'text': 'new', 'replace': True},
            {'type': 'delta', 'text': '!'}, {'type': 'tool', 'input': {'password': 'secret'}},
            {'type': 'status', 'message': 'private log'},
        ])
        self.assertEqual(data, {'title': 'Chat', 'messages': [{'role': 'user', 'content': 'Hello'}, {'role': 'assistant', 'content': 'new!'}]})
        self.assertIn('## Assistant\n\nnew!', markdown_export(data))

    def test_export_checks_ownership(self):
        with patch('app.conversation_sharing.get_session', side_effect=FileNotFoundError):
            with self.assertRaises(HTTPException) as caught:
                export_conversation('abc', user={'username': 'other'})
            self.assertEqual(caught.exception.status_code, 404)

    def test_invalid_share_token_rejected_before_storage(self):
        with patch('app.conversation_sharing.job_queue._connect') as connect:
            with self.assertRaises(HTTPException):
                shared_conversation('../../secret')
            connect.assert_not_called()

    def test_share_page_serves_normal_app_without_reading_snapshot(self):
        with patch('app.conversation_sharing.job_queue._connect') as connect:
            result = shared_conversation('a' * 43)
            self.assertTrue(str(result.path).endswith('index.html'))
            self.assertEqual(result.headers['cache-control'], 'no-store')
            connect.assert_not_called()

if __name__ == '__main__': unittest.main()
