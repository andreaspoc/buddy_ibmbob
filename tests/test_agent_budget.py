"""Deterministic quota boundary tests; no provider calls or production data."""
import asyncio
import os
import unittest
from unittest.mock import patch

from app.agent_budget import BudgetExceeded, RunBudget, reported_usage


class RunBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def in_process(function, *args):
            await asyncio.sleep(0)
            return function(*args)
        # Exercise interleaving deterministically without depending on host
        # thread-executor shutdown support or starting a database connection.
        mocking = patch('app.agent_budget.asyncio.to_thread', side_effect=in_process)
        mocking.start()
        self.addCleanup(mocking.stop)

    async def test_parallel_calls_cannot_exceed_run_limit(self):
        with patch.dict(os.environ, {'BUDDY_AGENT_MAX_TOOL_CALLS': '3'}), \
                patch('app.agent_budget._reserve_user_action') as reserve:
            budget = RunBudget('synthetic-owner')
            results = await asyncio.gather(*(budget.consume() for _ in range(20)), return_exceptions=True)
        self.assertEqual(sum(result is None for result in results), 3)
        self.assertEqual(reserve.call_count, 3)
        self.assertTrue(all(result is None or isinstance(result, BudgetExceeded) for result in results))

    async def test_remote_and_specialist_share_general_budget(self):
        with patch.dict(os.environ, {'BUDDY_AGENT_MAX_TOOL_CALLS': '2'}), \
                patch('app.agent_budget._reserve_user_action'):
            budget = RunBudget('synthetic-owner')
            await budget.consume('remote')
            await budget.consume('specialist')
            with self.assertRaises(BudgetExceeded):
                await budget.consume('tool')

    async def test_daily_quota_and_accounting_failure_deny(self):
        for failure in (BudgetExceeded('quota exhausted'), RuntimeError('database unavailable')):
            with patch('app.agent_budget._reserve_user_action', side_effect=failure):
                with self.assertRaises(BudgetExceeded):
                    await RunBudget('synthetic-owner').consume()

    async def test_deadline_and_unknown_category_never_reserve(self):
        budget = RunBudget('synthetic-owner')
        with patch('app.agent_budget._reserve_user_action') as reserve:
            budget.deadline = 0
            with self.assertRaises(BudgetExceeded):
                await budget.consume()
            with self.assertRaises(PermissionError):
                await budget.consume('unclassified')
            reserve.assert_not_called()

    def test_invalid_configuration_cannot_disable_quotas(self):
        for value in ('0', '-1', 'garbage'):
            with patch.dict(os.environ, {'BUDDY_AGENT_MAX_TOOL_CALLS': value}):
                with self.assertRaises(ValueError):
                    RunBudget('synthetic-owner')
        with self.assertRaises(PermissionError):
            RunBudget('')

    def test_usage_does_not_fabricate_missing_invalid_or_zero_values(self):
        self.assertEqual(reported_usage(None), {'tokens': None, 'cost': None})
        self.assertEqual(reported_usage({'tokens': True, 'cost': float('nan')}), {'tokens': None, 'cost': None})
        self.assertEqual(reported_usage({'tokens': 0, 'cost': 0}), {'tokens': 0, 'cost': 0})
        self.assertEqual(reported_usage({'tokens': 11, 'cost': 0.1, 'tokens_basis': 'input_output'}),
                         {'tokens': 11, 'cost': 0.1, 'tokens_basis': 'input_output'})


if __name__ == '__main__':
    unittest.main()
