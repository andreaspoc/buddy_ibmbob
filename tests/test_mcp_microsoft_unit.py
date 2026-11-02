"""Microsoft tool formatting and validation without contacting Graph."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from app import mcp_microsoft as microsoft


class MicrosoftToolTests(unittest.TestCase):
    def test_onedrive_upload_and_download_use_fixture_http_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.txt'
            source.write_bytes(b'fixture upload')
            client = MagicMock()
            client.__enter__.return_value = client
            client.put.return_value.status_code = 201
            client.get.return_value.status_code = 200
            client.get.return_value.content = b'fixture download'
            with patch.object(microsoft, '_load_and_refresh_token', return_value={'access_token': 'fixture'}), \
                 patch.object(microsoft.httpx, 'Client', return_value=client), patch.object(microsoft.Path, 'cwd', return_value=root):
                self.assertIn('successfully uploaded', microsoft.tool_upload_onedrive_file({'local_file': str(source), 'onedrive_folder': 'reports'}))
                self.assertEqual(client.put.call_args.kwargs['content'], b'fixture upload')
                self.assertIn('/reports/source.txt:/content', client.put.call_args.args[0])
                self.assertIn('successfully downloaded', microsoft.tool_download_onedrive_file({'onedrive_path': 'remote.txt'}))
                self.assertEqual((root / 'remote.txt').read_bytes(), b'fixture download')
                client.put.return_value.status_code = 403
                client.put.return_value.text = 'denied'
                self.assertIn('Error uploading', microsoft.tool_upload_onedrive_file({'local_file': str(source)}))
                client.get.return_value.status_code = 404
                client.get.return_value.text = 'missing'
                self.assertIn('Error downloading', microsoft.tool_download_onedrive_file({'onedrive_path': 'missing.txt'}))

    def test_file_transfer_and_spreadsheet_require_existing_inputs(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(microsoft.Path, 'cwd', return_value=Path(directory)), \
             patch.object(microsoft.httpx, 'Client') as client:
            self.assertIn('required', microsoft.tool_upload_onedrive_file({}))
            self.assertIn('not found', microsoft.tool_upload_onedrive_file({'local_file': 'missing'}))
            self.assertIn('required', microsoft.tool_download_onedrive_file({}))
            self.assertIn('required', microsoft.tool_read_spreadsheet({}))
            self.assertIn('not found', microsoft.tool_read_spreadsheet({'file_path': 'missing.csv'}))
            client.assert_not_called()

    def test_stdio_protocol_returns_tool_results_and_errors(self):
        requests = [
            {'id': 1, 'method': 'initialize'}, {'method': 'notifications/initialized'},
            {'id': 2, 'method': 'tools/list'}, {'id': 3, 'method': 'ping'},
            {'id': 4, 'method': 'tools/call', 'params': {'name': 'unknown'}},
            {'id': 5, 'method': 'tools/call', 'params': {'name': 'success'}},
            {'id': 6, 'method': 'tools/call', 'params': {'name': 'denied'}},
            {'id': 7, 'method': 'tools/call', 'params': {'name': 'failure'}},
            {'id': 8, 'method': 'unknown'}, {'method': 'unknown'},
        ]
        def denied(_): raise PermissionError('not connected')
        def failure(_): raise ValueError('bad arguments')
        registry = {name: {'description': name, 'inputSchema': {}, 'func': func} for name, func in
                    [('success', lambda _: 'okay'), ('denied', denied), ('failure', failure)]}
        source = io.StringIO('invalid json\n\n' + '\n'.join(json.dumps(item) for item in requests))
        output = io.StringIO()
        with patch.object(microsoft.sys, 'stdin', source), patch.object(microsoft.sys, 'stdout', output), \
             patch.object(microsoft, 'TOOLS_REGISTRY', registry):
            microsoft.run_mcp_stdio_server()
        replies = {item['id']: item for item in map(json.loads, output.getvalue().splitlines())}
        self.assertEqual(set(replies), set(range(1, 9)))
        self.assertEqual(len(replies[2]['result']['tools']), 3)
        self.assertEqual(replies[4]['error']['code'], -32601)
        self.assertEqual(replies[5]['result']['content'][0]['text'], 'okay')
        self.assertTrue(replies[6]['result']['isError'])
        self.assertIn('not connected', replies[6]['result']['content'][0]['text'])
        self.assertIn('bad arguments', replies[7]['result']['content'][0]['text'])
        self.assertEqual(replies[8]['error']['code'], -32601)

    def test_graph_request_handles_empty_json_and_non_json_responses(self):
        client = MagicMock()
        with patch.object(microsoft, '_load_and_refresh_token', return_value={'access_token': 'fixture'}), \
             patch.object(microsoft.httpx, 'Client') as factory:
            factory.return_value.__enter__.return_value = client
            client.request.return_value.status_code = 204
            self.assertEqual(microsoft._graph_request('DELETE', '/me/item'), (204, {}))
            client.request.return_value.status_code = 200
            client.request.return_value.json.return_value = {'ok': True}
            self.assertEqual(microsoft._graph_request('GET', '/me'), (200, {'ok': True}))
            client.request.return_value.status_code = 502
            client.request.return_value.json.side_effect = ValueError('not json')
            client.request.return_value.text = 'upstream failure'
            self.assertEqual(microsoft._graph_request('GET', '/me'), (502, 'upstream failure'))
            self.assertEqual(client.request.call_args.kwargs['headers']['Authorization'], 'Bearer fixture')

    def test_token_refresh_persists_rotated_credentials(self):
        old = {'access_token': 'old', 'refresh_token': 'refresh', 'expires_at': 1, 'client_id': 'client'}
        response = MagicMock(status_code=200)
        response.json.return_value = {'access_token': 'new', 'refresh_token': 'rotated', 'expires_in': 3600}
        client = MagicMock()
        client.__enter__.return_value.post.return_value = response
        token_path = Path('/fixture/microsoft.json')
        with patch.object(microsoft.storage, 'read_user_file', return_value=json.dumps(old).encode()), \
             patch.object(microsoft.storage, 'write_user_file') as write, \
             patch.object(microsoft.httpx, 'Client', return_value=client), patch.object(microsoft.time, 'time', return_value=100):
            result = microsoft._load_and_refresh_token(token_path)
        self.assertEqual(result['access_token'], 'new')
        self.assertEqual(result['expires_at'], 3700)
        self.assertEqual(json.loads(write.call_args.args[1])['refresh_token'], 'rotated')

    def test_invalid_token_and_missing_connection_do_not_send_requests(self):
        with patch.object(microsoft.storage, 'read_user_file', return_value=b'invalid'):
            self.assertIsNone(microsoft._load_and_refresh_token(Path('/fixture/token')))
        with patch.object(microsoft, '_load_and_refresh_token', return_value=None), patch.object(microsoft.httpx, 'Client') as client:
            with self.assertRaises(PermissionError):
                microsoft._graph_request('GET', '/me')
            client.assert_not_called()

    def test_excel_range_validates_path_and_formats_values(self):
        with patch.object(microsoft, '_graph_request', return_value=(200, {'address': 'Sheet1!A1:B1', 'values': [['A', 'B']]})) as graph:
            self.assertIn('required', microsoft.tool_excel_read_range({}))
            graph.assert_not_called()
            result = json.loads(microsoft.tool_excel_read_range({'file_path': '/report.xlsx', 'sheet_name': 'Sheet1', 'range_address': 'A1:B1'}))
        self.assertEqual((result['rowCount'], result['columnCount']), (1, 2))
        self.assertIn("worksheets('Sheet1')/range(address='A1:B1')", graph.call_args.args[1])

    def test_profile_selects_expected_fields_and_falls_back_to_principal(self):
        with patch.object(microsoft, '_graph_request', return_value=(200, {'id': 'id', 'displayName': 'Name', 'userPrincipalName': 'a@example.test', 'secret': 'hidden'})):
            profile = json.loads(microsoft.tool_get_me({}))
        self.assertEqual(profile['email'], 'a@example.test')
        self.assertNotIn('secret', profile)

    def test_mail_list_bounds_results_and_formats_senders(self):
        data = {'value': [{'subject': 'Hello', 'from': {'emailAddress': {'name': 'Alice', 'address': 'a@example.test'}}, 'bodyPreview': 'x' * 250}]}
        with patch.object(microsoft, '_graph_request', return_value=(200, data)) as graph:
            messages = json.loads(microsoft.tool_list_emails({'top': 900, 'query': ' report ', 'unread_only': True}))
        self.assertEqual(messages[0]['from'], 'Alice <a@example.test>')
        self.assertEqual(len(messages[0]['preview']), 200)
        self.assertEqual(graph.call_args.kwargs['params']['$top'], '50')
        self.assertEqual(graph.call_args.kwargs['params']['$filter'], 'isRead eq false')

    def test_email_validation_prevents_requests_and_send_payload_is_correct(self):
        with patch.object(microsoft, '_graph_request', return_value=(202, {})) as graph:
            self.assertIn('required', microsoft.tool_send_email({'to': 'a@example.test'}))
            graph.assert_not_called()
            result = microsoft.tool_send_email({'to': 'a@example.test, b@example.test', 'subject': 'Hello', 'body': '<b>Hi</b>', 'is_html': True})
        self.assertIn('successfully', result)
        payload = graph.call_args.kwargs['json']['message']
        self.assertEqual(payload['body']['contentType'], 'HTML')
        self.assertEqual([r['emailAddress']['address'] for r in payload['toRecipients']], ['a@example.test', 'b@example.test'])

    def test_calendar_validation_and_creation(self):
        with patch.object(microsoft, '_graph_request', return_value=(201, {})) as graph:
            self.assertIn('required', microsoft.tool_create_calendar_event({}))
            graph.assert_not_called()
            result = microsoft.tool_create_calendar_event({'subject': 'Meeting', 'start_time': '2026-01-01T10:00:00', 'end_time': '2026-01-01T11:00:00', 'attendees': 'a@example.test', 'location': 'Room'})
        self.assertIn('created successfully', result)
        self.assertEqual(graph.call_args.kwargs['json']['attendees'][0]['emailAddress']['address'], 'a@example.test')

    def test_list_and_search_files_return_bounded_public_fields(self):
        data = {'value': [{'name': 'Folder', 'id': 'id', 'folder': {}, 'private': 'ignored'}]}
        with patch.object(microsoft, '_graph_request', return_value=(200, data)) as graph:
            result = json.loads(microsoft.tool_list_files({'folder_path': '/docs/', 'top': 999}))
            self.assertEqual(graph.call_args.args[1], '/me/drive/root:/docs:/children')
            self.assertEqual(graph.call_args.kwargs['params']['$top'], '100')
            self.assertTrue(result[0]['isFolder'])
            self.assertNotIn('private', result[0])
            graph.reset_mock()
            self.assertIn('required', microsoft.tool_search_files({'query': ' '}))
            graph.assert_not_called()
            self.assertEqual(json.loads(microsoft.tool_search_files({'query': 'report'}))[0]['name'], 'Folder')

    def test_errors_and_empty_results_are_reported(self):
        for function, args in ((microsoft.tool_get_me, {}), (microsoft.tool_list_emails, {}),
                               (microsoft.tool_list_calendar_events, {}), (microsoft.tool_list_files, {}),
                               (microsoft.tool_search_files, {'query': 'x'})):
            with self.subTest(function=function.__name__), patch.object(microsoft, '_graph_request', return_value=(403, 'denied')):
                self.assertIn('Error', function(args))
        with patch.object(microsoft, '_graph_request', return_value=(200, {'value': []})):
            self.assertIn('No calendar events', microsoft.tool_list_calendar_events({}))
            self.assertIn('No emails', microsoft.tool_list_emails({}))
            self.assertIn('No files', microsoft.tool_list_files({}))


if __name__ == '__main__':
    unittest.main()
