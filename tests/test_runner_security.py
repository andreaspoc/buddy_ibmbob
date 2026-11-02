import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
from contextlib import asynccontextmanager
from types import SimpleNamespace

from app.acp_bridge import BobACPBridge, bob_child_environment
import app.acp_bridge as bridge_module
from app.knowledge_broker import knowledge_broker, MAX_QUERY_BYTES


@asynccontextmanager
async def fixture_mcp_broker(**kwargs):
    assert kwargs['username'] == 'alice'
    assert kwargs['user_home']
    yield '/tmp/fixture-mcp.sock'


@asynccontextmanager
async def fixture_knowledge_broker(*args, **kwargs):
    assert kwargs['username'] == 'alice'
    assert kwargs['budget'].username == 'alice'
    yield '/tmp/fixture-search.sock'


class RunnerSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Quota storage is exercised separately; these fixtures never connect
        # to an application database or spend provider credits.
        quota = patch('app.agent_budget._reserve_user_action')
        quota.start()
        self.addCleanup(quota.stop)
        # These tests mock process creation; sandbox policy has dedicated tests.
        sandbox = patch('app.acp_bridge.sandbox_command', side_effect=lambda command, **kwargs: command)
        sandbox.start()
        self.addCleanup(sandbox.stop)

    def test_child_environment_preserves_a2a_policy(self):
        from app.a2a_client import validate_url

        policy = {'BOB_A2A_ALLOWED_ORIGINS': 'https://agent.example:7860',
                  'BOB_A2A_ALLOW_PUBLIC_PORTS': '1', 'BOB_A2A_RELAXED_ORIGINS': '1'}
        with patch.dict(os.environ, {**policy, 'DATABASE_URL': 'secret-db'}, clear=True):
            env = bob_child_environment('/private/home', '/tmp/search.sock')
        for name, value in policy.items():
            self.assertEqual(env[name], value)
        self.assertNotIn('DATABASE_URL', env)
        with patch.dict(os.environ, env, clear=True):
            validate_url('https://agent.example:7860/jsonrpc')

    def test_child_environment_excludes_service_secrets(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'secret-db', 'AZURE_CLIENT_SECRET': 'secret-oauth',
                                     'BOB_S3_SECRET_ACCESS_KEY': 'secret-s3', 'KEYCLOAK_CLIENT_SECRET': 'secret-sso',
                                     'BUDDY_MEMORY_SIGNING_KEY': 'synthetic-private-signing-key',
                                     'BOBSHELL_API_KEY': 'provider', 'PATH': '/bin', 'PYTHONPATH': 'unsafe'}, clear=True):
            env = bob_child_environment('/private/home', '/tmp/search.sock', '/tmp/mcp.sock')
        self.assertEqual(env.pop('BUDDY_NAME'), 'Buddy')
        self.assertEqual(env, {'BOBSHELL_API_KEY': 'provider', 'PATH': '/bin',
                              'HOME': '/private/home', 'BOB_KNOWLEDGE_SOCKET': '/tmp/search.sock',
                              'BOB_MCP_SOCKET': '/tmp/mcp.sock',
                              'PYTHONPATH': str(Path(bridge_module.__file__).resolve().parent.parent),
                              'PYTHONUNBUFFERED': '1', 'NODE_OPTIONS': '--no-warnings'})

    async def request(self, path, payload):
        reader, writer = await asyncio.open_unix_connection(path)
        writer.write(json.dumps(payload).encode() + b'\n')
        await writer.drain()
        result = json.loads(await reader.readline())
        writer.close()
        await writer.wait_closed()
        return result

    async def test_broker_restricts_protocol_and_cleans_up(self):
        search = AsyncMock(return_value='real retrieved passage')
        with patch('app.knowledge_broker.search_shared', search):
            async with knowledge_broker(username='alice') as path:
                self.assertEqual(Path(path).stat().st_mode & 0o777, 0o600)
                self.assertEqual((await self.request(path, {'query': 'question'}))['text'], 'real retrieved passage')
                self.assertIn('error', await self.request(path, {'query': 'question', 'username': 'other'}))
                self.assertIn('error', await self.request(path, {'query': 'x' * (MAX_QUERY_BYTES + 1)}))
            self.assertFalse(Path(path).exists())
        search.assert_awaited_once_with('question', 'alice')

    async def test_stream_routes_authenticated_job_through_permission_callbacks(self):
        captured = []
        job = {'id': 'job', 'worker_token': 'lease', 'username': 'alice',
               'payload': {'research': {'topic': 'test'}, 'session_id': 'stale',
                           'approval_policy': {'mode': 'auto', 'actions': []}}}
        async def source(client, submitted, phase_job, **kwargs):
            captured.append((client, await submitted, phase_job, kwargs))
            await client.queue.put({'type': 'done'})
        context = SimpleNamespace(get=lambda: {'job': job})
        with patch('app.app_actions.action_context', context), patch.object(BobACPBridge, '_run_approval_runtime', side_effect=source):
            events = [event async for event in BobACPBridge().stream('hello', 'current', workspace='/tmp/work', user_home='/tmp/user', username='alice')]
        self.assertEqual(events, [{'type': 'start'}, {'type': 'done'}])
        client, prompt, phase_job, paths = captured[0]
        self.assertIsInstance(client, bridge_module.ApprovalClient)
        self.assertEqual((client.job_id, client.worker_token), ('job', 'lease'))
        self.assertEqual(prompt, 'hello')
        self.assertEqual(phase_job['payload']['session_id'], 'current')
        self.assertEqual(job['payload']['session_id'], 'stale')
        self.assertEqual(paths['workspace'], '/tmp/work')
        self.assertEqual(paths['user_home'], '/tmp/user')

    async def test_stream_without_authenticated_job_fails_closed(self):
        with patch('app.app_actions.action_context', SimpleNamespace(get=lambda: None)), patch('app.acp_bridge.asyncio.create_subprocess_exec', new_callable=AsyncMock) as spawn:
            with self.assertRaisesRegex(PermissionError, 'authenticated queued job'):
                _ = [event async for event in BobACPBridge().stream('hello', username='alice')]
        spawn.assert_not_called()

    async def test_ask_passes_sanitized_environment(self):
        captured = []
        async def ask(*args):
            captured.append(args[-1])
            return {'text': 'answer'}
        with patch('app.acp_bridge.knowledge_broker', fixture_knowledge_broker), patch('app.acp_bridge.mcp_broker', fixture_mcp_broker), patch.object(BobACPBridge, '_ask', ask), patch.dict(os.environ, {'DATABASE_URL': 'secret', 'BOB_TEAM_ID': ''}):
            await BobACPBridge().ask('hello', user_home='/tmp/user', username='alice')
        self.assertNotIn('DATABASE_URL', captured[0])
        self.assertFalse(Path(captured[0]['BOB_KNOWLEDGE_SOCKET']).exists())

    async def test_legacy_cli_and_headless_stream_fail_closed_without_launch(self):
        launch = AsyncMock()
        environment = {'HOME': '/tmp/private', 'PATH': '/bin'}
        with patch('app.acp_bridge.asyncio.create_subprocess_exec', launch):
            with self.assertRaises(PermissionError):
                await BobACPBridge()._ask_via_cli('hello', '/tmp/work', '/tmp/private', environment)
            with self.assertRaises(PermissionError):
                _ = [event async for event in BobACPBridge()._stream('hello', child_env=environment)]
        launch.assert_not_called()

    async def test_acp_launch_uses_explicit_environment_and_cwd(self):
        launches = []
        conn = SimpleNamespace(initialize=AsyncMock(), new_session=AsyncMock(return_value=SimpleNamespace(session_id='s')),
                               prompt=AsyncMock(return_value=SimpleNamespace(model_dump=lambda **kwargs: {})))
        @asynccontextmanager
        async def spawn(*args, **kwargs):
            launches.append((args, kwargs))
            yield conn, None
        with patch('app.acp_bridge.knowledge_broker', fixture_knowledge_broker), patch('app.acp_bridge.mcp_broker', fixture_mcp_broker), patch('app.acp_bridge.spawn_agent_process', spawn), patch.dict(os.environ, {'BOBSHELL_API_KEY': 'provider', 'DATABASE_URL': 'secret', 'BOB_TEAM_ID': ''}):
            await BobACPBridge().ask('hello', '/tmp/work', '/tmp/private', username='alice')
        args, kwargs = launches[0]
        self.assertNotIn('--auto-approve', args)
        self.assertEqual((await args[0].request_permission('s', {}, []))['outcome']['outcome'], 'cancelled')
        self.assertNotIn('DATABASE_URL', kwargs['env'])
        self.assertEqual(kwargs['env']['HOME'], '/tmp/private')
        self.assertEqual(kwargs['cwd'], '/tmp/work')

    async def test_acp_authentication_failure_does_not_fall_back_to_cli(self):
        @asynccontextmanager
        async def failure(*args, **kwargs):
            raise RuntimeError('Authentication required')
            yield
        with patch('app.acp_bridge.spawn_agent_process', failure), patch('app.acp_bridge.asyncio.create_subprocess_exec', new_callable=AsyncMock) as launch, patch.dict(os.environ, {'BOBSHELL_API_KEY': 'provider'}):
            with self.assertRaisesRegex(RuntimeError, 'Authentication required'):
                await BobACPBridge()._ask('hello', '/tmp/work', '/tmp/private', {'HOME': '/tmp/private'})
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
