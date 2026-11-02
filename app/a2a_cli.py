"""Command-line utility for interacting with registered A2A agents.
Used by Buddy skills and shell tools to query external agents over JSON-RPC.
"""

from __future__ import annotations

from app.branding import brand_text
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Ensure app package is importable
app_root = Path(__file__).resolve().parent.parent
if str(app_root) not in sys.path:
    sys.path.insert(0, str(app_root))

from app.a2a_client import send_message


def _find_agents() -> dict[str, dict]:
    """Load agents from current directory .bob, user root, or global /workspace/.bob."""
    ws = Path(os.getenv("BOB_WORKSPACE", "/workspace"))
    candidates = [
        Path.cwd() / ".bob" / "a2a_agents.json",
        ws / ".bob" / "a2a_agents.json",
    ]
    # Check parent dirs
    curr = Path.cwd()
    while curr != curr.parent:
        candidate = curr / ".bob" / "a2a_agents.json"
        if candidate not in candidates:
            candidates.append(candidate)
        curr = curr.parent

    all_agents: dict[str, dict] = {}
    for path in reversed(candidates):
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                agents = data.get("agents", {})
                if isinstance(agents, dict):
                    all_agents.update(agents)
            except Exception:
                pass
    return all_agents


def cmd_list(args: argparse.Namespace) -> int:
    if os.environ.get('BOB_MCP_SOCKET'):
        from app.mcp_broker import request
        try:
            print(json.dumps(asyncio.run(request(os.environ['BOB_MCP_SOCKET'], {'action': 'a2a_list'})), ensure_ascii=False))
            return 0
        except Exception:
            print('A2A agent list unavailable.', file=sys.stderr)
            return 2
    if os.environ.get('BOB_KNOWLEDGE_SOCKET'):
        print('Authenticated A2A gateway required.', file=sys.stderr)
        return 2
    agents = _find_agents()
    if not agents:
        print("No A2A agents registered.")
        print(brand_text("Register agents in the Buddy UI sidebar under 'A2A AGENTS' (+ button)."))
        return 0

    print(f"Registered A2A Agents ({len(agents)}):")
    print("-" * 60)
    for slug, info in sorted(agents.items()):
        name = info.get("name", slug)
        desc = info.get("description", "No description provided.")
        endpoint = info.get("endpoint", "")
        version = info.get("protocol_version", "unknown")
        print(f"• Slug: {slug}")
        print(f"  Name: {name}")
        print(f"  Endpoint: {endpoint} (A2A v{version})")
        print(f"  Description: {desc}")
        print("-" * 60)
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    if os.environ.get('BOB_MCP_SOCKET'):
        from app.mcp_broker import request
        if getattr(args, 'api_key', None) or getattr(args, 'endpoint', None):
            print(brand_text('Authentication and endpoint overrides are unavailable in Buddy.'), file=sys.stderr)
            return 1
        prompt = args.prompt or (sys.stdin.read().strip() if not sys.stdin.isatty() else '')
        try:
            result = asyncio.run(request(os.environ['BOB_MCP_SOCKET'], {
                'action': 'a2a_ask', 'slug': args.slug, 'prompt': prompt, 'context_id': args.context_id,
            }))
            print(result.get('text', ''))
            return 0
        except Exception:
            print('A2A delegation failed. Check agent access, connection and credentials.', file=sys.stderr)
            return 2
    if os.environ.get('BOB_KNOWLEDGE_SOCKET'):
        print('Authenticated A2A gateway required.', file=sys.stderr)
        return 2
    agents = _find_agents()
    agent = agents.get(args.slug)
    if not agent:
        print(f"Error: Agent '{args.slug}' not found.", file=sys.stderr)
        return 1
    if getattr(args, "api_key", None):
        agent["api_key"] = args.api_key
    if getattr(args, "endpoint", None):
        agent["endpoint"] = args.endpoint

    prompt = args.prompt
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()

    if not prompt:
        print("Error: Prompt cannot be empty.", file=sys.stderr)
        return 1

    try:
        result = asyncio.run(send_message(agent, prompt, context_id=args.context_id))
        print(result.get("text", ""))
        return 0
    except Exception as exc:
        print(f"Error communicating with agent '{args.slug}': {exc}", file=sys.stderr)
        return 2


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="a2a",
        description="Interact with registered A2A (Agent-to-Agent) services.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # list
    subparsers.add_parser("list", help="List all registered A2A agents")

    # ask
    ask_parser = subparsers.add_parser("ask", help="Send a prompt to a registered A2A agent")
    ask_parser.add_argument("slug", help="The slug identifier of the registered agent")
    ask_parser.add_argument("prompt", nargs="?", default="", help="The prompt or question to send")
    ask_parser.add_argument("--context-id", default=None, help="Optional A2A context/thread ID")
    ask_parser.add_argument("--api-key", default=None, help="Optional API key override")
    ask_parser.add_argument("--endpoint", default=None, help="Optional endpoint URL override")

    args = parser.parse_args()
    if args.command == "list":
        return cmd_list(args)
    elif args.command == "ask":
        return cmd_ask(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
