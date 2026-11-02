"""On-demand MCP checks. Results describe a single check, never live health."""
from app.branding import brand_text
import asyncio
import tempfile
from contextlib import ExitStack
from pathlib import Path
from datetime import datetime, timezone


def failure_message(exc: Exception) -> str:
    if isinstance(exc, BaseExceptionGroup):
        return failure_message(exc.exceptions[0])
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "Server did not respond within 20 seconds. Check that it is running and reachable."
    if isinstance(exc, FileNotFoundError):
        return brand_text("Command not found on the Buddy server. Install it or check the command path.")
    # Never return raw exception text: it can include URLs, tokens, or headers.
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status in (401, 403):
        return "Authentication failed. Check your API key and required permissions."
    if status == 404:
        return "MCP endpoint not found. Check the URL and selected connection type."
    return "Could not complete the MCP handshake. Check the server, connection type, and credentials."


async def probe_mcp(config: dict, *, cwd: str, server_name: str | None = None) -> dict:
    if config.get("disabled"):
        return {"status": "error", "message": "This MCP connection is disabled in its configuration.",
                "checked_at": datetime.now(timezone.utc).isoformat()}
    async def check():
        from app.mcp_broker import open_session
        with ExitStack() as stack:
            # Use the same transport, environment and trusted module path as
            # actual tool calls, including for database-only workspaces.
            working_dir = cwd if Path(cwd).is_dir() else stack.enter_context(tempfile.TemporaryDirectory(prefix='bob-mcp-check-'))
            home = Path(working_dir) / '.home'
            home.mkdir(exist_ok=True)
            async with open_session(config, workspace=working_dir, user_home=str(home), server_name=server_name) as session:
                names = []
                if 'tools' in session._buddy_capabilities:
                    cursor = None
                    while True:
                        page = await session.list_tools(cursor=cursor)
                        names.extend(tool.name for tool in page.tools)
                        cursor = page.nextCursor
                        if not cursor:
                            break
                return {"status": "working", "message": "MCP handshake completed.", "tools": names,
                        "server_name": session._buddy_server_name}

    try:
        async with asyncio.timeout(20):
            result = await check()
    except ImportError:
        result = {"status": "error", "message": brand_text("Connection checks require the MCP dependency. Rebuild the Buddy server.")}
    except Exception as exc:
        result = {"status": "error", "message": failure_message(exc)}
    return {**result, "checked_at": datetime.now(timezone.utc).isoformat()}
