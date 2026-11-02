"""Credential-free CLI for Buddy: servers, tools SERVER, call SERVER TOOL --arguments JSON."""
import argparse
import asyncio
from contextlib import AsyncExitStack
import json
import logging
import os
from pathlib import Path
from app.redaction import redact, config_secrets

MAX_DISCOVERY_PAGES = 32
MAX_DISCOVERY_TOOLS = 10000
MAX_DISCOVERY_BYTES = 16 * 1024 * 1024


async def list_tools(session):
    """Bound server-controlled pagination even when every response is fast."""
    tools, cursor, seen, size = [], None, set(), 2
    for _ in range(MAX_DISCOVERY_PAGES):
        page = await session.list_tools(cursor=cursor)
        if len(tools) + len(page.tools) > MAX_DISCOVERY_TOOLS:
            raise ValueError('MCP discovery item limit exceeded')
        for tool in page.tools:
            value = tool.model_dump(mode='json')
            size += len(json.dumps(value).encode('utf-8')) + 2
            if size > MAX_DISCOVERY_BYTES:
                raise ValueError('MCP discovery response limit exceeded')
            tools.append(value)
        cursor = page.nextCursor
        if not cursor:
            return tools
        if not isinstance(cursor, str) or len(cursor) > 4096 or cursor in seen:
            raise ValueError('Invalid MCP discovery cursor')
        seen.add(cursor)
    raise ValueError('MCP discovery page limit exceeded')


def load_servers():
    home = Path.home() / '.bob'
    project = Path.cwd() / '.bob'
    servers = {}
    for path in (home / 'mcp.json', home / 'settings/mcp.json', home / 'mcp_settings.json',
                 project / 'mcp_settings.json', project / 'mcp.json'):
        if path.is_file():
            data = json.loads(path.read_text())
            servers.update(data.get('mcpServers', {}))
    return servers


async def run(args):
    socket = os.environ.get('BOB_MCP_SOCKET')
    if socket:
        from app.mcp_broker import request
        payload = {'action': args.action}
        if args.action != 'servers':
            payload['server'] = args.server
        if args.action == 'call':
            payload.update(tool=args.tool, arguments=json.loads(args.arguments))
        return await request(socket, payload)
    if os.environ.get('BOB_KNOWLEDGE_SOCKET'):
        raise PermissionError('Authenticated MCP gateway required')
    servers = load_servers()
    if args.action == 'servers':
        return [{'name': name, 'disabled': bool(config.get('disabled')),
                 'transport': 'http' if 'httpURL' in config else 'sse' if 'url' in config else 'stdio'}
                for name, config in sorted(servers.items())]
    config = servers.get(args.server)
    if not config or config.get('disabled'):
        raise ValueError('Connection not found or disabled. Run servers to see available connections.')
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.sse import sse_client
    from mcp.client.streamable_http import streamable_http_client
    import httpx
    async with AsyncExitStack() as stack:
        if 'httpURL' in config:
            client = await stack.enter_async_context(httpx.AsyncClient(headers=config.get('headers', {}), timeout=20))
            streams = await stack.enter_async_context(streamable_http_client(config['httpURL'], http_client=client))
        elif 'url' in config:
            streams = await stack.enter_async_context(sse_client(config['url'], headers=config.get('headers', {})))
        else:
            from anyio import open_file
            stderr = await stack.enter_async_context(await open_file(os.devnull, 'w'))
            streams = await stack.enter_async_context(stdio_client(StdioServerParameters(
                command=config['command'], args=config.get('args', []),
                env={**os.environ, **config.get('env', {})}, cwd=str(Path.cwd())), errlog=stderr.wrapped))
        session = await stack.enter_async_context(ClientSession(streams[0], streams[1]))
        await session.initialize()
        if args.action == 'tools':
            return redact(await list_tools(session), config_secrets(config), mask_sensitive_keys=False)
        result = await session.call_tool(args.tool, arguments=json.loads(args.arguments))
        return redact(result.model_dump(mode='json'), config_secrets(config))


def main():
    logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('servers')
    tools = sub.add_parser('tools'); tools.add_argument('server')
    call = sub.add_parser('call'); call.add_argument('server'); call.add_argument('tool')
    call.add_argument('--arguments', default='{}')
    args = parser.parse_args()
    try:
        async def bounded():
            async with asyncio.timeout(60):
                return await run(args)
        print(json.dumps(asyncio.run(bounded()), ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': 'MCP request failed. Check the server name, tool arguments, connection and credentials.'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
