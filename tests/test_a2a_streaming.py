import unittest
import json
import httpx
from unittest.mock import patch
from app.a2a_client import StreamState, sse_messages, _result_text, send_message

class A2AStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_unauthenticated_agent_omits_authorization_and_api_key_headers(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, json={'result': {'parts': [{'text': 'Public answer'}]}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch('app.a2a_client.httpx.AsyncClient', return_value=client):
            result = await send_message({'protocol_version': '0.3', 'endpoint': 'https://example.test',
                                        'auth_token': '', 'api_key': ''}, 'status')
        self.assertEqual(result['text'], 'Public answer')
        self.assertNotIn('authorization', requests[0].headers)
        self.assertNotIn('x-api-key', requests[0].headers)

    async def test_cli_uses_stream_and_stops_at_terminal_event(self):
        methods = []
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                frames = [
                    {'kind': 'artifact-update', 'taskId': 't', 'artifact': {'artifactId': 'a', 'parts': [{'text': 'Complete answer'}]}},
                    {'kind': 'status-update', 'taskId': 't', 'status': {'state': 'completed'}, 'final': True},
                ]
                for frame in frames:
                    yield ('data: ' + json.dumps({'result': frame}) + '\n\n').encode()
                raise AssertionError('Client waited for connection closure after completion')
        def handle(request):
            if request.method == 'GET':
                self.assertEqual(request.headers['x-api-key'], 'test-key')
                return httpx.Response(200, json={'capabilities': {'streaming': True}})
            methods.append(json.loads(request.content)['method'])
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=Stream())
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch('app.a2a_client.httpx.AsyncClient', return_value=client):
            result = await send_message({'protocol_version': '0.3', 'endpoint': 'https://example.test',
                'card_url': 'https://example.test/card', 'api_key': 'test-key'}, 'status')
        self.assertEqual(result['text'], 'Complete answer')
        self.assertEqual(methods, ['message/stream'])

    async def test_send_message_preserves_complete_task_and_raises_failures(self):
        for state in ['completed', 'failed']:
            def handle(request):
                return httpx.Response(200, json={'result': {'id': 't', 'contextId': 'ctx',
                    'status': {'state': state, 'message': {'parts': [{'text': 'Cluster check failed' if state == 'failed' else 'Done'}]}},
                    'artifacts': [{'parts': [{'text': 'Pods'}]}, {'parts': [{'text': 'Nodes'}]}]}})
            client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
            with patch('app.a2a_client.httpx.AsyncClient', return_value=client):
                agent = {'protocol_version': '0.3', 'endpoint': 'https://example.test'}
                if state == 'failed':
                    with self.assertRaisesRegex(RuntimeError, 'Cluster check failed'):
                        await send_message(agent, 'status')
                else:
                    result = await send_message(agent, 'status')
                    self.assertEqual(result, {'text': 'Pods\n\nNodes', 'context_id': 'ctx'})

    def test_all_artifacts_take_priority_over_status(self):
        task = {'id': 't', 'status': {'state': 'completed', 'message': {'parts': [{'text': 'Done'}]}},
                'artifacts': [{'parts': [{'text': 'Pods'}]}, {'parts': [{'text': 'Nodes'}]}]}
        self.assertEqual(_result_text(task)[0], 'Pods\n\nNodes')

    def test_structured_data_and_files_survive_both_paths(self):
        artifact = {'artifactId': 'a', 'parts': [{'text': 'Cluster'}, {'kind': 'data', 'data': {'pods': ['p1', 'p2']}},
                    {'kind': 'file', 'file': {'name': 'report.json', 'uri': 'https://example.test/report.json'}}]}
        text = _result_text({'artifacts': [artifact]})[0]
        state = StreamState()
        state.consume({'result': {'artifact': artifact}})
        for value in ['Cluster', 'p1', 'p2', 'report.json', 'https://example.test/report.json']:
            self.assertIn(value, text)
            self.assertIn(value, state.text)

    async def test_unfinished_task_is_not_returned_as_success(self):
        def handle(request):
            return httpx.Response(200, json={'result': {'id': 't', 'status': {'state': 'working',
                    'message': {'parts': [{'text': 'Checking cluster'}]}}}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch('app.a2a_client.httpx.AsyncClient', return_value=client), patch.dict('os.environ', {'BOB_REQUEST_TIMEOUT': '0.001'}):
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                await send_message({'protocol_version': '0.3', 'endpoint': 'https://example.test'}, 'cluster status')

    async def test_stream_final_task_recovers_missing_artifacts(self):
        methods = []
        def handle(request):
            import json
            method = json.loads(request.content)['method']
            methods.append(method)
            if method == 'message/stream':
                frame = {'result': {'kind': 'artifact-update', 'taskId': 't', 'contextId': 'ctx',
                                   'artifact': {'artifactId': 'a', 'parts': [{'text': 'Pods'}]}}}
                return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content='data: ' + json.dumps(frame) + '\n\n')
            return httpx.Response(200, json={'result': {'id': 't', 'contextId': 'ctx', 'status': {'state': 'completed'},
                'artifacts': [{'artifactId': 'a', 'parts': [{'text': 'Pods'}]}, {'artifactId': 'b', 'parts': [{'text': 'Nodes'}]}]}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        events = []
        async def receive(event): events.append(event)
        with patch('app.a2a_client.httpx.AsyncClient', return_value=client):
            result = await send_message({'protocol_version': '0.3', 'endpoint': 'https://example.test', 'streaming': True},
                                        'cluster status', on_event=receive)
        self.assertEqual(result['text'], 'Pods\n\nNodes')
        self.assertEqual(methods, ['message/stream', 'tasks/get'])
        self.assertEqual(events[-1]['text'], '\n\nNodes')

    def test_append_snapshot_and_replacement(self):
        state = StreamState()
        def artifact(text, append=False):
            return {'result': {'artifactUpdate': {'contextId':'ctx','artifact':{'artifactId':'a','parts':[{'text':text}]},'append':append}}}
        self.assertEqual(state.consume(artifact('Hello '))[-1]['text'], 'Hello ')
        self.assertEqual(state.consume(artifact('world', True))[-1]['text'], 'world')
        self.assertEqual(state.consume(artifact('Hello world')), [])
        event = state.consume(artifact('Revised answer'))[-1]
        self.assertTrue(event['replace'])
        self.assertEqual(event['text'], 'Revised answer')
        self.assertEqual(state.context_id, 'ctx')

    def test_legacy_events_and_terminal_status(self):
        state = StreamState()
        event = {'result':{'kind':'artifact-update','artifact':{'artifactId':'a','parts':[{'kind':'text','text':' A\n'}]}}}
        self.assertEqual(state.consume(event)[-1]['text'], ' A\n')
        state.consume({'result':{'status':{'state':'completed','message':{'parts':[{'text':'Done'}]}}}})
        self.assertEqual(state.text, ' A\n')
        with self.assertRaisesRegex(RuntimeError, 'failed'):
            state.consume({'result':{'status':{'state':'failed'}}})

    async def test_sse_framing(self):
        response = httpx.Response(200, content=b':keepalive\r\ndata: {"result":\r\ndata: {"parts": [{"text": "hello"}]}}\r\n\r\ndata: {"result": {"parts": [{"text": "last"}]}}')
        frames = [item async for item in sse_messages(response)]
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[-1]['result']['parts'][0]['text'], 'last')

if __name__ == '__main__': unittest.main()
