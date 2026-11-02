import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.research_engine import (stream_research, validate_report, SECTIONS, GREEK_SECTIONS, HINDI_SECTIONS,
                                 _can_reuse_evidence, _reusable_draft, _saved_plan, is_research_workspace)

REPORT = '''# Executive summary
Evidence supports the finding [S1].
## Findings
A documented fact [S1].
## Comparisons
Compare the documented alternatives [S2].
## Recommendations
Use the documented result.
## Limitations
One source; methodology: retrieved and reviewed.
## Sources
[S1] Example — https://example.com
'''
EVIDENCE = [
    {'id': 'S1', 'title': 'Example', 'url': 'https://example.com/a', 'text': 'A documented fact', 'fetched_at': '2026-10-08'},
    {'id': 'S2', 'title': 'Primary', 'url': 'https://primary.org/b', 'text': 'Independent evidence', 'fetched_at': '2026-10-08'},
    {'id': 'S3', 'title': 'Additional', 'url': 'https://example.com/c', 'text': 'Additional evidence', 'fetched_at': '2026-10-08'},
]


class FakeBridge:
    def __init__(self, answers):
        self.answers = iter(answers)
        self.calls = []

    async def stream(self, prompt, session, mode, **kwargs):
        self.calls.append((prompt, mode))
        yield {'type': 'delta', 'text': next(self.answers)}
        yield {'type': 'done', 'tokens': 10, 'cost': 0.1}


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    def test_insufficient_independent_sources_rejected(self):
        self.assertTrue(any('independent coverage' in issue for issue in validate_report(REPORT, EVIDENCE[:1])))
        same_publisher = [{**item, 'url': f'https://example.com/{i}'} for i, item in enumerate(EVIDENCE)]
        self.assertTrue(any('independent coverage' in issue for issue in validate_report(REPORT, same_publisher)))

    def test_unknown_citation_rejected(self):
        self.assertTrue(any('Unknown' in issue for issue in validate_report(REPORT.replace('S1', 'S9'), EVIDENCE)))

    def test_bibliography_only_rejected(self):
        body, sources = REPORT.split('## Sources')
        self.assertTrue(any('inline' in issue for issue in validate_report(body.replace('[S1]', '').replace('[S2]', '') + '## Sources' + sources, EVIDENCE)))

    async def test_greek_report_headings_and_generation(self):
        greek_report = REPORT
        for english, greek in zip(SECTIONS, GREEK_SECTIONS):
            greek_report = greek_report.replace(english, greek)
        self.assertEqual(validate_report(greek_report, EVIDENCE), [])
        bridge = FakeBridge(['Σχέδιο', 'Κάλυψη', greek_report, '{"complete":true,"feedback":"Τεκμηριωμένο"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Research topic', {'ui_language': 'el'}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertTrue(all('Write all user-facing responses in Greek' in prompt for prompt, _ in bridge.calls))
            self.assertIn('Σύνοψη, Ευρήματα', bridge.calls[2][0])
            self.assertEqual(Path(directory, 'research-report.md').read_text(), greek_report)

    async def test_hindi_report_headings_and_generation(self):
        hindi_report = REPORT
        for english, hindi in zip(SECTIONS, HINDI_SECTIONS):
            hindi_report = hindi_report.replace(english, hindi)
        self.assertEqual(validate_report(hindi_report, EVIDENCE), [])
        body, sources = hindi_report.split('## स्रोत')
        self.assertTrue(validate_report(body.replace('[S1]', '').replace('[S2]', '') + '## स्रोत' + sources, EVIDENCE))
        bridge = FakeBridge(['योजना', 'साक्ष्य', hindi_report, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Research topic', {'ui_language':'hi'}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertTrue(all('responses in Hindi' in prompt for prompt, _ in bridge.calls))
            self.assertIn('कार्यकारी सारांश, निष्कर्ष', bridge.calls[2][0])
            self.assertTrue(all('शोध:' in event['message'] for event in events if event['type'] == 'status'))
            self.assertEqual(Path(directory, 'research-report.md').read_text(), hindi_report)

    async def test_success_persists_and_aggregates(self):
        bridge = FakeBridge(['Research plan', 'Coverage', REPORT, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Research topic', {}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertEqual(len([e for e in events if e['type']=='research_usage']), 4)
            self.assertEqual(events[-1]['tokens'], 40)
            self.assertAlmostEqual(events[-1]['cost'], 0.4)
            self.assertEqual(Path(directory, 'research-report.md').read_text(), REPORT)
            self.assertTrue(json.loads(Path(directory, 'research-review.json').read_text())['complete'])
            self.assertEqual([e['text'] for e in events if e['type'] == 'delta'], ['', REPORT])

    async def test_reviewer_cannot_override_invalid_citations(self):
        bridge = FakeBridge(['Plan', 'Coverage', REPORT.replace('S1', 'S9'), '{"complete":true,"feedback":"Fine"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Topic', {'max_rounds': 1}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'error')
            self.assertFalse(json.loads(Path(directory, 'research-review.json').read_text())['complete'])
            self.assertTrue(Path(directory, 'research-report.md').exists())

    async def test_screenshots_manifest_and_diagram_instruction(self):
        from unittest.mock import AsyncMock
        bridge = FakeBridge(['Plan', 'Coverage', REPORT, '{"complete":true,"feedback":"Supported"}'])
        capture = AsyncMock(return_value={'path':'research-images/test.png','url':'https://example.com/a','title':'Example','captured_at':'2026-10-08'})
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE), patch('app.research_visuals.capture_screenshot', capture):
            events = [event async for event in stream_research(bridge, 'Topic', {'screenshots':True,'diagrams':True}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'],'done')
            self.assertEqual(capture.await_count,3)
            self.assertEqual(len(json.loads(Path(directory,'research-visuals.json').read_text())),3)
            self.assertIn('Carbon-styled data charts', bridge.calls[2][0])
            self.assertIn('Do not emit Mermaid flowcharts', bridge.calls[2][0])

    async def test_short_requested_run_does_not_retry_rejected_review(self):
        bridge = FakeBridge(['Plan', 'Coverage', REPORT, '{"complete":false,"feedback":"Missing detail"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Research within 2 minutes',
                      {'max_rounds': 3}, workspace=directory, user_home=directory)]
            self.assertEqual(len(bridge.calls), 4)
            self.assertEqual(events[-1]['type'], 'error')
            self.assertIn('Time limit: 120 seconds', bridge.calls[0][0])
            self.assertTrue(Path(directory, 'research-report.md').exists())

    async def test_evidence_timeout_still_writes_verified_draft(self):
        class SlowEvidenceBridge(FakeBridge):
            async def stream(self, prompt, session, mode, **kwargs):
                if 'Collect real source content' in prompt:
                    self.calls.append((prompt, mode))
                    raise TimeoutError('collection timed out')
                    yield
                else:
                    async for event in super().stream(prompt, session, mode, **kwargs):
                        yield event
        bridge = SlowEvidenceBridge(['Plan', REPORT, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            events = [event async for event in stream_research(bridge, 'Topic', {}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertEqual(Path(directory, 'research-report.md').read_text(), REPORT)

    async def test_no_verified_evidence_never_writes_report(self):
        bridge = FakeBridge(['Plan', 'Fabricated sources'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=[]):
            events = [event async for event in stream_research(bridge, 'Topic', {'max_rounds': 1}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'error')
            self.assertFalse(Path(directory, 'research-report.md').exists())
            self.assertEqual(events[-1]['tokens'], 20)
            self.assertIn('No verified sources', events[-1]['message'])
            self.assertNotIn('Draft', events[-1]['message'])

    async def test_planning_cannot_use_tools(self):
        bridge = FakeBridge(['Plan', 'Coverage', REPORT, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            _ = [event async for event in stream_research(bridge, 'Topic', {}, workspace=directory, user_home=directory)]
        self.assertEqual([mode for _, mode in bridge.calls], ['ask', 'agent', 'ask', 'ask'])

    async def test_phase_limit_fires_when_each_event_runs_in_a_new_task(self):
        """The worker advances the stream from a new task per event, as coalesce_text does."""
        class SlowToolBridge(FakeBridge):
            async def stream(self, prompt, session, mode, **kwargs):
                if 'Create a concise research plan' in prompt:
                    self.calls.append((prompt, mode))
                    yield {'type': 'tool', 'id': 't', 'name': 'Tool', 'status': 'started'}
                    await asyncio.sleep(30)
                    yield {'type': 'done'}
                else:
                    async for event in super().stream(prompt, session, mode, **kwargs):
                        yield event
        bridge = SlowToolBridge(['Coverage', REPORT, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            stream = stream_research(bridge, 'Topic', {'timeout_seconds': 60}, workspace=directory, user_home=directory)
            loop = asyncio.get_running_loop()
            started, events = loop.time(), []
            with patch('app.research_engine.min', create=True, side_effect=lambda *a: 0.05 if a[0] == 45.0 else min(*a)):
                while True:
                    try:
                        events.append(await asyncio.create_task(anext(stream)))
                    except StopAsyncIteration:
                        break
            self.assertLess(loop.time() - started, 10)
            self.assertEqual(events[-1]['type'], 'done')

    async def test_resume_reuses_plan_evidence_and_valid_draft(self):
        bridge = FakeBridge(['{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE), \
             patch('app.research_sources.restore_recorded_pages', return_value=3) as restore:
            Path(directory, 'research-plan.json').write_text(json.dumps({'plan': 'Saved plan'}))
            Path(directory, 'research-report.md').write_text(REPORT)
            events = [event async for event in stream_research(bridge, 'Topic', {'session_id': 's1'}, workspace=directory,
                                                               user_home=directory, username='alice')]
            restore.assert_called_once_with(Path(directory), 'alice', 's1')
            self.assertEqual(events[-1]['type'], 'done')
            self.assertEqual(len(bridge.calls), 1)
            self.assertIn('independent read-only reviewer', bridge.calls[0][0])
            self.assertIn('Saved plan', bridge.calls[0][0])

    async def test_resume_rewrites_invalid_draft_without_collecting(self):
        bridge = FakeBridge([REPORT, '{"complete":true,"feedback":"Supported"}'])
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            Path(directory, 'research-plan.json').write_text(json.dumps({'plan': 'Saved plan'}))
            Path(directory, 'research-report.md').write_text('Draft without required sections')
            events = [event async for event in stream_research(bridge, 'Topic', {}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertEqual(len(bridge.calls), 2)
            self.assertEqual(Path(directory, 'research-report.md').read_text(), REPORT)

    async def test_resume_collects_again_when_saved_evidence_is_thin(self):
        bridge = FakeBridge(['Coverage', REPORT, '{"complete":true,"feedback":"Supported"}'])
        loads = [EVIDENCE[:1], EVIDENCE]
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', side_effect=loads):
            Path(directory, 'research-plan.json').write_text(json.dumps({'plan': 'Saved plan'}))
            events = [event async for event in stream_research(bridge, 'Topic', {}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['type'], 'done')
            self.assertIn('Collect real source content', bridge.calls[0][0])

    async def test_failed_writer_keeps_last_draft(self):
        class FailingWriter(FakeBridge):
            async def stream(self, prompt, session, mode, **kwargs):
                self.calls.append((prompt, mode))
                yield {'type': 'error', 'message': 'Writer stopped'}
        with tempfile.TemporaryDirectory() as directory, patch('app.research_engine._load_evidence', return_value=EVIDENCE):
            Path(directory, 'research-plan.json').write_text(json.dumps({'plan': 'Saved plan'}))
            Path(directory, 'research-report.md').write_text('Earlier draft')
            events = [event async for event in stream_research(FailingWriter([]), 'Topic', {}, workspace=directory, user_home=directory)]
            self.assertEqual(events[-1]['message'], 'Writer stopped')
            self.assertEqual(Path(directory, 'research-report.md').read_text(), 'Earlier draft')

    def test_failed_research_without_a_draft_is_still_a_research_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(is_research_workspace(directory, [{'path': 'notes.md'}]))
            self.assertTrue(is_research_workspace(directory, [{'path': 'research-plan.json'}]))
            self.assertTrue(is_research_workspace(directory, [{'path': 'research-report.md'}]))
            Path(directory, 'research-plan.json').write_text('{}')
            self.assertTrue(is_research_workspace(directory, []))

    def test_helpers_tolerate_missing_or_malformed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(_saved_plan(root), '')
            self.assertEqual(_reusable_draft(root, EVIDENCE), '')
            (root / 'research-plan.json').write_text('[1]')
            self.assertEqual(_saved_plan(root), '')
            (root / 'research-plan.json').write_text('{"plan": 3}')
            self.assertEqual(_saved_plan(root), '')
        internal = [{'kind': 'knowledge', 'url': '/knowledge/1/file'}]
        self.assertTrue(_can_reuse_evidence(internal, ['knowledge']))
        self.assertFalse(_can_reuse_evidence(internal, ['web', 'knowledge']))
        self.assertFalse(_can_reuse_evidence([], ['knowledge']))


if __name__ == '__main__':
    unittest.main()
