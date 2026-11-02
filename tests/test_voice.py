"""Synthetic provider responses: authentication, error redaction and streaming cleanup."""
import os
import unittest
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import voice
from app.auth import current_user

class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.app=FastAPI()
        self.app.include_router(voice.router)
        self.app.dependency_overrides[current_user]=lambda:{'username':'voice-test'}
        self.client=TestClient(self.app)
        self.config=patch.object(voice,'configuration',return_value={'api_key':'secret-fixture','voice_id':'fixture-voice','model_id':'eleven_multilingual_v2'})
        self.config.start()
        voice._requests.clear()
        voice._ws_users.clear()
        voice._ws_slots=__import__('asyncio').Semaphore(12)
        voice._slots=__import__('asyncio').Semaphore(4)
        self.addCleanup(self.config.stop)
    def provider(self, handler):
        client_type=httpx.AsyncClient
        return patch.object(voice.httpx,'AsyncClient',side_effect=lambda **kwargs:client_type(transport=httpx.MockTransport(handler),**kwargs))
    def test_status_never_exposes_key(self):
        response=self.client.get('/voice/status')
        self.assertEqual(response.json(),{'configured':True,'voice_id':'fixture-voice'})
        self.assertNotIn('secret',response.text)
    def test_routes_require_authentication(self):
        self.app.dependency_overrides.clear()
        self.assertIn(self.client.get('/voice/status').status_code,(401,403))
    def test_unconfigured_provider_and_validation(self):
        with patch.object(voice,'configuration',return_value={'api_key':'','voice_id':''}):
            self.assertEqual(self.client.get('/voice/voices').status_code,503)
        self.assertEqual(self.client.post('/voice/speech',json={'text':' ','voice_id':'x'}).status_code,422)
        self.assertEqual(self.client.post('/voice/speech',json={'text':'x','voice_id':'../bad'}).status_code,422)
        self.assertEqual(self.client.post('/voice/speech',json={'text':'x'*3001,'voice_id':'x'}).status_code,422)
    def test_voice_list_only_returns_display_fields(self):
        with self.provider(lambda r:httpx.Response(200,json={'voices':[{'voice_id':'one','name':'Fixture','private':'hidden'}]})):
            self.assertEqual(self.client.get('/voice/voices').json()['voices'],[{'id':'one','name':'Fixture'}])
    def test_audio_proxy_and_connection_cleanup(self):
        def handler(request):
            self.assertEqual(request.headers['xi-api-key'],'secret-fixture')
            self.assertEqual(request.url.host,'api.elevenlabs.io')
            return httpx.Response(200,content=b'synthetic-audio')
        with self.provider(handler):
            response=self.client.post('/voice/speech',json={'text':'Hello','voice_id':'fixture'})
        self.assertEqual(response.content,b'synthetic-audio')
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertEqual(voice._slots._value,4)
    def test_provider_errors_redact_payload_and_release_slot(self):
        for upstream, expected in [(401,502),(402,402),(429,429),(500,502)]:
            with self.provider(lambda r:httpx.Response(upstream,text='secret-fixture provider internals')):
                response=self.client.post('/voice/speech',json={'text':'Hello','voice_id':'fixture'})
            self.assertEqual(response.status_code,expected)
            self.assertNotIn('secret-fixture',response.text)
            self.assertEqual(voice._slots._value,4)
    def test_per_user_rate_limit(self):
        import time
        voice._requests['voice-test'].extend([time.monotonic()]*90)
        self.assertEqual(self.client.post('/voice/speech',json={'text':'Hello','voice_id':'fixture'}).status_code,429)

class FakeProvider:
    def __init__(self, kind):
        import asyncio
        self.kind=kind; self.sent=[]; self.queue=asyncio.Queue()
        if kind=='listen':self.queue.put_nowait(__import__('json').dumps({'message_type':'session_started'}))
    async def __aenter__(self):return self
    async def __aexit__(self,*args):pass
    async def send(self, raw):
        import json,base64
        data=json.loads(raw);self.sent.append(data)
        if data.get('message_type')=='input_audio_chunk':
            await self.queue.put(json.dumps({'message_type':'partial_transcript','text':'Hello fixture'}))
            await self.queue.put(json.dumps({'message_type':'committed_transcript','text':'Hello fixture'}))
        elif data.get('text')=='':
            await self.queue.put(json.dumps({'audio':base64.b64encode(b'\x00\x00'*20).decode()}))
            await self.queue.put(json.dumps({'isFinal':True}))
    def __aiter__(self):return self
    async def __anext__(self):return await self.queue.get()

class VoiceSocketTests(VoiceTests):
    def test_rejects_cross_origin_and_unauthenticated_socket(self):
        from starlette.websockets import WebSocketDisconnect
        for origin in ['https://wrong.example','http://testserver']:
            with self.assertRaises(WebSocketDisconnect) as error:
                with self.client.websocket_connect('/voice/listen',headers={'origin':origin}):pass
            self.assertEqual(error.exception.code,1008)
    def test_streaming_transcripts_and_speech_keep_credentials_server_side(self):
        from unittest.mock import AsyncMock
        import json
        for kind in ['listen','speak']:
            provider=FakeProvider(kind)
            with patch.object(voice,'current_user',AsyncMock(return_value={'username':'voice-socket-fixture'})),patch.object(voice,'ws_connect',return_value=provider):
                with self.client.websocket_connect('/voice/'+kind,headers={'origin':'http://testserver'}) as ws:
                    if kind=='listen':
                        self.assertEqual(ws.receive_json(),{'type':'ready'})
                        ws.send_bytes(b'\x00\x00'*2048)
                        self.assertEqual(ws.receive_json(),{'type':'partial','text':'Hello fixture'})
                        self.assertEqual(ws.receive_json(),{'type':'transcript','text':'Hello fixture'})
                    else:
                        ws.send_json({'voice_id':'fixture'})
                        self.assertEqual(ws.receive_json(),{'type':'ready'})
                        ws.send_json({'text':'Hello fixture. ','flush':True})
                        ws.send_json({'done':True})
                        self.assertEqual(ws.receive_bytes(),b'\x00\x00'*20)
                        self.assertEqual(ws.receive_json(),{'type':'done'})
                for _ in range(50):
                    if 'voice-socket-fixture' not in voice._ws_users:
                        break
                    __import__('time').sleep(0.01)
                self.assertNotIn('voice-socket-fixture',voice._ws_users)
                self.assertEqual(voice._ws_slots._value,12)
    def test_discussion_skips_visual_policies_even_after_visual_chat(self):
        from app.chat_response_policy import response_policies
        from app.skill_routing import add_skill_routing
        from app.voice_policy import discussion_persona
        diagram, policy = response_policies({'voice_mode':True,'prompt':'Compare those results','mode':'agent'},[{'type':'request','prompt':'Create charts and a report'}])
        self.assertEqual(diagram,'')
        self.assertIn('brief natural spoken sentences',policy)
        routed=add_skill_routing('Compare results',[{'name':'data-buddy','description':'Data'}],request_prompt='Compare results',voice_mode=True)
        self.assertNotIn('Data visualization guidance:',routed)
        persona=discussion_persona('Identity\n- FOLLOW-UP QUESTIONS IN INTERACTIVE FORMS: use cards\nGroundedness\n[LEGACY MERMAID SYNTAX - details]')
        self.assertIn('Identity',persona)
        self.assertIn('Groundedness',persona)
        self.assertNotIn('INTERACTIVE FORMS',persona)
        self.assertNotIn('MERMAID',persona)
    def test_discussion_policy_is_scoped_to_the_voice_turn(self):
        prompt=voice.discussion_prompt('Explain the case')
        self.assertTrue(prompt.startswith('Explain the case'))
        self.assertIn('brief natural spoken sentences',prompt)
        self.assertIn('follow-up question forms',prompt)
        self.assertIn('only to this voice turn',prompt)

if __name__=='__main__':unittest.main()
