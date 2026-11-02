"""Hermetic unit tests for zero-coverage utility and shim modules."""
import asyncio
import base64
import contextlib
import importlib
import io
import json
import os
import runpy
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, mock_open, patch

_PEOPLE_DIR = str(Path(__file__).resolve().parents[1] / 'plugins' / 'people')
if _PEOPLE_DIR not in sys.path:
    sys.path.insert(0, _PEOPLE_DIR)

from mcp.server import Server
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import (
    CallToolRequest,
    CallToolRequestParams,
    GetPromptRequest,
    GetPromptRequestParams,
    ListPromptsRequest,
    ListResourceTemplatesRequest,
    ListResourcesRequest,
    ListToolsRequest,
    ReadResourceRequest,
    ReadResourceRequestParams,
)
from pydantic import AnyUrl


class TestZeroCovUtils(unittest.TestCase):
    """Hermetic unit tests for synchronous utility modules."""

    # -------------------------------------------------------------------------
    # 1. app/mcp_smtp.py
    # -------------------------------------------------------------------------
    def test_mcp_smtp_send_email_success(self):
        import app.mcp_smtp as mcp_smtp

        with patch("app.mcp_smtp.load_config", return_value={"enabled": True}) as mock_cfg, patch(
            "app.mcp_smtp.send_message", return_value="Accepted"
        ) as mock_send:
            res = mcp_smtp.smtp_send_email("to@example.com", "Subject", "Body", False)
            self.assertEqual(res, "Accepted")
            mock_send.assert_called_once_with({"enabled": True}, "to@example.com", "Subject", "Body", False, personal_data_confirmed=False)

    def test_mcp_smtp_send_email_html(self):
        import app.mcp_smtp as mcp_smtp

        with patch("app.mcp_smtp.load_config", return_value={"enabled": True}), patch(
            "app.mcp_smtp.send_message", return_value="Accepted"
        ) as mock_send:
            res = mcp_smtp.smtp_send_email("to@example.com", "Subject", "<p>Html</p>", True)
            self.assertEqual(res, "Accepted")
            mock_send.assert_called_once_with({"enabled": True}, "to@example.com", "Subject", "<p>Html</p>", True, personal_data_confirmed=False)

    def test_mcp_smtp_send_email_value_error(self):
        import app.mcp_smtp as mcp_smtp

        with patch("app.mcp_smtp.load_config", return_value={"enabled": True}), patch(
            "app.mcp_smtp.send_message", side_effect=ValueError("Invalid email")
        ):
            with self.assertRaises(ToolError) as ctx:
                mcp_smtp.smtp_send_email("invalid", "Subject", "Body")
            self.assertIn("Invalid email", str(ctx.exception))

    def test_mcp_smtp_send_email_generic_exception(self):
        import app.mcp_smtp as mcp_smtp

        with patch("app.mcp_smtp.load_config", return_value={"enabled": True}), patch(
            "app.mcp_smtp.send_message", side_effect=RuntimeError("Network err")
        ):
            with self.assertRaises(ToolError) as ctx:
                mcp_smtp.smtp_send_email("to@example.com", "Subject", "Body")
            self.assertIn("SMTP could not complete the request", str(ctx.exception))

    def test_mcp_smtp_main(self):
        sys.modules.pop("app.mcp_smtp", None)
        with patch.object(FastMCP, "run") as mock_run:
            runpy.run_module("app.mcp_smtp", run_name="__main__")
            mock_run.assert_called_once_with(transport="stdio")

    # -------------------------------------------------------------------------
    # 2. app/ops_check.py
    # -------------------------------------------------------------------------
    def test_ops_check_healthy(self):
        import app.ops_check as ops_check

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [(0,), (0,)]
        mock_conn.__enter__.return_value = mock_conn

        captured = io.StringIO()
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db"}), patch(
            "psycopg.connect", return_value=mock_conn
        ), patch("sys.stdout", captured):
            code = ops_check.main()
            self.assertEqual(code, 0)
            data = json.loads(captured.getvalue())
            self.assertEqual(data["expired_job_leases"], 0)
            self.assertEqual(data["overdue_queued_jobs"], 0)
            self.assertEqual(data["queue_age_threshold_seconds"], 300)

    def test_ops_check_attention(self):
        import app.ops_check as ops_check

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [(2,), (1,)]
        mock_conn.__enter__.return_value = mock_conn

        captured = io.StringIO()
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db"}), patch(
            "psycopg.connect", return_value=mock_conn
        ), patch("sys.stdout", captured):
            code = ops_check.main()
            self.assertEqual(code, 1)
            data = json.loads(captured.getvalue())
            self.assertEqual(data["expired_job_leases"], 2)
            self.assertEqual(data["overdue_queued_jobs"], 1)

    def test_ops_check_custom_threshold(self):
        import app.ops_check as ops_check

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [(0,), (0,)]
        mock_conn.__enter__.return_value = mock_conn

        captured = io.StringIO()
        with patch.dict(
            os.environ,
            {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db", "BOB_OPS_QUEUE_AGE_SECONDS": "60"},
        ), patch("psycopg.connect", return_value=mock_conn), patch("sys.stdout", captured):
            code = ops_check.main()
            self.assertEqual(code, 0)
            data = json.loads(captured.getvalue())
            self.assertEqual(data["queue_age_threshold_seconds"], 60)

    def test_ops_check_invalid_threshold(self):
        import app.ops_check as ops_check

        captured = io.StringIO()
        with patch.dict(
            os.environ,
            {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db", "BOB_OPS_QUEUE_AGE_SECONDS": "0"},
        ), patch("sys.stdout", captured):
            code = ops_check.main()
            self.assertEqual(code, 2)
            data = json.loads(captured.getvalue())
            self.assertIn("error", data)

    def test_ops_check_db_failure(self):
        import app.ops_check as ops_check

        captured = io.StringIO()
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db"}), patch(
            "psycopg.connect", side_effect=Exception("DB connection failed")
        ), patch("sys.stdout", captured):
            code = ops_check.main()
            self.assertEqual(code, 2)
            data = json.loads(captured.getvalue())
            self.assertIn("error", data)

    def test_ops_check_main_entry(self):
        sys.modules.pop("app.ops_check", None)
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.side_effect = [(0,), (0,)]
        mock_conn.__enter__.return_value = mock_conn

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://test_user:pass@localhost/test_db"}), patch(
            "psycopg.connect", return_value=mock_conn
        ), patch("sys.stdout", io.StringIO()), patch("sys.exit") as mock_exit:
            runpy.run_module("app.ops_check", run_name="__main__")
            mock_exit.assert_called_once_with(0)

    # -------------------------------------------------------------------------
    # 3. app/archive_conversations.py
    # -------------------------------------------------------------------------
    def test_archive_conversations(self):
        import app.archive_conversations as ac
        import app.migrate_storage as ms

        self.assertIs(ac.main, ms.main)
        sys.modules.pop("app.archive_conversations", None)
        with patch("app.migrate_storage.main") as mock_main:
            runpy.run_module("app.archive_conversations", run_name="__main__")
            mock_main.assert_called_once()

    # -------------------------------------------------------------------------
    # 4. app/decisions_buddy/sample_decisions.py
    # -------------------------------------------------------------------------
    def test_sample_decisions_structure(self):
        import app.decisions_buddy.sample_decisions as sd

        self.assertIn("ecommerce-pricing", sd.SAMPLE_DECISIONS)
        self.assertIn("fraud-risk-scoring", sd.SAMPLE_DECISIONS)
        pricing = sd.SAMPLE_DECISIONS["ecommerce-pricing"]
        self.assertEqual(pricing["id"], "ecommerce-pricing")
        self.assertIn("graph", pricing)
        self.assertIn("nodes", pricing["graph"])
        fraud = sd.SAMPLE_DECISIONS["fraud-risk-scoring"]
        self.assertEqual(fraud["id"], "fraud-risk-scoring")

    @patch.dict(os.environ, {"DECISION_TEST_DATA_DIR": "/data/decision/test-data"})
    def test_sample_decisions_external_loading(self):
        import app.decisions_buddy.sample_decisions as sd

        orig_exists = Path.exists

        def fake_exists_all(self_path):
            if "/data/decision/test-data" in str(self_path):
                return True
            return orig_exists(self_path)

        def fake_exists_dir_only(self_path):
            if str(self_path).endswith("test-data"):
                return True
            if "/data/decision/test-data" in str(self_path):
                return False
            return orig_exists(self_path)

        mock_json_content = json.dumps({"nodes": ["test_node"], "edges": []})
        with patch.object(Path, "exists", fake_exists_all), patch("builtins.open", mock_open(read_data=mock_json_content)):
            importlib.reload(sd)
            self.assertIn("credit-analysis", sd.SAMPLE_DECISIONS)
            self.assertIn("switch-node", sd.SAMPLE_DECISIONS)
            self.assertIn("table-basic", sd.SAMPLE_DECISIONS)

        with patch.object(Path, "exists", fake_exists_all), patch(
            "builtins.open", side_effect=IOError("Mock file read error")
        ):
            importlib.reload(sd)

        with patch.object(Path, "exists", fake_exists_dir_only):
            importlib.reload(sd)

        # Restore original clean module state
        importlib.reload(sd)

    # -------------------------------------------------------------------------
    # 5. Compatibility Shims
    # -------------------------------------------------------------------------
    def test_shims(self):
        import app.decisions_buddy.zen_engine as ze

        self.assertTrue(hasattr(ze, "ZenEngine"))
        self.assertTrue(hasattr(ze, "ZenDecision"))
        self.assertTrue(hasattr(ze, "ZenDecisionContent"))

        import app.community_collaboration as cc

        self.assertIsNotNone(cc)

        import app.community_typing as ct

        self.assertIsNotNone(ct)

        import app.office_chat as oc

        self.assertIsNotNone(oc)


class TestAsyncZeroCovUtils(unittest.IsolatedAsyncioTestCase):
    """Hermetic unit tests for asynchronous utility modules."""

    # -------------------------------------------------------------------------
    # 6. app/mcp_proxy.py
    # -------------------------------------------------------------------------
    async def test_mcp_proxy_no_socket(self):
        import app.mcp_proxy as mp

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(PermissionError):
                await mp.serve("srv")

    async def test_mcp_proxy_empty_capabilities(self):
        import app.mcp_proxy as mp

        @contextlib.asynccontextmanager
        async def fake_stdio():
            yield (AsyncMock(), AsyncMock())

        async def fake_run(self_srv, reader, writer, options):
            pass

        with patch.dict(os.environ, {"BOB_MCP_SOCKET": "/tmp/test.sock"}), patch(
            "app.mcp_proxy.request", new_callable=AsyncMock, return_value={}
        ), patch("mcp.server.stdio.stdio_server", side_effect=fake_stdio), patch.object(Server, "run", fake_run):
            await mp.serve("my_srv")

    async def test_mcp_proxy_full_cycle(self):
        import app.mcp_proxy as mp

        async def fake_request(socket, payload):
            action = payload.get("action")
            if action == "capabilities":
                return {"tools": {}, "resources": {}, "prompts": {}}
            elif action == "tools":
                return [{"name": "tool1", "description": "desc", "inputSchema": {"type": "object"}}]
            elif action == "call":
                return {"content": [{"type": "text", "text": "call_result"}]}
            elif action == "resources":
                return [{"name": "res1", "uri": "file:///tmp/res1"}]
            elif action == "templates":
                return [{"name": "tpl1", "uriTemplate": "file:///{path}"}]
            elif action == "read_resource":
                return {
                    "contents": [
                        {"text": "txt_content", "mimeType": "text/plain"},
                        {"blob": base64.b64encode(b"bin_content").decode("ascii"), "mimeType": "application/octet-stream"},
                    ]
                }
            elif action == "prompts":
                return [{"name": "prompt1"}]
            elif action == "get_prompt":
                return {"messages": [{"role": "user", "content": {"type": "text", "text": "prompt_text"}}]}
            return {}

        @contextlib.asynccontextmanager
        async def fake_stdio():
            yield (AsyncMock(), AsyncMock())

        async def fake_run(self_srv, reader, writer, options):
            if ListToolsRequest in self_srv.request_handlers:
                await self_srv.request_handlers[ListToolsRequest](ListToolsRequest())
            if CallToolRequest in self_srv.request_handlers:
                await self_srv.request_handlers[CallToolRequest](
                    CallToolRequest(params=CallToolRequestParams(name="tool1", arguments=None))
                )
                await self_srv.request_handlers[CallToolRequest](
                    CallToolRequest(params=CallToolRequestParams(name="tool1", arguments={"x": 1}))
                )
            if ListResourcesRequest in self_srv.request_handlers:
                await self_srv.request_handlers[ListResourcesRequest](ListResourcesRequest())
            if ListResourceTemplatesRequest in self_srv.request_handlers:
                await self_srv.request_handlers[ListResourceTemplatesRequest](ListResourceTemplatesRequest())
            if ReadResourceRequest in self_srv.request_handlers:
                await self_srv.request_handlers[ReadResourceRequest](
                    ReadResourceRequest(params=ReadResourceRequestParams(uri=AnyUrl("file:///tmp/res1")))
                )
            if ListPromptsRequest in self_srv.request_handlers:
                await self_srv.request_handlers[ListPromptsRequest](ListPromptsRequest())
            if GetPromptRequest in self_srv.request_handlers:
                await self_srv.request_handlers[GetPromptRequest](
                    GetPromptRequest(params=GetPromptRequestParams(name="prompt1", arguments=None))
                )
                await self_srv.request_handlers[GetPromptRequest](
                    GetPromptRequest(params=GetPromptRequestParams(name="prompt1", arguments={"y": "test_val"}))
                )

        with patch.dict(os.environ, {"BOB_MCP_SOCKET": "/tmp/test.sock"}), patch(
            "app.mcp_proxy.request", side_effect=fake_request
        ), patch("mcp.server.stdio.stdio_server", side_effect=fake_stdio), patch.object(Server, "run", fake_run):
            await mp.serve("my_srv")

    async def test_mcp_proxy_main(self):
        sys.modules.pop("app.mcp_proxy", None)
        with patch("sys.argv", ["app.mcp_proxy", "srv"]), patch(
            "asyncio.run", side_effect=lambda coro: coro.close()
        ) as mock_async_run:
            runpy.run_module("app.mcp_proxy", run_name="__main__")
            mock_async_run.assert_called_once()

    # -------------------------------------------------------------------------
    # 7. Workers
    # -------------------------------------------------------------------------
    async def test_app_people_worker(self):
        import app.people_worker as pw

        with patch("app.community_away.worker_loop", new_callable=AsyncMock) as mock_loop:
            await pw.main()
            mock_loop.assert_awaited_once()

    async def test_app_people_worker_main_entry(self):
        sys.modules.pop("app.people_worker", None)
        with patch("asyncio.run", side_effect=lambda coro: coro.close()) as mock_async_run, patch(
            "logging.basicConfig"
        ):
            runpy.run_module("app.people_worker", run_name="__main__")
            mock_async_run.assert_called_once()

    async def test_buddy_people_worker(self):
        import buddy_people.worker as bpw

        with patch("buddy_people.community_away.worker_loop", new_callable=AsyncMock) as mock_loop:
            await bpw.main()
            mock_loop.assert_awaited_once()

    async def test_buddy_people_worker_main_entry(self):
        sys.modules.pop("buddy_people.worker", None)
        with patch("asyncio.run", side_effect=lambda coro: coro.close()) as mock_async_run, patch(
            "logging.basicConfig"
        ):
            runpy.run_module("buddy_people.worker", run_name="__main__")
            mock_async_run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
