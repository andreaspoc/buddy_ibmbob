"""MCP stdio adapters retain and close their asynchronously managed stderr."""
import asyncio
from contextlib import asynccontextmanager
import os
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from app import mcp_broker, mcp_client


class AsyncStderr:
    """Test double for AnyIO AsyncFile; expose an actual subprocess-compatible FD."""
    def __init__(self, events):
        self.events = events
        self.wrapped = open(os.devnull, 'w')

    async def __aenter__(self):
        self.events.append('stderr-enter')
        return self

    async def __aexit__(self, *args):
        self.wrapped.close()
        self.events.append('stderr-close')


class McpStdioCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, adapter, outcome):
        events = []
        files = []
        initialized = asyncio.Event()
        # Transport is mocked; use an allowed entry point so the broker's
        # command policy is exercised without starting a real server.
        config = {'command': sys.executable, 'args': ['-m', 'app.mcp_search']}

        async def open_file(path, mode):
            self.assertEqual((path, mode), (os.devnull, 'w'))
            value = AsyncStderr(events)
            files.append(value)
            return value

        async def initialize():
            initialized.set()
            if outcome == 'error':
                raise RuntimeError('Synthetic initialization failure')
            if outcome == 'cancel':
                await asyncio.Event().wait()
            return SimpleNamespace(serverInfo=SimpleNamespace(name='fixture'),
                capabilities=SimpleNamespace(model_dump=lambda **kwargs: {}))

        session = SimpleNamespace(initialize=initialize, list_tools=AsyncMock(
            return_value=SimpleNamespace(tools=[], nextCursor=None)))

        @asynccontextmanager
        async def stdio_client(params, *, errlog):
            if adapter == 'broker':
                self.assertEqual(params.env['PYTHONSAFEPATH'], '1')
                self.assertEqual(params.env['PYTHONPATH'], mcp_broker.TRUSTED_MODULE_ROOT)
            self.assertFalse(errlog.closed)
            self.assertIs(errlog, files[0].wrapped)
            # Validate that the SDK receives a real TextIO object, not async write().
            subprocess.run([sys.executable, '-c', 'import sys; sys.stderr.write("synthetic stderr")'],
                           stderr=errlog, check=True, timeout=5)
            events.append('transport-enter')
            try:
                yield (None, None)
            finally:
                self.assertFalse(errlog.closed)
                events.append('transport-close')

        @asynccontextmanager
        async def connected(*args):
            yield session

        modules = {
            'anyio': SimpleNamespace(open_file=AsyncMock(side_effect=open_file)),
            'mcp': SimpleNamespace(ClientSession=connected, StdioServerParameters=lambda **kwargs: SimpleNamespace(**kwargs)),
            'mcp.client.stdio': SimpleNamespace(stdio_client=stdio_client),
            'mcp.client.sse': SimpleNamespace(sse_client=None),
            'mcp.client.streamable_http': SimpleNamespace(streamable_http_client=None),
            'httpx': SimpleNamespace(),
        }

        async def run():
            if adapter == 'broker':
                async with mcp_broker.open_session(config):
                    pass
            else:
                return await mcp_client.run(SimpleNamespace(action='tools', server='fixture'))

        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True), \
                patch.object(mcp_client, 'load_servers', return_value={'fixture': config}):
            task = asyncio.create_task(run())
            if outcome == 'cancel':
                await asyncio.wait_for(initialized.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            elif outcome == 'error':
                with self.assertRaisesRegex(RuntimeError, 'Synthetic initialization'):
                    await task
            else:
                await task
            modules['anyio'].open_file.assert_awaited_once_with(os.devnull, 'w')
        self.assertTrue(files[0].wrapped.closed)
        self.assertEqual(events, ['stderr-enter', 'transport-enter', 'transport-close', 'stderr-close'])

    async def test_success(self):
        for adapter in ('broker', 'cli'):
            with self.subTest(adapter=adapter):
                await self.exercise(adapter, 'success')

    async def test_initialization_failure(self):
        for adapter in ('broker', 'cli'):
            with self.subTest(adapter=adapter):
                await self.exercise(adapter, 'error')

    async def test_cancellation(self):
        for adapter in ('broker', 'cli'):
            with self.subTest(adapter=adapter):
                await self.exercise(adapter, 'cancel')
