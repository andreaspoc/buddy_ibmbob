"""Tests for Microsoft 365 MCP server and OAuth flow."""

import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from app.mcp_microsoft import TOOLS_REGISTRY, _get_token_file
from app.workspace_config import select_root, ensure_microsoft_mcp, remove_microsoft_mcp, list_mcps


def test_tools_registry():
    expected_tools = {
        "microsoft_get_me",
        "microsoft_list_emails",
        "microsoft_send_email",
        "microsoft_list_calendar_events",
        "microsoft_create_calendar_event",
        "microsoft_list_files",
        "microsoft_search_files",
    }
    assert expected_tools.issubset(set(TOOLS_REGISTRY.keys())), f"Missing tools: {expected_tools - set(TOOLS_REGISTRY.keys())}"


def test_tool_call_without_token():
    with tempfile.TemporaryDirectory() as tmp_dir:
        with patch.dict(os.environ, {"HOME": tmp_dir}):
            token_file = _get_token_file()
            assert not token_file.exists()
            tool_func = TOOLS_REGISTRY["microsoft_get_me"]["func"]
            try:
                tool_func({})
                assert False, "Should raise PermissionError when not connected"
            except PermissionError as e:
                assert "Microsoft account is not connected" in str(e)


def test_ensure_and_remove_microsoft_mcp():
    with tempfile.TemporaryDirectory() as tmp_dir:
        root_path = Path(tmp_dir)
        (root_path / ".home" / ".bob").mkdir(parents=True, exist_ok=True)
        select_root(root_path)

        ensure_microsoft_mcp()
        mcps = list_mcps()
        ms_mcp = next((m for m in mcps if m["name"] == "microsoft365"), None)
        assert ms_mcp is not None, "microsoft365 MCP was not registered"
        assert ms_mcp["transport"] == "stdio"

        remove_microsoft_mcp()
        mcps_after = list_mcps()
        assert not any(m["name"] == "microsoft365" for m in mcps_after), "microsoft365 MCP was not removed"


if __name__ == "__main__":
    test_tools_registry()
    test_tool_call_without_token()
    test_ensure_and_remove_microsoft_mcp()
    print("ALL MICROSOFT INTEGRATION TESTS PASSED!")
