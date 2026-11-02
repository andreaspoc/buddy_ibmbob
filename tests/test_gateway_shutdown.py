"""Production gateway lifecycle tested with synthetic server/socket fixtures."""
import ast
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
import unittest


class Listener:
    closed = False

    def bind(self, address):
        pass

    def listen(self, count):
        pass

    def getsockname(self):
        return ('127.0.0.1', 12345)

    def close(self):
        self.closed = True


@asynccontextmanager
async def client_context(**kwargs):
    yield object()


def gateway_fixture(server, wait_for=asyncio.wait_for):
    listener = Listener()
    source = Path('app/acp_team_gateway.py')
    tree = ast.parse(source.read_text())
    functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name in {'_cancel_gateway_tasks', 'team_gateway'}]
    namespace = {
        'asyncio': SimpleNamespace(create_task=asyncio.create_task, shield=asyncio.shield,
                                  wait_for=wait_for, sleep=asyncio.sleep,
                                  gather=asyncio.gather, CancelledError=asyncio.CancelledError),
        'asynccontextmanager': asynccontextmanager,
        'socket': SimpleNamespace(socket=lambda *args: listener, AF_INET=0, SOCK_STREAM=0),
        'httpx': SimpleNamespace(AsyncClient=client_context, Timeout=lambda *args, **kwargs: None),
        'uvicorn': SimpleNamespace(Config=lambda *args, **kwargs: None),
        'gateway_app': lambda *args: None,
        'LocalGatewayServer': lambda *args: server,
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace['team_gateway'], listener


class GatewayShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def make_server(self, *, slow_cleanup=False):
        running = asyncio.Event()
        cleanup = asyncio.Event()
        release = asyncio.Event()
        finished = asyncio.Event()
        request_finished = asyncio.Event()

        async def request():
            try:
                await asyncio.Event().wait()
            finally:
                request_finished.set()

        request_task = asyncio.create_task(request())
        await asyncio.sleep(0)

        async def serve(**kwargs):
            running.set()
            try:
                await release.wait()
            finally:
                cleanup.set()
                try:
                    if slow_cleanup:
                        await asyncio.Event().wait()
                finally:
                    finished.set()

        server = SimpleNamespace(started=True, should_exit=False, serve=serve,
                                 server_state=SimpleNamespace(tasks={request_task}))
        return server, SimpleNamespace(running=running, cleanup=cleanup, release=release,
                                       finished=finished, request_finished=request_finished,
                                       request_task=request_task)

    async def test_normal_shutdown_closes_listener(self):
        server, state = await self.make_server()
        gateway, listener = gateway_fixture(server)
        async with gateway('synthetic-team', 'synthetic-key'):
            await state.running.wait()
            state.request_task.cancel()
            await asyncio.gather(state.request_task, return_exceptions=True)
            state.release.set()
        self.assertTrue(listener.closed)
        self.assertTrue(server.should_exit)
        self.assertTrue(state.finished.is_set())

    async def test_timeout_drains_server_and_requests(self):
        server, state = await self.make_server()

        async def short_wait(awaitable, timeout):
            return await asyncio.wait_for(awaitable, .01)

        gateway, listener = gateway_fixture(server, short_wait)
        async with gateway('synthetic-team', 'synthetic-key'):
            await state.running.wait()
        self.assertTrue(listener.closed)
        self.assertTrue(state.finished.is_set())
        self.assertTrue(state.request_finished.is_set())
        self.assertTrue(state.request_task.done())

    async def test_caller_cancellation_during_shutdown_propagates(self):
        server, state = await self.make_server()
        shutdown = asyncio.Event()

        async def observed_wait(awaitable, timeout):
            shutdown.set()
            return await asyncio.wait_for(awaitable, timeout)

        gateway, listener = gateway_fixture(server, observed_wait)

        async def owner():
            async with gateway('synthetic-team', 'synthetic-key'):
                await state.running.wait()

        task = asyncio.create_task(owner())
        await shutdown.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertTrue(listener.closed)
        self.assertTrue(state.finished.is_set())
        self.assertTrue(state.request_finished.is_set())

    async def test_new_caller_cancellation_during_timeout_cleanup_propagates(self):
        server, state = await self.make_server(slow_cleanup=True)

        async def short_wait(awaitable, timeout):
            return await asyncio.wait_for(awaitable, .01)

        gateway, listener = gateway_fixture(server, short_wait)

        async def owner():
            async with gateway('synthetic-team', 'synthetic-key'):
                await state.running.wait()

        task = asyncio.create_task(owner())
        await state.cleanup.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertTrue(listener.closed)
        self.assertTrue(state.finished.is_set())
        self.assertTrue(state.request_finished.is_set())

    async def test_second_caller_cancellation_during_cancel_cleanup_propagates(self):
        server, state = await self.make_server(slow_cleanup=True)
        shutdown = asyncio.Event()

        async def observed_wait(awaitable, timeout):
            shutdown.set()
            return await asyncio.wait_for(awaitable, timeout)

        gateway, listener = gateway_fixture(server, observed_wait)

        async def owner():
            async with gateway('synthetic-team', 'synthetic-key'):
                await state.running.wait()

        task = asyncio.create_task(owner())
        await shutdown.wait()
        task.cancel()
        await state.cleanup.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertTrue(listener.closed)
        self.assertTrue(state.finished.is_set())
        self.assertTrue(state.request_finished.is_set())
