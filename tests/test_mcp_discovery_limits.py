"""Adversarial MCP pagination fixtures; no SDK/provider/network needed."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from app import mcp_broker


class Item:
    def __init__(self, value):
        self.value = value

    def model_dump(self, **kwargs):
        return self.value


class DiscoveryLimitsTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cursor_denied_for_every_discovery_type(self):
        for action, method, field in [('tools','list_tools','tools'), ('resources','list_resources','resources'),
                                      ('templates','list_resource_templates','resourceTemplates'), ('prompts','list_prompts','prompts')]:
            with self.subTest(action=action):
                fetch = AsyncMock(return_value=SimpleNamespace(**{field: [], 'nextCursor': 'repeated'}))
                with self.assertRaisesRegex(ValueError, 'repeated'):
                    await mcp_broker.execute({}, action, session=SimpleNamespace(**{method:fetch}))
                self.assertEqual(fetch.await_count, 2)

    async def test_unique_unending_pages_have_hard_cap(self):
        pages = [SimpleNamespace(tools=[], nextCursor=str(i)) for i in range(40)]
        fetch = AsyncMock(side_effect=pages)
        with self.assertRaisesRegex(ValueError, 'page limit'):
            await mcp_broker.execute({}, 'tools', session=SimpleNamespace(list_tools=fetch))
        self.assertEqual(fetch.await_count, 32)

    async def test_oversized_item_count_is_denied_before_serializing(self):
        # Objects deliberately cannot serialize: count validation must run first.
        fetch = AsyncMock(return_value=SimpleNamespace(tools=[object()] * 10001, nextCursor=None))
        with self.assertRaisesRegex(ValueError, 'item limit'):
            await mcp_broker.execute({}, 'tools', session=SimpleNamespace(list_tools=fetch))

    async def test_serialized_bytes_and_invalid_cursor_are_bounded(self):
        fetch = AsyncMock(return_value=SimpleNamespace(tools=[Item({'name':'x'*100})], nextCursor=None))
        with patch.object(mcp_broker, 'MAX_RESPONSE', 50), self.assertRaisesRegex(ValueError, 'response limit'):
            await mcp_broker.execute({}, 'tools', session=SimpleNamespace(list_tools=fetch))
        for cursor in (42, 'x' * 8193):
            fetch = AsyncMock(return_value=SimpleNamespace(tools=[], nextCursor=cursor))
            with self.assertRaisesRegex(ValueError, 'cursor'):
                await mcp_broker.execute({}, 'tools', session=SimpleNamespace(list_tools=fetch))

    async def test_finite_pages_preserve_tool_schema_and_redact_credentials(self):
        pages = [SimpleNamespace(tools=[Item({'name':'search','inputSchema':{'properties':{'formToken':{'type':'string'}}}})], nextCursor='next'),
                 SimpleNamespace(tools=[Item({'name':'fetch','description':'fixture-secret'})], nextCursor=None)]
        fetch = AsyncMock(side_effect=pages)
        result = await mcp_broker.execute({'headers':{'Authorization':'fixture-secret'}}, 'tools', session=SimpleNamespace(list_tools=fetch))
        self.assertEqual(result[0]['inputSchema']['properties']['formToken'], {'type':'string'})
        self.assertEqual(result[1]['description'], '[redacted]')
        self.assertEqual(fetch.await_args.kwargs, {'cursor':'next'})


if __name__ == '__main__':
    unittest.main()
