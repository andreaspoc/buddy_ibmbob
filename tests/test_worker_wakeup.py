"""An idle worker listens before checking the queue and wakes without polling delay."""
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app import worker


class WorkerWakeupTests(unittest.IsolatedAsyncioTestCase):
    async def test_notification_triggers_an_immediate_claim(self):
        job = {'id': 'test-job', 'attempts': 0}
        claim = MagicMock(side_effect=[None, job])
        closed = []

        async def notifications(**kwargs):
            self.assertEqual(kwargs, {'timeout': 1, 'stop_after': 1})
            self.assertEqual(claim.call_count, 1)
            try:
                yield object()
            finally:
                closed.append(True)

        listener = MagicMock()
        listener.notifies.side_effect = notifications
        listener.__aenter__ = AsyncMock(return_value=listener)
        listener.__aexit__ = AsyncMock(return_value=False)
        connect = AsyncMock(return_value=listener)
        sleep = AsyncMock()
        execute = AsyncMock(side_effect=asyncio.CancelledError)
        with patch.object(worker.job_queue, 'ensure_schema'), \
             patch.object(worker.job_queue, 'worker_listener', connect), \
             patch.object(worker.job_queue, 'requeue_expired'), \
             patch.object(worker.job_queue, 'claim', claim), \
             patch.object(worker, 'execute_job', execute), \
             patch.object(worker.asyncio, 'sleep', sleep):
            with self.assertRaises(asyncio.CancelledError):
                await worker._work_loop()
        self.assertEqual(claim.call_count, 2)
        execute.assert_awaited_once()
        sleep.assert_not_awaited()
        self.assertEqual(closed, [True])


if __name__ == '__main__':
    unittest.main()
