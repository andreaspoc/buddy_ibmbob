"""Delegated business sources must fail closed and preserve useful source links."""
import json
import unittest
import os
import tempfile
from pathlib import Path
import httpx
from unittest.mock import MagicMock, patch
from app.business_connectors import business_tools
from app import mcp_microsoft
from app.microsoft_auth import _get_scopes
from app.business_connectors import BUSINESS_SCOPES

class BusinessConnectorTests(unittest.TestCase):
    def test_business_consent_extends_custom_scopes_only_when_requested(self):
        with patch.dict(os.environ, {'GRAPH_SCOPES': 'User.Read,Mail.Read'}):
            self.assertEqual(_get_scopes(), 'User.Read Mail.Read')
            self.assertTrue(set(BUSINESS_SCOPES).issubset(_get_scopes(True).split()))
            self.assertIn('Mail.Read', _get_scopes(True))

    def test_search_preserves_excerpt_and_source_without_shared_ingestion(self):
        graph = MagicMock(return_value=(200, {'value': [{'hitsContainers': [{'hits': [{
            'summary': '<c0>Policy</c0> &amp; conditions', 'resource': {'id': 'item', 'name': 'policy.pdf',
            'webUrl': 'https://example.sharepoint.com/policy.pdf', 'parentReference': {'driveId': 'drive'}}
        }], 'moreResultsAvailable': True}]}]}))
        tools = business_tools(graph)
        result = json.loads(tools['microsoft_search_sharepoint']['func']({'query': 'policy', 'top': 10}))
        self.assertEqual(result['sources'][0]['drive_id'], 'drive')
        self.assertEqual(result['sources'][0]['excerpt'], 'Policy  & conditions')
        self.assertTrue(result['more_results'])
        method, endpoint = graph.call_args.args
        self.assertEqual((method, endpoint), ('POST', '/search/query'))
        self.assertNotIn('includeHiddenContent', graph.call_args.kwargs['json']['requests'][0])

    def test_permission_failures_never_return_content(self):
        for status in (401, 403):
            graph = MagicMock(return_value=(status, {'value': [{'body': {'content': 'restricted'}}]}))
            for name, args in [('microsoft_search_sharepoint', {'query': 'secret'}),
                               ('microsoft_read_teams_chat', {'chat_id': 'chat'}),
                               ('microsoft_read_team_channel', {'team_id': 'team', 'channel_id': 'channel'})]:
                with self.assertRaises(PermissionError) as error:
                    business_tools(graph)[name]['func'](args)
                self.assertNotIn('restricted', str(error.exception))

    def test_team_ids_are_encoded_and_messages_are_plain_text(self):
        graph = MagicMock(return_value=(200, {'value': [{'id': 'message', 'body': {'content': '<p>Hello &amp; goodbye</p>'},
                'from': {'user': {'displayName': 'Alice'}}, 'webUrl': 'https://teams.microsoft.com/l/message/123'}]}))
        result = json.loads(business_tools(graph)['microsoft_read_team_replies']['func'](
            {'team_id': 'team', 'channel_id': '19:x@y', 'message_id': '123'}))
        self.assertEqual(graph.call_args.args[1], '/teams/team/channels/19%3Ax%40y/messages/123/replies')
        self.assertEqual(result['messages'][0]['text'], 'Hello & goodbye')
        self.assertIn('bounded', result['guidance'])

    def test_graph_uses_connected_user_token(self):
        client = MagicMock()
        client.request.return_value.status_code = 200
        client.request.return_value.json.return_value = {'value': []}
        with patch.object(mcp_microsoft, '_load_and_refresh_token', return_value={'access_token': 'user-only-token'}), \
             patch.object(mcp_microsoft.httpx, 'Client') as factory:
            factory.return_value.__enter__.return_value = client
            mcp_microsoft._graph_request('GET', '/me/chats')
        self.assertEqual(client.request.call_args.kwargs['headers']['Authorization'], 'Bearer user-only-token')

    def test_missing_connection_is_not_replaced_by_app_credentials(self):
        with patch.object(mcp_microsoft, '_load_and_refresh_token', return_value=None):
            with self.assertRaises(PermissionError):
                mcp_microsoft._graph_request('POST', '/search/query')

    def test_sharepoint_download_checks_access_before_loading_credentials(self):
        with patch.object(mcp_microsoft, '_graph_request', return_value=(403, {'secret': 'restricted'})), \
             patch.object(mcp_microsoft, '_load_and_refresh_token') as token:
            with self.assertRaises(PermissionError):
                mcp_microsoft.tool_download_sharepoint_file({'drive_id': 'drive', 'item_id': 'item'})
            token.assert_not_called()

    def test_download_stays_private_and_does_not_forward_token_on_redirect(self):
        requests = []
        def handle(request):
            requests.append(request)
            if request.url.host == 'graph.microsoft.com':
                return httpx.Response(302, headers={'Location': 'https://files.example.test/document'})
            return httpx.Response(200, content=b'Private evidence')
        factory = httpx.Client
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(mcp_microsoft, '_graph_request', return_value=(200, {'name': 'evidence.txt', 'size': 16, 'file': {}, 'webUrl':'https://example.sharepoint.com/evidence.txt'})), \
             patch.object(mcp_microsoft, '_load_and_refresh_token', return_value={'access_token':'user-only-token'}), \
             patch.object(mcp_microsoft.Path, 'cwd', return_value=Path(directory)), \
             patch.object(mcp_microsoft.httpx, 'Client', side_effect=lambda **kwargs: factory(transport=httpx.MockTransport(handle), **kwargs)):
            result = json.loads(mcp_microsoft.tool_download_sharepoint_file({'drive_id':'drive', 'item_id':'item'}))
            self.assertEqual((Path(directory) / result['filename']).read_bytes(), b'Private evidence')
            self.assertEqual(requests[0].headers['Authorization'], 'Bearer user-only-token')
            self.assertNotIn('Authorization', requests[1].headers)
            with self.assertRaises(ValueError):
                mcp_microsoft.tool_download_sharepoint_file({'drive_id':'drive', 'item_id':'item', 'local_filename':'../escape.txt'})
            with self.assertRaises(ValueError):
                mcp_microsoft.tool_download_sharepoint_file({'drive_id':'drive', 'item_id':'item'})

if __name__ == '__main__': unittest.main()
