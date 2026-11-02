"""Regression tests for confirmed storage and async cleanup findings."""
import ast
import asyncio
from contextvars import Context, ContextVar
from pathlib import Path
import unittest

from app.agent_warmup import AgentWarmup


class StorageContextTests(unittest.TestCase):
    def test_unset_baseline_cannot_share_mutable_state(self):
        # Exercise the production declaration without importing database drivers.
        tree = ast.parse(Path('app/postgres_storage.py').read_text())
        declaration = next(node for node in tree.body if isinstance(node, ast.AnnAssign)
                           and isinstance(node.target, ast.Name) and node.target.id == '_user_baseline')
        namespace = {'ContextVar': ContextVar}
        exec(compile(ast.Module(body=[declaration], type_ignores=[]),
                     'app/postgres_storage.py', 'exec'), namespace)
        variable = namespace['_user_baseline']
        self.assertIsNone(Context().run(variable.get))
        baseline = {'file': 'digest'}
        context = Context()
        context.run(variable.set, baseline)
        self.assertEqual(context.run(variable.get), baseline)
        self.assertIsNone(Context().run(variable.get))


class CleanupCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_drains_cancelled_child(self):
        started = asyncio.Event()
        closed = asyncio.Event()

        async def child():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()

        task = asyncio.create_task(child())
        await started.wait()
        warmup = AgentWarmup((), None, asyncio.get_running_loop().create_future(), task)
        await warmup.close()
        self.assertTrue(closed.is_set())
        self.assertTrue(task.cancelled())

    async def test_close_preserves_caller_cancellation_during_child_cleanup(self):
        started = asyncio.Event()
        cleaning = asyncio.Event()

        async def child():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(child())
        await started.wait()
        warmup = AgentWarmup((), None, asyncio.get_running_loop().create_future(), task)
        closer = asyncio.create_task(warmup.close())
        await cleaning.wait()
        closer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(closer, 1)
        self.assertTrue(task.done())
