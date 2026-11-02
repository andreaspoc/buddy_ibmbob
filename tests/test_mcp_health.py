import asyncio
import unittest
from unittest.mock import patch

from app.mcp_health import failure_message, probe_mcp


class MCPHealthTests(unittest.TestCase):
    def test_disabled_server_never_reports_working(self):
        result = asyncio.run(probe_mcp({'disabled': True, 'command': 'unused'}, cwd='/tmp'))
        self.assertEqual(result['status'], 'error')
        self.assertIn('disabled', result['message'])

    def test_timeout_has_actionable_guidance(self):
        self.assertIn("20 seconds", failure_message(TimeoutError()))

    def test_missing_command_has_actionable_guidance(self):
        self.assertIn("Command not found", failure_message(FileNotFoundError()))

    def test_nested_errors_do_not_expose_secrets(self):
        error = ExceptionGroup("secret", [ValueError("https://secret-token@example.com")])
        self.assertNotIn("secret", failure_message(error))

    def test_authentication_error(self):
        class AuthError(Exception):
            response = type("Response", (), {"status_code": 401})()
        self.assertIn("Authentication failed", failure_message(AuthError("private token")))

    def test_missing_dependency_never_reports_working(self):
        import builtins
        original = builtins.__import__
        def without_mcp(name, *args, **kwargs):
            if name == "mcp":
                raise ImportError()
            return original(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=without_mcp):
            result = asyncio.run(probe_mcp({"command": "unused"}, cwd="/tmp"))
        self.assertEqual(result["status"], "error")
        self.assertIn("checked_at", result)


if __name__ == "__main__":
    unittest.main()
