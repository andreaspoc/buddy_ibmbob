"""ACP failures retain useful metadata without leaking prompts or credentials."""
import ast
import asyncio
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch


namespace = {'asyncio': asyncio, 'json': json, 'os': os, 're': re, 'brand_text': lambda text: text, 'brand_name': lambda: 'Buddy'}
source = ast.parse(Path('app/acp_bridge.py').read_text())
for node in source.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {
            '_approval_error_detail', '_approval_stderr_detail', '_capture_approval_stderr'}:
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'app/acp_bridge.py', 'exec'), namespace)


class DiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def test_generic_error_preserves_metadata_but_excludes_payloads(self):
        error = RuntimeError('Internal error')
        error.data = {'details': 'Invalid provider response', 'code': 400,
                      'prompt': 'private request', 'request': {'token': 'private token'}}
        result = namespace['_approval_error_detail'](error)
        self.assertIn('Invalid provider response', result)
        self.assertIn('400', result)
        self.assertNotIn('private', result)

    def test_credentials_and_multiline_prompt_are_redacted(self):
        error = RuntimeError('Internal error')
        error.data = {'details': 'provider-key monday-key private\nrequest'}
        with patch.dict(os.environ, {'BOB_API_KEY': 'provider-key'}):
            result = namespace['_approval_error_detail'](error, ['monday-key', 'private\nrequest'])
        for secret in ('provider-key', 'monday-key', 'private', 'request'):
            self.assertNotIn(secret, result)

    def test_existing_team_guidance_and_size_limit(self):
        error = RuntimeError('Internal error')
        error.data = {'details': 'TeamUserNotFoundError'}
        self.assertIn('Check key membership', namespace['_approval_error_detail'](error))
        error.data = {'details': 'x' * 5000}
        self.assertLessEqual(len(namespace['_approval_error_detail'](error)), 2000)

    def test_provider_schema_failure_has_actionable_concise_message(self):
        error = RuntimeError('Internal error')
        error.data = {'details': 'ProviderError: tools.59.custom.input_schema is invalid JSON schema draft2020-12 ' + 'fallback ' * 1000}
        result = namespace['_approval_error_detail'](error)
        self.assertIn('An MCP tool has an invalid input schema', result)
        self.assertIn('no action was started', result)
        self.assertNotIn('fallback', result)

    def test_stderr_omits_payload_lines_and_redacts_other_diagnostics(self):
        stderr = b'prompt: private request\nError: invalid key monday-key\n'
        result = namespace['_approval_stderr_detail'](stderr, ['monday-key'])
        self.assertIn('Error: invalid key', result)
        self.assertNotIn('private request', result)
        self.assertNotIn('monday-key', result)
        self.assertLessEqual(len(namespace['_approval_stderr_detail'](b'x' * 5000)), 2000)

    async def test_stderr_drain_retains_bounded_tail(self):
        stream = asyncio.StreamReader()
        stream.feed_data(b'x' * 20000 + b'final error')
        stream.feed_eof()
        result = await namespace['_capture_approval_stderr'](stream)
        self.assertEqual(len(result), 8192)
        self.assertTrue(result.endswith(b'final error'))


if __name__ == '__main__':
    unittest.main()
