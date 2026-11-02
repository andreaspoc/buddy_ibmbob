"""Synthetic protocol tests: warmup never prompts or acts before job handoff."""
import asyncio
import os
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

from app.acp_bridge import BobACPBridge


class AgentWarmupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = BobACPBridge()
        self.events = []
        self.ready = asyncio.Event()
        self.prompt_started = asyncio.Event()
        self.job = {'id': 'job-a', 'worker_token': 'lease-a', 'username': 'alice',
                    'workspace_id': 'conversation-a', 'payload': {
                        'approval_policy': {'mode': 'auto', 'actions': []}}}
        self.options = {'workspace': '/tmp/synthetic-workspace-a',
                        'user_home': '/tmp/synthetic-home-a', 'mode': 'agent'}

        @asynccontextmanager
        async def broker(*args, **kwargs):
            yield '/tmp/synthetic-broker.sock'

        @asynccontextmanager
        async def environment(*args, **kwargs):
            yield {'HOME': self.options['user_home']}

        @asynccontextmanager
        async def process(client, workspace, child_env, **kwargs):
            self.events.append(('process', workspace, child_env['HOME']))

            async def initialize(**kwargs):
                self.events.append(('initialize',))

            async def new_session(**kwargs):
                self.events.append(('session', kwargs['cwd']))
                self.ready.set()
                return SimpleNamespace(session_id='synthetic-session')

            async def prompt(**kwargs):
                self.prompt_started.set()
                self.events.append(('prompt', kwargs['session_id']))
                await client.queue.put({'type': 'tool', 'name': 'synthetic-read', 'status': 'completed'})
                await client.queue.put({'type': 'delta', 'text': 'Synthetic verified response'})
                return SimpleNamespace(stop_reason='end_turn')

            try:
                yield SimpleNamespace(initialize=initialize, new_session=new_session, prompt=prompt), SimpleNamespace()
            finally:
                self.events.append(('closed',))

        self.patches = [
            patch('app.agent_budget._reserve_user_action'),
            patch.dict(os.environ, {'BOB_API_KEY': 'synthetic-key'}),
            patch('app.acp_bridge.knowledge_broker', broker),
            patch('app.acp_bridge.mcp_broker', broker),
            patch('app.acp_bridge.approval_child_environment', environment),
            patch('app.acp_bridge.approval_agent_process', process),
            patch('app.acp_bridge._get_task_usage', return_value={}),
            patch('app.mcp_access.allowed_servers', return_value={}),
            patch('app.chat_guidance.supported', return_value=False),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def asyncTearDown(self):
        for job_id in list(self.bridge._approval_warmups):
            await self.bridge.release_prepared(job_id)

    async def test_preparation_overlaps_but_no_prompt_until_handoff(self):
        warm = self.bridge.prewarm_approval(self.job, **self.options)
        await asyncio.wait_for(self.ready.wait(), 1)
        self.assertFalse(self.prompt_started.is_set())
        self.assertFalse(warm.task.done())
        events = [event async for event in self.bridge.stream_with_approvals('Synthetic question', self.job, **self.options)]
        self.assertEqual(sum(event[0] == 'process' for event in self.events), 1)
        self.assertEqual(sum(event[0] == 'session' for event in self.events), 1)
        self.assertEqual(self.events[-1], ('closed',))
        self.assertEqual([event['text'] for event in events if event['type'] == 'delta'], ['Synthetic verified response'])
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual({event['phase'] for event in events if event['type'] == 'timing'},
                         {'agent_process_started', 'agent_ready', 'prompt_submitted'})
        self.assertFalse(self.bridge._approval_warmups)

    async def test_cancel_preparation_closes_without_running_any_action(self):
        self.bridge.prewarm_approval(self.job, **self.options)
        await asyncio.wait_for(self.ready.wait(), 1)
        await self.bridge.release_prepared(self.job['id'])
        self.assertFalse(self.prompt_started.is_set())
        self.assertEqual(self.events[-1], ('closed',))
        self.assertFalse(self.bridge._approval_warmups)

    async def test_attempt_user_workspace_and_home_cannot_reuse_another_handle(self):
        self.bridge.prewarm_approval(self.job, **self.options)
        for change in ({'username': 'bob'}, {'worker_token': 'lease-b'}, {'workspace_id': 'conversation-b'}):
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                self.bridge.prewarm_approval({**self.job, **change}, **self.options)
        for change in ({'workspace': '/tmp/other'}, {'user_home': '/tmp/other-home'}, {'mode': 'other'}):
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                self.bridge.prewarm_approval(self.job, **{**self.options, **change})
        self.assertFalse(self.prompt_started.is_set())

    async def test_initialization_failure_is_not_retried_or_replayed(self):
        @asynccontextmanager
        async def failure(*args, **kwargs):
            raise RuntimeError('Synthetic startup failure')
            yield
        with patch('app.acp_bridge.approval_agent_process', failure):
            events = [event async for event in self.bridge.stream_with_approvals('Synthetic question', self.job, **self.options)]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('Synthetic startup failure', events[-1]['message'])
        self.assertFalse(self.prompt_started.is_set())
        self.assertFalse(self.bridge._approval_warmups)

    async def test_startup_timeout_closes_before_reporting_terminal_error(self):
        self.bridge.timeout_seconds = .03
        closed = asyncio.Event()
        @asynccontextmanager
        async def blocked_process(*args, **kwargs):
            async def blocked(**kwargs):
                await asyncio.Event().wait()
            try:
                yield SimpleNamespace(initialize=blocked), SimpleNamespace()
            finally:
                closed.set()
        with patch('app.acp_bridge.approval_agent_process', blocked_process):
            events = [event async for event in self.bridge.stream_with_approvals('Synthetic question', self.job, **self.options)]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('time limit', events[-1]['message'])
        self.assertTrue(closed.is_set())
        self.assertFalse(self.bridge._approval_warmups)

    async def test_presentation_execution_uses_its_own_timeout_and_closes(self):
        self.bridge.timeout_seconds = 1
        self.bridge.presentation_timeout_seconds = .04
        closed = asyncio.Event()
        @asynccontextmanager
        async def blocked_process(*args, **kwargs):
            async def initialize(**kwargs):
                pass
            async def new_session(**kwargs):
                return SimpleNamespace(session_id='synthetic-presentation')
            async def prompt(**kwargs):
                self.prompt_started.set()
                await asyncio.Event().wait()
            try:
                yield SimpleNamespace(initialize=initialize,new_session=new_session,prompt=prompt), SimpleNamespace()
            finally:
                closed.set()
        with patch('app.acp_bridge.approval_agent_process', blocked_process):
            options = {**self.options, 'mode': 'presentation'}
            events = [event async for event in self.bridge.stream_with_approvals('Synthetic presentation', self.job, **options)]
        self.assertTrue(self.prompt_started.is_set())
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('time limit', events[-1]['message'])
        self.assertTrue(closed.is_set())

    async def test_unexpected_owner_exit_does_not_hang_or_expose_details(self):
        async def broken(*args, **kwargs):
            raise RuntimeError('Synthetic internal diagnostic with a secret')
        with patch.object(self.bridge, '_run_approval_runtime', broken):
            async def collect():
                return [event async for event in self.bridge.stream_with_approvals('Synthetic question', self.job, **self.options)]
            events = await asyncio.wait_for(collect(), 1)
        self.assertEqual(events[-1]['type'], 'error')
        self.assertNotIn('secret', events[-1]['message'])
        self.assertFalse(self.bridge._approval_warmups)

    async def test_other_execution_paths_are_not_warmed(self):
        for key, value in [('agent_name', 'remote'), ('research', {'enabled': True}), ('workflow', {'steps': []})]:
            job = {**self.job, 'payload': {**self.job['payload'], key: value}}
            self.assertIsNone(self.bridge.prewarm_approval(job, **self.options))
        self.assertFalse(self.bridge._approval_warmups)


if __name__ == '__main__':
    unittest.main()
