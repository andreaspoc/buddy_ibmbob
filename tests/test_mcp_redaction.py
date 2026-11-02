import unittest
from app.redaction import redact, config_secrets
from app.mcp_client import load_servers
from unittest.mock import patch
from pathlib import Path
import tempfile
import json


class RedactionTests(unittest.TestCase):
    def test_shell_titles_and_nested_payloads(self):
        token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature'
        value = {'name': f'curl -H "Authorization: Bearer {token}"',
                 'input': {'command': 'curl https://host/mcp?api_key=opaque-value',
                           'headers': {'Authorization': 'private'}},
                 'output': json.dumps({'password': 'hidden'})}
        public = json.dumps(redact(value))
        for secret in (token, 'opaque-value', 'private', 'hidden'):
            self.assertNotIn(secret, public)

    def test_custom_header_secret_and_url_credentials(self):
        secrets = config_secrets({'headers': {'X-Custom-Auth': 'opaque-credential'}})
        self.assertEqual(redact('opaque-credential', secrets), '[redacted]')
        self.assertEqual(redact('https://user:pass@host/mcp'), 'https://[redacted]@host/mcp')

    def test_cli_discovers_project_connections_without_showing_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / '.bob').mkdir()
            (root / '.bob/mcp.json').write_text(json.dumps({'mcpServers': {'docmost': {'httpURL': 'https://example/mcp'}}}))
            with patch('app.mcp_client.Path.cwd', return_value=root), patch('app.mcp_client.Path.home', return_value=root):
                self.assertIn('docmost', load_servers())


if __name__ == '__main__':
    unittest.main()
