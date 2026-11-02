"""Worker lease, cancellation, and recovery behavior with no live jobs."""
import asyncio
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from app import worker


class WorkerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_lease_cancels_running_work(self):
        task = MagicMock()
        with patch.object(worker.asyncio, 'sleep', AsyncMock()), patch.object(worker.job_queue, 'heartbeat', return_value=False) as heartbeat:
            await worker._heartbeat('job', 'token', task)
        heartbeat.assert_called_once_with('job', 'token')
        task.cancel.assert_called_once()

    async def test_cancellation_watcher_cancels_work(self):
        task = MagicMock()
        task.done.return_value = False
        with patch.object(worker.job_queue, 'cancellation_requested', return_value=True):
            await worker._watch_cancel('job', task)
        task.cancel.assert_called_once()

    async def test_execute_failure_records_generic_terminal_error(self):
        job = {'id': 'job', 'worker_token': 'token'}
        with patch.object(worker, '_run', AsyncMock(side_effect=RuntimeError('private details'))), \
             patch.object(worker, '_record', AsyncMock()) as record:
            await worker.execute_job(job, 'token')
        record.assert_awaited_once_with(job, {'type': 'error', 'message': 'Buddy job failed; check worker logs'}, terminal=True)

    async def test_requested_cancellation_records_terminal_event(self):
        job = {'id': 'job', 'worker_token': 'token'}
        with patch.object(worker, '_run', AsyncMock(side_effect=asyncio.CancelledError)), \
             patch.object(worker.job_queue, 'cancellation_requested', return_value=True), \
             patch.object(worker, '_record', AsyncMock()) as record:
            await worker.execute_job(job, 'token')
        record.assert_awaited_once_with(job, {'type': 'error', 'message': 'Stopped by you', 'cancelled': True}, terminal=True)

    async def test_unrequested_cancellation_propagates(self):
        job = {'id': 'job', 'worker_token': 'token'}
        with patch.object(worker, '_run', AsyncMock(side_effect=asyncio.CancelledError)), \
             patch.object(worker.job_queue, 'cancellation_requested', return_value=False), \
             patch.object(worker, '_record', AsyncMock()) as record:
            with self.assertRaises(asyncio.CancelledError):
                await worker.execute_job(job, 'token')
        record.assert_not_awaited()

    async def test_failed_workspace_is_persisted_and_prepared_agent_released(self):
        job = {'id': 'job', 'worker_token': 'token', 'username': 'alice', 'workspace_id': 'session', 'payload': {}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            @contextmanager
            def workspace(*args):
                yield root, root
            with patch.object(worker.storage, 'job_workspace', workspace), \
                 patch.object(worker.storage, 'persist_job') as persist, \
                 patch.object(worker, '_run_in_workspace', AsyncMock(side_effect=RuntimeError('failed'))), \
                 patch.object(worker.bridge, 'release_prepared', AsyncMock()) as release:
                with self.assertRaisesRegex(RuntimeError, 'failed'):
                    await worker._run(job)
            persist.assert_called_once_with(job, root, root)
            self.assertGreaterEqual(release.await_count, 1)


class PresentationRecoveryTests(unittest.TestCase):
    def test_incomplete_rewrite_restores_original_or_quarantines_new_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'presentation.html'
            path.write_text('<html><body>unfinished')
            self.assertTrue(worker._restore_incomplete_html(path, b'previous'))
            self.assertEqual(path.read_bytes(), b'previous')
            path.write_text('<html><body>unfinished')
            self.assertTrue(worker._restore_incomplete_html(path, None))
            self.assertFalse(path.exists())
            self.assertTrue((path.parent / '.presentation.incomplete.html').exists())

    def test_complete_html_deck(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'deck.html'
            self.assertFalse(worker._complete_html_deck(path))

            path.write_text('<html><body>Not a presentation</body></html>')
            with patch('app.presentation.artifact_role', return_value={'is_presentation': False}):
                self.assertFalse(worker._complete_html_deck(path))

            path.write_text('<meta name="bob-artifact-role" content="presentation"><html><body><div>Slide</div></body></html>')
            with patch('app.presentation.artifact_role', return_value={'is_presentation': True}):
                self.assertTrue(worker._complete_html_deck(path))

    def test_record_helper(self):
        job = {'id': 'job1', 'worker_token': 'tok1'}
        with patch.object(worker.job_queue, 'append_event', return_value=True) as mock_append, \
             patch.object(worker.job_queue, 'finish', return_value=True) as mock_finish:
            res1 = asyncio.run(worker._record(job, {'type': 'delta'}, terminal=False))
            self.assertTrue(res1)
            mock_append.assert_called_once_with('job1', 'tok1', {'type': 'delta'})

            res2 = asyncio.run(worker._record(job, {'type': 'done'}, terminal=True))
            self.assertTrue(res2)
            mock_finish.assert_called_once_with('job1', 'tok1', {'type': 'done'})

    def test_run_in_workspace_validations(self):
        job = {'id': 'j1', 'worker_token': 't1', 'username': 'alice', 'workspace_id': 'ws1',
               'payload': {'html_artifact_output_path': 'dash.html'}}
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'dash.html').write_text('existing')
            with self.assertRaises(RuntimeError) as exc:
                asyncio.run(worker._run_in_workspace(job, root, root))
            self.assertIn('Dashboard output already exists', str(exc.exception))

        # Selected approval with remote agent
        job_remote = {'id': 'j1', 'worker_token': 't1', 'username': 'alice', 'workspace_id': 'ws1',
                      'payload': {'agent_name': 'remote-agent', 'approval_policy': {'mode': 'selected'}}}
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(RuntimeError) as exc2:
                asyncio.run(worker._run_in_workspace(job_remote, root, root))
            self.assertIn('Remote agents cannot enforce selected approvals', str(exc2.exception))

        # Remote agent disabled
        job_agent = {'id': 'j1', 'worker_token': 't1', 'username': 'alice', 'workspace_id': 'ws1',
                     'payload': {'agent_name': 'remote-agent'}}
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            from app.app_actions import action_context
            token = action_context.set({'agent_budget': MagicMock(consume=AsyncMock())})
            try:
                with patch('app.worker.get_agent', return_value={'name': 'Remote', 'disabled': True}), \
                     patch.object(worker.job_queue.JobStreamRecorder, 'record_event', AsyncMock(return_value=True)):
                    with self.assertRaises(RuntimeError) as exc3:
                        asyncio.run(worker._run_in_workspace(job_agent, root, root))
                    self.assertIn('no longer configured', str(exc3.exception))
            finally:
                action_context.reset(token)



if __name__ == '__main__':
    unittest.main()
