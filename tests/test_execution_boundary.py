"""Execution bypass checks through the real handler and synthetic stream transport.

The host may prohibit Unix socket binding; only the transport is adapted. JSON
parsing, authorization, scope checks, queues and backend dispatch are production.
"""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import AsyncMock, patch

from app import mcp_broker
from app.execution_policy import action_digest, requires_approval


class ExecutionBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.configs = {'selected': {'command': 'synthetic-server'},
                        'unselected': {'command': 'synthetic-server'}}
        access = ModuleType('app.mcp_access')
        access.allowed_servers = lambda username: dict(self.configs)
        access.get_authorized_server = lambda username, name: self.configs.get(name)
        app = ModuleType('app.app_actions')
        app.APP_SERVER = 'buddy-app'
        app.action_context = ContextVar('synthetic_execution_context', default=None)
        app.dispatch = AsyncMock(return_value={'content': []})
        attachments = ModuleType('app.agent_attachments')
        attachments.authorized_agent = lambda username, slug: {'endpoint': 'https://synthetic.invalid/a2a'}
        attachments.dispatch = AsyncMock(return_value={'reply': 'synthetic result'})
        self.attachments = attachments
        self.app = app
        self.modules = patch.dict(sys.modules, {'app.mcp_access': access,
            'app.app_actions': app, 'app.agent_attachments': attachments})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.budget = type('SyntheticBudget', (), {'username': 'owner'})()
        self.budget.consume = AsyncMock()
        self.execute = AsyncMock(return_value={'content': []})
        self.assert_active = AsyncMock()
        handlers = {}
        class Writer:
            def __init__(self, reader): self.reader = reader
            def write(self, value): self.reader.feed_data(value)
            async def drain(self): await asyncio.sleep(0)
            def close(self): self.reader.feed_eof()
            async def wait_closed(self): await asyncio.sleep(0)
        class Server:
            def close(self): pass
            async def wait_closed(self): pass
        async def start_server(handler, *, path, **kwargs):
            handlers[path] = handler
            Path(path).touch()
            return Server()
        async def connect(path, **kwargs):
            request_reader, response_reader = asyncio.StreamReader(), asyncio.StreamReader()
            asyncio.create_task(handlers[path](request_reader, Writer(response_reader)))
            return response_reader, Writer(request_reader)
        @asynccontextmanager
        async def session(*args, **kwargs):
            yield object()
        for mocking in (patch.object(mcp_broker, 'bootstrap_registry'),
                        patch.object(mcp_broker, 'materialize_proxies'),
                        patch.object(mcp_broker, 'open_session', session),
                        patch.object(mcp_broker, 'execute', self.execute),
                        patch('asyncio.start_unix_server', start_server),
                        patch('asyncio.open_unix_connection', connect)):
            mocking.start()
            self.addCleanup(mocking.stop)
        async def immediate(function, *args, **kwargs):
            return function(*args, **kwargs)
        mocking = patch('asyncio.to_thread', immediate)
        mocking.start()
        self.addCleanup(mocking.stop)
        mcp_broker._discovery_cache.clear()

    def broker(self, **kwargs):
        return mcp_broker.mcp_broker(username='owner',
            workspace=str(Path(self.directory.name) / 'work'),
            user_home=str(Path(self.directory.name) / 'home'),
            active_servers=['selected'], budget=self.budget, assert_active=self.assert_active, **kwargs)

    async def call(self, socket, *, server='selected', tool='send_message', arguments=None):
        return await mcp_broker.request(socket, {'action': 'call', 'server': server,
            'tool': tool, 'arguments': arguments or {'target': 'synthetic-target'}})

    async def _email_call(self, authorizer, arguments):
        from app.app_actions import action_context
        reset = action_context.set({'execution_authorizer': authorizer} if authorizer else {})
        self.addCleanup(action_context.reset, reset)
        self.configs['smtp'] = {'command': 'synthetic-server'}
        async with mcp_broker.mcp_broker(username='owner', workspace=str(Path(self.directory.name) / 'work'),
                user_home=str(Path(self.directory.name) / 'home'), active_servers=['smtp'], budget=self.budget,
                assert_active=self.assert_active, authorize=AsyncMock()) as socket:
            return await mcp_broker.request(socket, {'action': 'call', 'server': 'smtp', 'tool': 'smtp_send_email', 'arguments': arguments})

    async def test_personal_data_email_declined_never_reaches_backend(self):
        authorizer = AsyncMock()
        authorizer.authorize.side_effect = PermissionError('rejected')
        result = await self._email_call(authorizer, {'to': 'a@example.com', 'subject': 's', 'body': '99123456'})
        self.assertTrue(result['isError'])
        self.assertIn('Phone number', result['content'][0]['text'])
        self.assertNotIn('99123456', result['content'][0]['text'])
        self.execute.assert_not_awaited()
        self.assertEqual(authorizer.authorize.await_args.kwargs['personal_data'], ['Phone number'])

    async def test_personal_data_email_without_channel_is_not_sent(self):
        result = await self._email_call(None, {'to': 'a@example.com', 'subject': 's', 'body': '99123456'})
        self.assertTrue(result['isError'])
        self.execute.assert_not_awaited()

    async def test_personal_data_email_approved_carries_bound_token(self):
        authorizer = AsyncMock()
        await self._email_call(authorizer, {'to': 'a@example.com', 'subject': 's', 'body': '99123456', 'personal_data_approval': 'forged'})
        sent = self.execute.await_args.kwargs['arguments']
        self.assertNotEqual(sent['personal_data_approval'], 'forged')
        self.assertEqual(authorizer.authorize.await_args.args[0]['arguments'], {'to': 'a@example.com', 'subject': 's', 'body': '99123456'})

    async def test_clean_email_uses_normal_approval_without_token(self):
        authorizer = AsyncMock()
        await self._email_call(authorizer, {'to': 'a@example.com', 'subject': 's', 'body': 'hello'})
        authorizer.authorize.assert_not_awaited()
        self.assertNotIn('personal_data_approval', self.execute.await_args.kwargs['arguments'])

    async def test_direct_socket_call_without_approval_never_reaches_backend(self):
        async with self.broker() as socket:
            with self.assertRaises(PermissionError):
                await self.call(socket)
            self.execute.assert_not_awaited()

    async def test_scope_enforced_for_discovery_and_calls_even_with_authorizer(self):
        authorize = AsyncMock()
        async with self.broker(authorize=authorize) as socket:
            servers = await mcp_broker.request(socket, {'action': 'servers'})
            self.assertEqual({item['name'] for item in servers}, {'selected', 'buddy-app'})
            for payload in ({'action': 'tools', 'server': 'unselected'},
                            {'action': 'call', 'server': 'unselected', 'tool': 'read', 'arguments': {}}):
                with self.assertRaises(PermissionError):
                    await mcp_broker.request(socket, payload)
            self.execute.assert_not_awaited()
            authorize.assert_not_awaited()

    async def test_authorization_receives_exact_parameters_and_target_configuration(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def authorize(payload, config):
            calls.append((payload, config))
            entered.set()
            await release.wait()
        async with self.broker(authorize=authorize) as socket:
            pending = asyncio.create_task(self.call(socket, arguments={'target': 'synthetic-exact-target'}))
            await asyncio.wait_for(entered.wait(), 2)
            self.execute.assert_not_awaited()
            self.assertEqual(calls[0][0]['arguments'], {'target': 'synthetic-exact-target'})
            self.assertEqual(calls[0][1], self.configs['selected'])
            release.set()
            await pending
            self.execute.assert_awaited_once()

    async def test_rejection_and_configuration_changes_during_approval_deny_execution(self):
        async def changed(payload, config):
            self.configs['selected'] = {'command': 'different-synthetic-target'}
        for authorize in (AsyncMock(side_effect=PermissionError('synthetic denial')), changed):
            async with self.broker(authorize=authorize) as socket:
                with self.assertRaises(PermissionError):
                    await self.call(socket)
            self.execute.assert_not_awaited()

    async def test_builtin_writes_and_unknown_tools_fail_closed_but_reads_work(self):
        async with self.broker() as socket:
            await self.call(socket, server='buddy-app', tool='notes_get', arguments={'note_id': 7})
            self.app.dispatch.assert_awaited_once()
            for tool in ('notes_create', 'office_create', 'unknown_future_tool'):
                with self.assertRaises(PermissionError):
                    await self.call(socket, server='buddy-app', tool=tool)
            self.app.dispatch.assert_awaited_once()

    async def test_remote_delegation_requires_turn_selection_and_exact_approval(self):
        authorize = AsyncMock()
        payload = {'action': 'a2a_ask', 'slug': 'other', 'prompt': 'synthetic context', 'context_id': None}
        async with self.broker(authorize=authorize, allowed_agents=['selected-agent']) as socket:
            with self.assertRaises(PermissionError):
                await mcp_broker.request(socket, payload)
            authorize.assert_not_awaited()
            self.attachments.dispatch.assert_not_awaited()
            payload['slug'] = 'selected-agent'
            await mcp_broker.request(socket, payload)
            authorize.assert_awaited_once()
            self.assertEqual(self.attachments.dispatch.await_args.kwargs['allowed_slugs'], frozenset({'selected-agent'}))
            self.assertIsNotNone(self.attachments.dispatch.await_args.kwargs['expected_agent'])

    async def test_discovery_also_consumes_quota_and_quota_failure_denies(self):
        async with self.broker() as socket:
            await mcp_broker.request(socket, {'action': 'servers'})
            self.budget.consume.assert_awaited_once_with('tool')
            self.budget.consume.side_effect = PermissionError('synthetic exhausted quota')
            with self.assertRaises(PermissionError):
                await mcp_broker.request(socket, {'action': 'tools', 'server': 'selected'})
            self.execute.assert_not_awaited()

    async def test_external_prompt_arguments_and_resource_uris_require_approval(self):
        async with self.broker() as socket:
            for payload in ({'action': 'get_prompt', 'server': 'selected', 'tool': 'prompt',
                             'arguments': {'context': 'synthetic-sensitive-context'}},
                            {'action': 'read_resource', 'server': 'selected',
                             'arguments': {'uri': 'synthetic://resource?context=synthetic-context'}}):
                with self.assertRaises(PermissionError):
                    await mcp_broker.request(socket, payload)
            self.execute.assert_not_awaited()

    async def test_cancellation_after_approval_blocks_execution(self):
        self.assert_active.side_effect = PermissionError('Synthetic cancellation')
        async with self.broker(authorize=AsyncMock()) as socket:
            with self.assertRaises(PermissionError):
                await self.call(socket)
            self.execute.assert_not_awaited()

    async def test_mismatched_budget_owner_is_rejected(self):
        self.budget.username = 'other'
        with self.assertRaises(PermissionError):
            async with self.broker():
                self.fail('wrong-owner broker started')


class BindingTests(unittest.TestCase):
    def test_binding_normalizes_key_order_and_rejects_changed_actor_target_and_parameters(self):
        payload = {'action': 'call', 'server': 'selected', 'tool': 'send', 'arguments': {'a': 1, 'b': 2}}
        digest = action_digest('owner', payload, {'command': 'target'})
        self.assertEqual(digest, action_digest('owner', {**payload, 'arguments': {'b': 2, 'a': 1}}, {'command': 'target'}))
        self.assertNotEqual(digest, action_digest('other', payload, {'command': 'target'}))
        self.assertNotEqual(digest, action_digest('owner', payload, {'command': 'different'}))
        self.assertNotEqual(digest, action_digest('owner', {**payload, 'arguments': {'a': 3}}, {'command': 'target'}))
        with self.assertRaises(ValueError):
            action_digest('owner', {'arguments': {'bad': float('nan')}})

    def test_names_and_annotations_do_not_make_external_tools_trusted(self):
        self.assertTrue(requires_approval({'action': 'call', 'server': 'external', 'tool': 'read_only_safe'}))
        self.assertTrue(requires_approval({'action': 'call', 'server': 'buddy-app', 'tool': 'unknown'}))
        self.assertFalse(requires_approval({'action': 'call', 'server': 'buddy-app', 'tool': 'notes_get'}))


if __name__ == '__main__':
    unittest.main()
