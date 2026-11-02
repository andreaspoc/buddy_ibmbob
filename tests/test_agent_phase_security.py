"""Execute production phase orchestration with synthetic ACP/service adapters."""
import ast
import asyncio
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import sys
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import app


class PhaseSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.budget = SimpleNamespace(username='owner', consume=AsyncMock())
        self.context = {'agent_budget': self.budget}
        access = ModuleType('app.mcp_access')
        access.allowed_servers = lambda username: {'selected': {'command': 'synthetic-backend'}}
        actions = ModuleType('app.app_actions')
        actions.action_context = SimpleNamespace(get=lambda: self.context)
        self.guidance = ModuleType('app.chat_guidance')
        self.guidance.supported = lambda payload: False
        self.guidance.open_intake = lambda *args: None
        self.guidance.instructions = lambda *args, **kwargs: []
        self.guidance.close_if_ready = lambda *args: True
        self.connection = SimpleNamespace(initialize=AsyncMock(),
            new_session=AsyncMock(return_value=SimpleNamespace(session_id='synthetic-session')),
            prompt=AsyncMock(return_value=SimpleNamespace(stop_reason='end_turn')))
        self.capture = {}
        @asynccontextmanager
        async def knowledge(*args, **kwargs):
            self.capture['knowledge'] = kwargs
            yield '/tmp/synthetic-knowledge.sock'
        @asynccontextmanager
        async def broker(**kwargs):
            self.capture['broker'] = kwargs
            yield '/tmp/synthetic-mcp.sock'
        @asynccontextmanager
        async def environment(*args):
            yield {'HOME': '/tmp/synthetic-home'}
        @asynccontextmanager
        async def process(*args, **kwargs):
            yield self.connection, SimpleNamespace()
        self.guided_prompt = AsyncMock(return_value=(SimpleNamespace(stop_reason='end_turn'), False))
        namespace = {'asyncio': asyncio, 'time': time, 'os': os, 'Path': Path,
            'logger': logging.getLogger('synthetic-agent-phase'), 'PROTOCOL_VERSION': 1,
            'knowledge_broker': knowledge, 'mcp_broker': broker,
            'approval_child_environment': environment, 'approval_agent_process': process,
            'TextContentBlock': lambda **kwargs: kwargs,
            '_task_exists': lambda *args: False, '_get_task_usage': lambda *args: {},
            '_approval_error_detail': lambda exc, *args: str(exc),
            '_approval_stderr_detail': lambda *args: '', 'prompt_with_guidance': self.guided_prompt}
        tree = ast.parse(Path('app/acp_bridge.py').read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'BobACPBridge')
        method = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_execute_approval_runtime')
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'app/acp_bridge.py', 'exec'), namespace)
        self.execute = namespace['_execute_approval_runtime']
        self.bridge = SimpleNamespace(timeout_seconds=2, _requested_mcp_servers=lambda *args: ['selected'])
        self.client = SimpleNamespace(activity_secrets=[], queue=asyncio.Queue())
        self.job = {'id': 'synthetic-job', 'worker_token': 'synthetic-lease', 'username': 'owner',
                    'payload': {'research': {'topic': 'synthetic'}, 'agent_slugs': ['selected-agent']}}
        for mocking in (patch.dict(sys.modules, {'app.mcp_access': access, 'app.app_actions': actions,
                                                 'app.chat_guidance': self.guidance}),
                        patch.object(app, 'chat_guidance', self.guidance, create=True),
                        patch.dict(os.environ, {'BOB_API_KEY': 'synthetic-not-a-real-key'})):
            mocking.start()
            self.addCleanup(mocking.stop)
        async def immediate(function, *args, **kwargs): return function(*args, **kwargs)
        mocking = patch('asyncio.to_thread', immediate)
        mocking.start()
        self.addCleanup(mocking.stop)

    async def run_phase(self):
        submitted = asyncio.get_running_loop().create_future()
        submitted.set_result('Synthetic phase question')
        await self.execute(self.bridge, self.client, submitted, self.job,
                           workspace='/tmp/synthetic-work', user_home='/tmp/synthetic-home', mode='agent')
        events = []
        while not self.client.queue.empty(): events.append(self.client.queue.get_nowait())
        return events

    async def test_research_phase_binds_approval_scope_identity_and_shared_budget(self):
        events = await self.run_phase()
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(self.client.actor_username, 'owner')
        self.assertIs(self.client.execution_budget, self.budget)
        self.assertIs(self.capture['knowledge']['budget'], self.budget)
        broker = self.capture['broker']
        self.assertIs(broker['budget'], self.budget)
        self.assertEqual(broker['allowed_agents'], ['selected-agent'])
        self.assertEqual(broker['active_servers'], ['selected'])
        self.assertTrue(callable(broker['authorize']))
        self.budget.consume.assert_awaited_once_with('inference')
        self.connection.prompt.assert_awaited_once()

    async def test_each_guidance_reprompt_reserves_inference_quota(self):
        self.guidance.supported = lambda payload: True
        # Adapter accepts protocol identifiers while the sequence controls completion.
        sequence = iter([False, True])
        self.guidance.close_if_ready = lambda *args: next(sequence)
        events = await self.run_phase()
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(self.guided_prompt.await_count, 2)
        self.assertEqual([call.args for call in self.budget.consume.await_args_list], [('inference',), ('inference',)])

    async def test_exhausted_quota_blocks_prompt_and_wrong_owner_blocks_brokers(self):
        self.budget.consume.side_effect = PermissionError('Synthetic quota exhausted')
        events = await self.run_phase()
        self.assertEqual(events[-1]['type'], 'error')
        self.connection.prompt.assert_not_awaited()
        self.budget.username = 'other'
        self.capture.clear()
        events = await self.run_phase()
        self.assertEqual(events[-1]['type'], 'error')
        self.assertEqual(self.capture, {})


if __name__ == '__main__': unittest.main()
