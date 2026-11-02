"""Explicit selections stay identity-bound from chat to the A2A helper."""
import argparse
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app import agent_attachments as attachments, a2a_cli, mcp_broker, workspace_config


class SelectionTests(unittest.TestCase):
    def test_request_supports_multiple_agents_and_skill_without_switching_agent(self):
        from app.main import StreamRequest
        request = StreamRequest(prompt='Compare findings', agent_slugs=['catalog-one', 'personal'], skill_name='analysis')
        self.assertIsNone(request.agent_name)
        self.assertEqual(request.agent_slugs, ['catalog-one', 'personal'])
        for slugs in [['duplicate', 'duplicate'], ['bad/slug'], ['a'] * 13, ['UPPER']]:
            with self.assertRaises(ValueError):
                StreamRequest(prompt='Compare findings', agent_slugs=slugs)

    def test_selection_refuses_removed_access_and_never_embeds_credentials(self):
        secret_agent = {'name': 'Fixture', 'endpoint': 'https://fixture.invalid/a2a', 'api_key': 'fixture-secret', 'auth_token': 'other-secret'}
        with patch.object(attachments, 'authorized_agent', return_value=secret_agent) as lookup:
            selected = attachments.selected_agents('alice', ['catalog-one'])
            lookup.assert_called_once_with('alice', 'catalog-one')
        prompt = attachments.add_agent_routing('Use the skill.', selected)
        self.assertIn('a2a ask SLUG', prompt)
        self.assertIn('catalog-one', prompt)
        self.assertNotIn('fixture-secret', prompt)
        self.assertNotIn('fixture.invalid', prompt)
        self.assertIn('Use the skill.', prompt)
        with patch.object(attachments, 'authorized_agent', return_value=None):
            with self.assertRaises(PermissionError):
                attachments.selected_agents('alice', ['catalog-one'])

    def test_resolution_binds_user_and_restores_outer_workspace(self):
        original = Path('/tmp/outer-workspace')
        token = workspace_config._selected_root.set(original)
        def resolve(slug):
            self.assertEqual(workspace_config._root(), Path('/tmp/users/alice'))
            return {'name': 'Fixture'}
        try:
            with patch('app.sessions.user_root', return_value=Path('/tmp/users/alice')), patch.object(workspace_config, 'get_agent', side_effect=resolve):
                self.assertEqual(attachments.authorized_agent('alice', 'catalog-one'), {'name': 'Fixture'})
            self.assertEqual(workspace_config._root(), original)
        finally:
            workspace_config._selected_root.reset(token)

    def test_isolated_cli_refuses_fallback_and_credential_overrides(self):
        args = argparse.Namespace(slug='catalog-one', prompt='Fixture', context_id=None, api_key='secret', endpoint=None)
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/fixture/socket'}, clear=True), patch.object(a2a_cli, '_find_agents', side_effect=AssertionError('No file credentials')), redirect_stderr(io.StringIO()):
            self.assertEqual(a2a_cli.cmd_ask(args), 1)
        args.api_key = None
        with patch.dict('os.environ', {'BOB_KNOWLEDGE_SOCKET': '/fixture/socket'}, clear=True), patch.object(a2a_cli, '_find_agents', side_effect=AssertionError('No registry fallback')), redirect_stderr(io.StringIO()):
            self.assertEqual(a2a_cli.cmd_ask(args), 2)

    def test_cli_dispatches_selected_slug_through_authenticated_socket(self):
        args = argparse.Namespace(slug='catalog-one', prompt='Fixture task', context_id=None, api_key=None, endpoint=None)
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/fixture/socket'}, clear=True), patch.object(mcp_broker, 'request', new=AsyncMock(return_value={'text': 'Fixture response'})) as request, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(a2a_cli.cmd_ask(args), 0)
        request.assert_awaited_once_with('/fixture/socket', {'action': 'a2a_ask', 'slug': 'catalog-one', 'prompt': 'Fixture task', 'context_id': None})
        self.assertEqual(output.getvalue().strip(), 'Fixture response')


class DelegationTests(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_uses_live_credentials_and_masks_remote_echo(self):
        agent = {'name': 'Fixture', 'api_key': 'fixture-secret', 'auth_token': 'fixture-token', 'endpoint': 'https://fixture.invalid/a2a'}
        payload = {'action': 'a2a_ask', 'slug': 'catalog-one', 'prompt': 'Fixture', 'context_id': None}
        with patch.object(attachments, 'authorized_agent', return_value=agent) as lookup, patch('app.a2a_client.send_message', new=AsyncMock(return_value={'text': 'echo fixture-secret fixture-token'})) as send:
            result = await attachments.dispatch('alice', payload, allowed_slugs={'catalog-one'}, assert_active=AsyncMock())
        send.assert_awaited_once_with(agent, 'Fixture', context_id=None)
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual(result['text'], 'echo [redacted] [redacted]')

    async def test_revocation_before_call_prevents_send_and_during_call_suppresses_result(self):
        payload = {'action': 'a2a_ask', 'slug': 'catalog-one', 'prompt': 'Fixture', 'context_id': None}
        for sequence, sends in [([None], 0), ([{'name': 'Fixture'}, None], 1)]:
            with patch.object(attachments, 'authorized_agent', side_effect=sequence), patch('app.a2a_client.send_message', new=AsyncMock(return_value={'text': 'Fixture'})) as send:
                with self.assertRaises(PermissionError):
                    await attachments.dispatch('alice', payload, allowed_slugs={'catalog-one'}, assert_active=AsyncMock())
                self.assertEqual(send.await_count, sends)

    async def test_socket_identity_cannot_be_replaced_and_errors_hide_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(mcp_broker, 'bootstrap_registry'), patch('app.mcp_access.allowed_servers', return_value={}), patch.object(attachments, 'authorized_agent', side_effect=RuntimeError('fixture-secret')):
            async with mcp_broker.mcp_broker(username='alice', workspace=directory + '/workspace', user_home=directory + '/home') as socket:
                with self.assertRaises(PermissionError) as error:
                    await mcp_broker.request(socket, {'action': 'a2a_ask', 'slug': 'catalog-one', 'prompt': 'Fixture', 'context_id': None})
                self.assertNotIn('fixture-secret', str(error.exception))
                with self.assertRaises(PermissionError):
                    await mcp_broker.request(socket, {'action': 'a2a_ask', 'slug': 'catalog-one', 'prompt': 'Fixture', 'context_id': None, 'username': 'bob'})


if __name__ == '__main__':
    unittest.main()
