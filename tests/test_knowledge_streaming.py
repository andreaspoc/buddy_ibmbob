"""Knowledge activity comes from retrieval and is delivered during idle streams."""
from contextlib import asynccontextmanager
import ast
import asyncio
import json
from pathlib import Path
import unittest
from unittest.mock import patch, AsyncMock
from app.knowledge_broker import knowledge_broker


class KnowledgeStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Exercise the real broker handler without binding a sandbox-blocked socket.
        owner = self
        class Server:
            def close(self): pass
            async def wait_closed(self): pass
        async def start(handler, **kwargs):
            owner.handler = handler
            return Server()
        async def connect(socket):
            incoming, outgoing = asyncio.StreamReader(), asyncio.StreamReader()
            class Writer:
                def __init__(self, reader): self.reader = reader
                def write(self, data): self.reader.feed_data(data)
                async def drain(self): pass
                def close(self): self.reader.feed_eof()
                async def wait_closed(self): pass
            asyncio.create_task(owner.handler(incoming, Writer(outgoing)))
            return outgoing, Writer(incoming)
        for name, replacement in [('asyncio.start_unix_server', start),
                                  ('asyncio.open_unix_connection', connect),
                                  ('app.knowledge_broker.os.chmod', lambda *args: None)]:
            patcher = patch(name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def request(self, socket, query):
        reader, writer = await asyncio.open_unix_connection(socket)
        try:
            writer.write(json.dumps({'query': query}).encode() + b'\n')
            await writer.drain()
            return json.loads(await reader.readline())
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_search_reports_query_and_evidence(self):
        events = asyncio.Queue()
        entered = asyncio.Event()
        release = asyncio.Event()
        async def retrieve(query, username):
            entered.set()
            await release.wait()
            return 'Supporting passage and source URL'
        with patch('app.knowledge_broker.search_shared', retrieve):
            async with knowledge_broker(events, username='alice') as socket:
                request = asyncio.create_task(self.request(socket, 'document question'))
                await entered.wait()
                started = await events.get()
                self.assertEqual(started['status'], 'started')
                self.assertEqual(started['input'], {'query': 'document question'})
                self.assertFalse(request.done())
                release.set()
                self.assertEqual((await request)['text'], 'Supporting passage and source URL')
                completed = await events.get()
                self.assertEqual(completed['id'], started['id'])
                self.assertEqual(completed['output'], 'Supporting passage and source URL')
                self.assertEqual(completed['status'], 'completed')

    async def test_failed_search_reports_failure(self):
        events = asyncio.Queue()
        with patch('app.knowledge_broker.search_shared', AsyncMock(side_effect=RuntimeError('private detail'))):
            async with knowledge_broker(events, username='alice') as socket:
                self.assertIn('error', await self.request(socket, 'question'))
                started, failed = await events.get(), await events.get()
                self.assertEqual(failed['id'], started['id'])
                self.assertEqual(failed['status'], 'failed')
                self.assertNotIn('private detail', failed['output'])

    async def test_bridge_delivers_search_before_agent_resumes(self):
        module = ast.parse(Path('app/acp_bridge.py').read_text())
        cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == 'BobACPBridge')
        method = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'stream')
        method.returns = None
        for arg in method.args.args:
            arg.annotation = None
        @asynccontextmanager
        async def fixture_mcp_broker(**kwargs):
            self.assertEqual(kwargs['username'], 'alice')
            yield '/tmp/fixture-mcp.sock'
        namespace = {'mcp_broker': fixture_mcp_broker, 'asyncio': asyncio, 'knowledge_broker': knowledge_broker,
                     'bob_child_environment': lambda home, socket, mcp_socket: {'socket': socket}}
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<bridge>', 'exec'), namespace)
        owner = self
        class Bridge:
            workspace = '/tmp/fixture-workspace'
            stream = namespace['stream']
            async def _stream(self, *args):
                yield {'type': 'start'}
                await owner.request(args[-1]['socket'], 'question')
                yield {'type': 'done'}
        entered, release = asyncio.Event(), asyncio.Event()
        async def retrieve(query, username):
            entered.set()
            await release.wait()
            return 'Evidence'
        with patch('app.knowledge_broker.search_shared', retrieve):
            stream = Bridge().stream('prompt', username='alice')
            self.assertEqual((await anext(stream))['type'], 'start')
            started = await asyncio.wait_for(anext(stream), 1)
            self.assertEqual(started['name'], 'knowledge_search')
            self.assertEqual(started['status'], 'started')
            release.set()
            remaining = [event async for event in stream]
            self.assertEqual([e.get('status', e['type']) for e in remaining], ['completed', 'done'])

        class FailedBridge(Bridge):
            async def _stream(self, *args):
                yield {'type': 'start'}
                raise RuntimeError('stream failed')
        stream = FailedBridge().stream('prompt', username='alice')
        await anext(stream)
        with self.assertRaisesRegex(RuntimeError, 'stream failed'):
            await anext(stream)

        closed = asyncio.Event()
        class IdleBridge(Bridge):
            async def _stream(self, *args):
                try:
                    yield {'type': 'start'}
                    await asyncio.Event().wait()
                finally:
                    closed.set()
        stream = IdleBridge().stream('prompt', username='alice')
        await anext(stream)
        await asyncio.wait_for(stream.aclose(), 1)
        self.assertTrue(closed.is_set())


if __name__ == '__main__':
    unittest.main()
