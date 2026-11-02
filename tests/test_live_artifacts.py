import tempfile
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path
from app.live_artifacts import artifact_events,snapshots,stream_live_artifacts


class ArtifactEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_notifications_do_not_stall_updates(self):
        class Connection:
            def __init__(self):
                self.timeouts = []
            async def notifies(self, *, timeout):
                self.timeouts.append(timeout)
                # Simulate a notification timeout, with a committed update that
                # arrived without any matching database notification.
                if False:
                    yield
        connection = Connection()
        read = AsyncMock(side_effect=[
            ([], 'running'),
            ([{'id': 12, 'event': {'type': 'artifact', 'content': 'new'}}], 'completed'),
            ([], 'completed'),
        ])
        result = await asyncio.wait_for(self.collect(connection, read, after_id=10), 1)
        self.assertEqual(result, [{'type': 'artifact', 'content': 'new', 'event_id': 12}, {'type': 'complete'}])
        self.assertEqual(connection.timeouts, [1.0])
        self.assertEqual([call.args[2] for call in read.await_args_list], [10, 10, 12])

    async def test_drains_final_commit_before_completion(self):
        read = AsyncMock(side_effect=[
            ([], 'completed'),
            ([{'id': 5, 'event': {'type': 'artifact', 'content': 'final'}},
              {'id': 6, 'event': {'type': 'done'}}], 'completed'),
            ([], 'completed'),
            ([], 'completed'),
        ])
        result = await self.collect(None, read)
        self.assertEqual([event['type'] for event in result], ['artifact', 'done', 'complete'])
        self.assertEqual(result[0]['content'], 'final')

    async def test_full_page_drains_without_waiting_and_filters_non_artifacts(self):
        rows = [{'id': i, 'event': {'type': 'delta', 'text': 'text'}} for i in range(1, 201)]
        read = AsyncMock(side_effect=[
            (rows, 'completed'),
            ([{'id': 201, 'event': {'type': 'artifact', 'content': 'final'}}], 'completed'),
            ([], 'completed'),
        ])
        result = await self.collect(None, read)
        self.assertEqual([event['type'] for event in result], ['artifact', 'complete'])
        self.assertEqual(result[0]['event_id'], 201)

    async def collect(self, connection, read, after_id=0):
        return [event async for event in artifact_events(connection, 'job', read, after_id)]

class LiveArtifactsTests(unittest.IsolatedAsyncioTestCase):
    async def test_text_chunks_do_not_trigger_workspace_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            async def events():
                for _ in range(100):
                    yield {'type': 'delta', 'text': 'chunk'}
                (root / 'final.md').write_text('Final artifact')
                yield {'type': 'done'}
            with patch('app.live_artifacts.snapshots', wraps=snapshots) as scan:
                result = [event async for event in stream_live_artifacts(events(), root)]
            self.assertEqual(scan.call_count, 2)
            self.assertEqual(sum(event['type'] == 'delta' for event in result), 100)
            self.assertEqual(result[-2]['content'], 'Final artifact')
            self.assertEqual(result[-1]['type'], 'done')

    def test_bounds_and_private_files_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'AGENTS.md').write_text('Private instructions')
            (root/'.secret.html').write_text('secret')
            (root/'large.html').write_text('x'*2000001)
            (root/'index.html').write_text('<h1>Example</h1>')
            self.assertEqual(list(snapshots(root)),['index.html'])
    def test_large_presentation_streams_within_editor_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            content='<html><head><meta name="bob-artifact-role" content="presentation"></head><body><section class="slide">'+('x'*250001)+'</section></body></html>'
            (root/'presentation.html').write_text(content)
            artifact=snapshots(root)['presentation.html']
            self.assertTrue(artifact['is_presentation'])
            self.assertEqual(artifact['content'],content)
    async def test_file_available_before_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            async def events():
                (root/'index.html').write_text('<h1>Draft</h1>')
                yield {'type':'tool','status':'success'}
                (root/'index.html').write_text('<h1>Updated</h1>')
                yield {'type':'done'}
            result=[item async for item in stream_live_artifacts(events(),root)]
            artifacts=[item for item in result if item['type']=='artifact']
            self.assertEqual(len(artifacts),2)
            self.assertEqual(artifacts[-1]['content'],'<h1>Updated</h1>')
            self.assertEqual(result[-1]['type'],'done')


if __name__ == '__main__':
    unittest.main()
