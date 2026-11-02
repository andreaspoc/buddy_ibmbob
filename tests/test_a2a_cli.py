"""A2A CLI routing and authorization without remote agents."""
import argparse
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from app import a2a_cli


class A2ACliTests(unittest.TestCase):
    def args(self, **values):
        return argparse.Namespace(**({'slug': 'sample', 'prompt': 'hello', 'context_id': None, 'api_key': None, 'endpoint': None} | values))

    def test_agent_files_merge_closest_first_and_ignore_invalid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'child'
            (root / '.bob').mkdir()
            (child / '.bob').mkdir(parents=True)
            (root / '.bob/a2a_agents.json').write_text(json.dumps({'agents': {'shared': {'name': 'parent'}, 'parent': {}}}))
            (child / '.bob/a2a_agents.json').write_text(json.dumps({'agents': {'shared': {'name': 'child'}}}))
            with patch.object(a2a_cli.Path, 'cwd', return_value=child), patch.dict('os.environ', {'BOB_WORKSPACE': str(root)}):
                agents = a2a_cli._find_agents()
            self.assertEqual(agents['shared']['name'], 'child')
            self.assertIn('parent', agents)
            (child / '.bob/a2a_agents.json').write_text('{bad')
            with patch.object(a2a_cli.Path, 'cwd', return_value=child), patch.dict('os.environ', {'BOB_WORKSPACE': str(root)}):
                self.assertEqual(a2a_cli._find_agents()['shared']['name'], 'parent')

    def test_gateway_rejects_overrides_and_redacts_errors(self):
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/tmp/fixture'}, clear=True), \
             patch('app.mcp_broker.request', new_callable=AsyncMock, side_effect=RuntimeError('private detail')) as request, \
             patch.object(a2a_cli.sys, 'stderr', new_callable=io.StringIO) as err:
            self.assertEqual(a2a_cli.cmd_ask(self.args(api_key='override')), 1)
            request.assert_not_awaited()
            self.assertEqual(a2a_cli.cmd_ask(self.args()), 2)
            self.assertNotIn('private detail', err.getvalue())
            self.assertEqual(a2a_cli.cmd_list(self.args()), 2)

    def test_gateway_success_preserves_context_without_remote_call(self):
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/tmp/fixture'}, clear=True), \
             patch('app.mcp_broker.request', new_callable=AsyncMock, return_value={'text': 'response'}) as request, \
             patch.object(a2a_cli.sys, 'stdout', new_callable=io.StringIO) as out:
            self.assertEqual(a2a_cli.cmd_ask(self.args(context_id='ctx')), 0)
        self.assertEqual(out.getvalue(), 'response\n')
        self.assertEqual(request.await_args.args[1], {'action': 'a2a_ask', 'slug': 'sample', 'prompt': 'hello', 'context_id': 'ctx'})

    def test_direct_ask_and_missing_agent(self):
        with patch.dict('os.environ', {}, clear=True), patch.object(a2a_cli, '_find_agents', return_value={'sample': {'endpoint': 'https://example.test'}}), \
             patch.object(a2a_cli, 'send_message', new_callable=AsyncMock, return_value={'text': 'answer'}) as send, \
             patch.object(a2a_cli.sys, 'stdout', new_callable=io.StringIO):
            self.assertEqual(a2a_cli.cmd_ask(self.args()), 0)
            send.assert_awaited_once()
            with patch.object(a2a_cli.sys, 'stderr', new_callable=io.StringIO):
                self.assertEqual(a2a_cli.cmd_ask(self.args(slug='missing')), 1)

    def test_knowledge_only_gateway_denies_list_and_ask(self):
        with patch.dict('os.environ', {'BOB_KNOWLEDGE_SOCKET': '/tmp/fixture'}, clear=True), \
             patch.object(a2a_cli.sys, 'stderr', new_callable=io.StringIO):
            self.assertEqual(a2a_cli.cmd_list(self.args()), 2)
            self.assertEqual(a2a_cli.cmd_ask(self.args()), 2)


if __name__ == '__main__':
    unittest.main()
