"""Exercise the production generator without optional People/HTTP dependencies.

Load its function AST unchanged; stub only provider/process imports. This keeps
the security regression executable on the minimal source-review host.
"""
import ast
import asyncio
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

from app.agent_budget import BudgetExceeded, RunBudget


def generator():
    source = Path(__file__).resolve().parents[1] / 'plugins/people/buddy_people/community_away.py'
    tree = ast.parse(source.read_text())
    function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'generate')
    namespace = dict(brand_text=lambda text: text, asyncio=asyncio, json=json, os=os, Path=Path, re=re, tempfile=tempfile,
                     uuid=uuid, RunBudget=RunBudget, ready=lambda:True,
                     _bob_executable=lambda:'/usr/local/bin/bob', TRUSTED_EXECUTABLE_PATH='/usr/local/bin:/usr/bin:/bin',
                     normalize=lambda text: re.sub(r'\W+', '', text.casefold()))
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
    return namespace['generate']


class PeopleQuotaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.generate = generator()
        self.budget = RunBudget('synthetic-owner')
        self.consume = AsyncMock()
        self.budget.consume = self.consume
        self.proc = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(
            b'{"status":"success","last_message":"Synthetic reply"}', b'')))
        self.spawn = AsyncMock(return_value=self.proc)
        self.mocks = [patch.dict('sys.modules', {
            'app.acp_bridge': SimpleNamespace(BOB_CHILD_ENV_NAMES=(), BobACPBridge=SimpleNamespace(_team_args=lambda:[]), _stop_process_group=AsyncMock()),
            'app.agent_sandbox': SimpleNamespace(sandbox_command=lambda command, **kwargs:command)}),
            patch('asyncio.create_subprocess_exec', self.spawn)]
        for mocking in self.mocks:
            mocking.start()
            self.addCleanup(mocking.stop)

    async def test_missing_budget_cannot_launch_inference(self):
        with self.assertRaises(PermissionError):
            await self.generate('Synthetic instructions', 'Synthetic message', [])
        self.spawn.assert_not_awaited()

    async def test_daily_quota_failure_cannot_launch_inference(self):
        self.consume.side_effect = BudgetExceeded('Synthetic exhausted quota')
        with self.assertRaises(BudgetExceeded):
            await self.generate('Synthetic instructions', 'Synthetic message', [], budget=self.budget)
        self.spawn.assert_not_awaited()

    async def test_success_consumes_inference_reservation(self):
        reply = await self.generate('Synthetic instructions', 'Synthetic message', [], budget=self.budget)
        self.assertEqual(reply, 'Synthetic reply')
        self.consume.assert_awaited_once_with('inference')
        self.spawn.assert_awaited_once()

    async def test_duplicate_retry_requires_another_reservation(self):
        self.consume.side_effect = [None, BudgetExceeded('Synthetic retry quota exhausted')]
        with self.assertRaises(BudgetExceeded):
            await self.generate('Synthetic instructions', 'Synthetic message', ['Synthetic reply'],
                                purpose='collaboration', budget=self.budget)
        self.assertEqual(self.consume.await_count, 2)
        self.spawn.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
