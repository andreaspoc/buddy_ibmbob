"""Knowledge capability quota checks without network, retrieval or database."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app import knowledge_broker
from app.agent_budget import BudgetExceeded


class KnowledgeQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, budget, query=b'{"query":"synthetic question"}\n'):
        captured = {}
        async def start(handler, **kwargs):
            captured['handler'] = handler
            return SimpleNamespace(close=MagicMock(), wait_closed=AsyncMock())
        writer = SimpleNamespace(write=MagicMock(), drain=AsyncMock(), close=MagicMock(), wait_closed=AsyncMock())
        reader = SimpleNamespace(readline=AsyncMock(return_value=query))
        search = AsyncMock(return_value='Synthetic retrieved passage')
        with patch.object(knowledge_broker.asyncio, 'start_unix_server', side_effect=start), \
                patch.object(knowledge_broker.os, 'chmod'), patch.object(knowledge_broker, 'search_shared', search):
            async with knowledge_broker.knowledge_broker(username='alice', budget=budget):
                await captured['handler'](reader, writer)
        return search, writer

    async def test_quota_checked_before_retrieval(self):
        budget = SimpleNamespace(username='alice', consume=AsyncMock(side_effect=BudgetExceeded('Synthetic exhausted quota')))
        search, writer = await self.exercise(budget)
        budget.consume.assert_awaited_once_with('tool')
        search.assert_not_awaited()
        self.assertIn(b'error', writer.write.call_args.args[0])

    async def test_success_charges_shared_budget_and_fixes_identity(self):
        budget = SimpleNamespace(username='alice', consume=AsyncMock())
        search, writer = await self.exercise(budget)
        budget.consume.assert_awaited_once_with('tool')
        search.assert_awaited_once_with('synthetic question', 'alice')
        self.assertIn(b'Synthetic retrieved passage', writer.write.call_args.args[0])

    async def test_identity_spoofing_is_denied_before_charging_or_retrieval(self):
        budget = SimpleNamespace(username='alice', consume=AsyncMock())
        search, writer = await self.exercise(budget, b'{"query":"synthetic question","username":"bob"}\n')
        budget.consume.assert_not_awaited()
        search.assert_not_awaited()
        self.assertIn(b'error', writer.write.call_args.args[0])

    async def test_budget_owner_mismatch_is_denied_before_opening_socket(self):
        budget = SimpleNamespace(username='bob', consume=AsyncMock())
        with self.assertRaises(PermissionError):
            async with knowledge_broker.knowledge_broker(username='alice', budget=budget):
                self.fail('Mismatched budget must not be exposed')


if __name__ == '__main__':
    unittest.main()
