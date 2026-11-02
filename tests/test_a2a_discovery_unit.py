"""Agent card discovery validation and credential redirect boundaries."""
import unittest
from unittest.mock import patch
import httpx
from app import a2a_client


class AgentDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def discover(self, handler, **kwargs):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(a2a_client.httpx, 'AsyncClient', return_value=client):
            return await a2a_client.discover_agent('https://agent.example/card', **kwargs)

    async def test_v1_interface_and_card_metadata_are_returned(self):
        card = {'name':'Analyst', 'description':'Explains results',
                'supportedInterfaces':[{'protocolBinding':'GRPC','url':'https://agent.example/grpc'},
                                       {'protocolBinding':'JSONRPC','url':'https://agent.example/rpc','protocolVersion':'1.0'}],
                'securitySchemes':{'api':{'type':'apiKey','name':'x-agent-key'}},
                'capabilities':{'streaming':True}, 'skills':[{'id':'search','name':'Search','description':'Find items'}, None],
                'iconUrl':'https://agent.example/icon.png'}
        result = await self.discover(lambda req: httpx.Response(200, json=card))
        self.assertEqual(result['endpoint'], 'https://agent.example/rpc')
        self.assertEqual(result['protocol_version'], '1.0')
        self.assertEqual(result['api_key_header'], 'x-agent-key')
        self.assertEqual(result['skills'], [{'id':'search','name':'Search','description':'Find items'}])
        self.assertTrue(result['streaming'])

    async def test_redirect_credentials_are_limited_to_original_origin(self):
        requests = []
        def handle(req):
            requests.append(req)
            if len(requests) == 1:
                return httpx.Response(302, headers={'location':'https://other.example/card'})
            return httpx.Response(200, json={'url':'https://other.example/rpc'})
        result = await self.discover(handle, bearer_token='secret', api_key='key')
        self.assertEqual(result['endpoint'], 'https://other.example/rpc')
        self.assertEqual(requests[0].headers['authorization'], 'Bearer secret')
        self.assertEqual(requests[0].headers['x-api-key'], 'key')
        self.assertNotIn('authorization', requests[1].headers)
        self.assertNotIn('x-api-key', requests[1].headers)

    async def test_invalid_cards_and_versions_are_rejected(self):
        examples = [([], 'JSON object'),
                    ({'supportedInterfaces':[{'protocolBinding':'GRPC'}]}, 'no JSON-RPC interface'),
                    ({'preferredTransport':'GRPC'}, 'does not prefer JSON-RPC'),
                    ({'url':'https://agent.example/rpc','protocolVersion':'2.0'}, 'not supported')]
        for card, error in examples:
            with self.subTest(card=card), self.assertRaisesRegex(ValueError, error):
                await self.discover(lambda req: httpx.Response(200, json=card))

    async def test_redirect_requires_location_and_is_bounded(self):
        with self.assertRaisesRegex(ValueError, 'no destination'):
            await self.discover(lambda req: httpx.Response(302))
        with self.assertRaisesRegex(ValueError, 'Too many'):
            await self.discover(lambda req: httpx.Response(302, headers={'location':'/card'}))

    async def test_credentials_reject_header_injection(self):
        for kwargs in [{'bearer_token':'a\nb'}, {'api_key':'a\rb'},
                       {'api_key':'secret', 'api_key_header':'Authorization'},
                       {'api_key':'secret', 'api_key_header':'Bad Header'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                await self.discover(lambda req: self.fail('request should not be made'), **kwargs)

    async def test_nonstream_response_size_is_bounded(self):
        response = httpx.Response(200, content=b'x' * 11)
        with patch.object(a2a_client, 'MAX_RESPONSE_BYTES', 10):
            with self.assertRaisesRegex(ValueError, 'download limit'):
                await a2a_client._bound_response(response)
        event_stream = httpx.Response(200, headers={'content-type':'text/event-stream'}, content=b'x'*11)
        with patch.object(a2a_client, 'MAX_RESPONSE_BYTES', 10):
            await a2a_client._bound_response(event_stream)
