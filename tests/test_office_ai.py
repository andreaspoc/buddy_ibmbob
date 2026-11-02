"""Office AI adapter: authenticated text-only ACP, limits, privacy and stream shape."""
import asyncio
import json
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import office_ai

class OfficeAITests(TestCase):
    def test_bounds_and_model_validation(self):
        for payload in ({'model':'other','messages':[{'role':'user','content':'hello'}]},
                        {'messages':[{'role':'user','content':' '}]},
                        {'messages':[{'role':'user','content':'x'*40000}]*2},
                        {'messages':[{'role':'tool','content':'execute'}]}):
            with self.assertRaises(ValidationError): office_ai.Completion(**payload)

    def test_config_has_bob_and_no_server_credentials(self):
        with patch.dict('os.environ',{'BOB_API_KEY':'unit-secret-never-expose','OFFICE_JWT_SECRET':'other-secret'}):
            config=office_ai.config({'username':'alice'})
        raw=json.dumps(config)
        self.assertNotIn('unit-secret-never-expose',raw)
        self.assertNotIn('other-secret',raw)
        self.assertTrue(all(action['model']=='bob-acp' for action in config['actions'].values()))
        self.assertEqual(config['storage']['providers']['Bob ACP']['key'],'')
        self.assertIn('X-Bob-UI-Language',config['storage']['customProviders']['Bob ACP'])

    def test_prompt_keeps_roles_as_data_and_uses_language(self):
        req=office_ai.Completion(messages=[office_ai.Message(role='user',content='Example VBA: MsgBox "Hello"')])
        prompt=office_ai.prompt_for(req,'el')
        self.assertIn('respond in Greek',prompt)
        self.assertIn('not native VBA',prompt)
        self.assertIn('"role": "user"',prompt)

    def test_tools_are_never_autoapproved(self):
        result=asyncio.run(office_ai.OfficeClient().request_permission('session',{},[]))
        self.assertEqual(result,{'outcome':{'outcome':'cancelled'}})

    def test_api_requires_existing_login_and_rejects_cross_origin(self):
        app=FastAPI();app.include_router(office_ai.router)
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/office/ai/config').status_code,401)
            self.assertEqual(client.get('/api/office/ai/v1/models').status_code,401)
        app.dependency_overrides[office_ai.current_user]=lambda:{'username':'alice'}
        with TestClient(app) as client:
            response=client.post('/api/office/ai/v1/chat/completions',headers={'Origin':'https://elsewhere.example'},json={'messages':[{'role':'user','content':'hello'}]})
            self.assertEqual(response.status_code,403)

    def test_completed_api_response_uses_acp_and_ui_language(self):
        app=FastAPI();app.include_router(office_ai.router)
        app.dependency_overrides[office_ai.current_user]=lambda:{'username':'alice'}
        with patch.dict('os.environ',{'BOB_API_KEY':'test'}),patch.object(office_ai,'run_acp',new_callable=AsyncMock,return_value='Απάντηση') as run:
            with TestClient(app) as client:
                response=client.post('/api/office/ai/v1/chat/completions',headers={'X-Bob-UI-Language':'el'},json={'messages':[{'role':'user','content':'hello'}]})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['choices'][0]['message']['content'],'Απάντηση')
            self.assertEqual(run.call_args.args[1],'el')
            self.assertNotIn('alice',office_ai._active)

    def test_streamed_acp_response_and_cleanup(self):
        async def source(req,language,on_text):
            await on_text('Hello');await on_text(' ACP');return 'Hello ACP'
        app=FastAPI();app.include_router(office_ai.router)
        app.dependency_overrides[office_ai.current_user]=lambda:{'username':'alice'}
        with patch.dict('os.environ',{'BOB_API_KEY':'test'}),patch.object(office_ai,'run_acp',side_effect=source):
            with TestClient(app) as client:
                response=client.post('/api/office/ai/v1/chat/completions',json={'stream':True,'messages':[{'role':'user','content':'hello'}]})
        self.assertEqual(response.status_code,200)
        self.assertIn('data: [DONE]',response.text)
        self.assertIn('"content": "Hello"',response.text)
        self.assertIn('"content": " ACP"',response.text)
        self.assertNotIn('alice',office_ai._active)

    def test_error_never_exposes_prompt_or_credentials(self):
        with self.assertLogs(office_ai.logger,level='WARNING') as logs:
            message=office_ai.safe_error(RuntimeError('SECRET document contents'))
        self.assertNotIn('SECRET',message+' '.join(logs.output))

if __name__=='__main__': main()
