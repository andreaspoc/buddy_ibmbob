"""Direct specialist callers cannot bypass quota by omitting broker context."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from app.agent_budget import BudgetExceeded, RunBudget


class SpecialistQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_call_creates_owner_budget_and_denies_before_inference(self):
        source = Path(__file__).resolve().parents[1] / 'app/app_agents.py'
        tree = ast.parse(source.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'delegate')
        namespace = {'Delegate':SimpleNamespace(model_validate=lambda arguments:SimpleNamespace(**arguments))}
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
        context = {'username':'synthetic-owner'}
        with patch.object(RunBudget,'consume',new_callable=AsyncMock,side_effect=BudgetExceeded('Synthetic exhausted quota')) as consume:
            with self.assertRaises(BudgetExceeded):
                await namespace['delegate']('synthetic-owner',{'agent':'notes','task':'Review'},context)
            budget = context['agent_budget']
            self.assertEqual(budget.username,'synthetic-owner')
            with self.assertRaises(BudgetExceeded):
                await namespace['delegate']('synthetic-owner',{'agent':'notes','task':'Review again'},context)
            self.assertIs(context['agent_budget'],budget)
            self.assertEqual(consume.await_count,2)


if __name__ == '__main__':
    unittest.main()
