"""Bound standalone MCP discovery using synthetic server responses."""
from types import SimpleNamespace
from contextlib import asynccontextmanager
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

from app import mcp_client


class Tool:
    def __init__(self, name):
        self.name = name

    def model_dump(self, **kwargs):
        return {'name': self.name}


def page(names=(), cursor=None):
    return SimpleNamespace(tools=[Tool(name) for name in names], nextCursor=cursor)


class DiscoveryLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_cli_preserves_tool_schema_and_redacts_configured_secrets(self):
        secret = 'synthetic-credential-only'
        schema = {'type': 'object', 'properties': {'password': {'type': 'string'}}}
        tool = SimpleNamespace(model_dump=lambda **kwargs: {
            'name': 'example', 'description': secret, 'inputSchema': schema})
        session = SimpleNamespace(initialize=AsyncMock(), list_tools=AsyncMock(
            return_value=SimpleNamespace(tools=[tool], nextCursor=None)))

        @asynccontextmanager
        async def managed(value):
            yield value

        modules = {
            'mcp': SimpleNamespace(ClientSession=lambda *args: managed(session), StdioServerParameters=object),
            'mcp.client.stdio': SimpleNamespace(stdio_client=None),
            'mcp.client.sse': SimpleNamespace(sse_client=None),
            'mcp.client.streamable_http': SimpleNamespace(streamable_http_client=lambda *args, **kwargs: managed((None, None))),
            'httpx': SimpleNamespace(AsyncClient=lambda **kwargs: managed(None)),
        }
        config = {'httpURL': 'https://example.invalid/mcp', 'headers': {'Authorization': secret}}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True), \
                patch.object(mcp_client, 'load_servers', return_value={'fixture': config}):
            result = await mcp_client.run(SimpleNamespace(action='tools', server='fixture'))
        self.assertEqual(result[0]['inputSchema'], schema)
        self.assertEqual(result[0]['description'], '[redacted]')

    async def test_collects_pages_and_passes_cursor(self):
        session = SimpleNamespace(list_tools=AsyncMock(side_effect=[page(['first'], 'next'), page(['second'])]))
        self.assertEqual(await mcp_client.list_tools(session), [{'name': 'first'}, {'name': 'second'}])
        self.assertEqual(session.list_tools.await_args_list[0].kwargs, {'cursor': None})
        self.assertEqual(session.list_tools.await_args_list[1].kwargs, {'cursor': 'next'})

    async def test_rejects_repeated_and_invalid_cursors(self):
        for cursor in ('cycle', 123, 'x' * 4097):
            with self.subTest(cursor_type=type(cursor).__name__):
                session = SimpleNamespace(list_tools=AsyncMock(return_value=page(cursor=cursor)))
                with self.assertRaisesRegex(ValueError, 'cursor'):
                    await mcp_client.list_tools(session)
                self.assertLessEqual(session.list_tools.await_count, 2)

    async def test_rejects_endless_unique_pages(self):
        session = SimpleNamespace(list_tools=AsyncMock(side_effect=[page(cursor=str(i)) for i in range(3)]))
        with patch.object(mcp_client, 'MAX_DISCOVERY_PAGES', 3):
            with self.assertRaisesRegex(ValueError, 'page limit'):
                await mcp_client.list_tools(session)
        self.assertEqual(session.list_tools.await_count, 3)

    async def test_item_budget_is_cumulative(self):
        session = SimpleNamespace(list_tools=AsyncMock(side_effect=[page(['one', 'two'], 'next'), page(['three'])]))
        with patch.object(mcp_client, 'MAX_DISCOVERY_TOOLS', 2):
            with self.assertRaisesRegex(ValueError, 'item limit'):
                await mcp_client.list_tools(session)

    async def test_response_byte_budget_is_cumulative(self):
        session = SimpleNamespace(list_tools=AsyncMock(side_effect=[page(['first'], 'next'), page(['second'])]))
        with patch.object(mcp_client, 'MAX_DISCOVERY_BYTES', 30):
            with self.assertRaisesRegex(ValueError, 'response limit'):
                await mcp_client.list_tools(session)
