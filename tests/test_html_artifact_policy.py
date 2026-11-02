"""Regression coverage for early HTML artifacts and theme instructions."""
import asyncio
import tempfile
import unittest
from pathlib import Path

from app.html_artifact_policy import create_html_scaffold, html_artifact_instruction, is_html_artifact_request
from app.live_artifacts import stream_live_artifacts
from tests.carbon_dashboard_fixture import carbon_scaffold
from app.carbon_chart_assets import embed_carbon_assets, carbon_html_versions, package_changed_carbon_html


class HtmlArtifactTests(unittest.TestCase):
    def test_request_detection(self):
        for text in ['Create an interactive HTML dashboard explaining README', 'build a dashboard', 'create an interactive HTML app', 'create interactive HTML dashboard explaining presentation templates', 'create interactive HTML dashboard for presentation templates', 'HTML dashboard', 'can you create a dashboard for README']:
            self.assertTrue(is_html_artifact_request(text), text)
        for text in ['Create a PowerPoint presentation', 'Create an HTML slide deck', 'Create a dashboard template', 'Do not create a dashboard', 'what is a dashboard', 'how to create a dashboard', 'update existing dashboard', 'fix HTML dashboard', 'explain the dashboard']:
            self.assertFalse(is_html_artifact_request(text), text)
        self.assertFalse(is_html_artifact_request('create dashboard', mode='presentation'))

    def test_policy_and_scaffold(self):
        instruction = html_artifact_instruction('dashboard', 'dashboard.html')
        self.assertIn('purple theme by default', instruction)
        self.assertIn('explicitly requests another palette', instruction)
        self.assertIn('dashboard.html', instruction)
        self.assertIn('Carbon', instruction)
        self.assertIn('Embed the actual data needed', instruction)
        self.assertIn('Do not fetch uploaded files by relative filename', instruction)
        self.assertIn('escape HTML script closing sequences', instruction)
        self.assertIn('interactive Chart.js', instruction)
        self.assertIn('update retained chart instances', instruction)
        self.assertIn('1400ms entrance', instruction)
        self.assertIn('700ms data updates', instruction)
        self.assertIn('same cubic-bezier(.2,0,.38,.9)', instruction)
        self.assertIn('chart.reset()', instruction)
        self.assertIn('bob:chart-activate', instruction)
        self.assertIn('never invent weights', instruction)
        self.assertIn('embedded copy', instruction)
        source = create_html_scaffold('<README>')
        self.assertIn('&lt;README&gt;', source)
        self.assertIn('bob-artifact-role', source)
        self.assertIn('prefers-reduced-motion', source)
        self.assertIn('</html>', source)
        self.assertNotIn('id="bob-visual-runtime"', source)
        self.assertIn('buddy-chartjs', source)
        self.assertIn('buddy-carbon-css', source)
        self.assertNotIn('/static/carbon-charts.bundle.js', source)
        self.assertNotIn('echarts', source.lower())

    def test_offline_packaging_is_scoped_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'carbon-charts.css').write_text('/* </style> */ .chart{color:purple}')
            (root / 'carbon-charts.bundle.js').write_text('window.library="</script>";')
            source = carbon_scaffold('Export')
            packed = embed_carbon_assets(source, root)
            self.assertIn('data-buddy-carbon-embedded="true"', packed)
            self.assertIn('<meta charset="utf-8">', packed[:1024], 'Encoding must precede large inline assets')
            self.assertIn(r'<\/script>', packed)
            self.assertIn(r'<\/style>', packed)
            self.assertNotIn('src="/static/carbon-charts.bundle.js"', packed)
            self.assertNotIn('href="/static/carbon-charts.css"', packed)
            self.assertEqual(embed_carbon_assets(packed, root), packed)
            ordinary = '<html><head></head><body>ordinary</body></html>'
            self.assertEqual(embed_carbon_assets(ordinary, root), ordinary)
            untrusted = source.replace('/static/carbon-charts.bundle.js', 'https://other.example/code.js')
            self.assertIn('https://other.example/code.js', embed_carbon_assets(untrusted, root))

    def test_external_min_aliases_and_false_embedded_markers_are_repaired(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'carbon-charts.css').write_text('.chart{color:purple}')
            (root / 'carbon-charts.bundle.js').write_text('window.BuddyCarbonCharts={};')
            source = ("<html><head><meta charset='utf-8'>"
                      '<link data-buddy-carbon-embedded="buddy-carbon-css" href="/static/carbon-charts.min.css" rel="stylesheet">'
                      '<script data-buddy-carbon-embedded="buddy-carbon-js" src="/static/carbon-charts.bundle.min.js"></script>'
                      '</head><body><script>BobVisuals.carbon(element,spec)</script></body></html>')
            packed = embed_carbon_assets(source, root)
            self.assertNotIn('src="/static/carbon-charts.bundle.min.js"', packed)
            self.assertNotIn('href="/static/carbon-charts.min.css"', packed)
            self.assertIn('window.BuddyCarbonCharts={}', packed)
            self.assertIn('window.BobVisuals =', packed)
            self.assertLess(packed.index('id="bob-visual-runtime"'), packed.index('BobVisuals.carbon(element,spec)'))
            self.assertEqual(embed_carbon_assets(packed, root), packed)

    def test_existing_embedded_bundle_can_receive_missing_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'carbon-charts.css').write_text('.chart{}')
            (root / 'carbon-charts.bundle.js').write_text('window.BuddyCarbonCharts={};')
            source = '<html><head></head><body>BobVisuals.carbon</body></html>'
            packed = embed_carbon_assets(source, root)
            start = packed.index('<script id="bob-visual-runtime">')
            end = packed.index('</script>', start) + len('</script>')
            missing = packed[:start] + packed[end:]
            # No build files are needed when only the adapter is missing.
            repaired = embed_carbon_assets(missing, root / 'not-present')
            self.assertIn('id="bob-visual-runtime"', repaired)
            self.assertEqual(repaired.count('id="buddy-carbon-js"'), 1)
            self.assertEqual(embed_carbon_assets(repaired, root), repaired)

    def test_only_changed_complete_opted_in_files_are_packaged(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = root / 'previous.html'
            previous.write_text(carbon_scaffold())
            before = carbon_html_versions(root)
            current = root / 'new.html'
            current.write_text(carbon_scaffold())
            partial = root / 'partial.html'
            partial.write_text('<html>BobVisuals.carbon')
            ordinary = root / 'plain.html'
            ordinary.write_text('<html>ordinary</html>')
            with patch('app.carbon_chart_assets.embed_carbon_assets', return_value='PACKAGED') as package:
                package_changed_carbon_html(root, before)
            self.assertEqual(package.call_count, 1)
            self.assertEqual(current.read_text(), 'PACKAGED')
            self.assertIn('buddy-carbon-css', previous.read_text())
            self.assertEqual(partial.read_text(), '<html>BobVisuals.carbon')
            self.assertEqual(ordinary.read_text(), '<html>ordinary</html>')

    def test_stream_emits_scaffold_and_updates_before_done(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / 'dashboard.html'
                target.write_text(carbon_scaffold())
                (root / 'other.html').write_text('<html>Existing unrelated artifact</html>')
                async def source():
                    await asyncio.sleep(.65)
                    target.write_text(carbon_scaffold('Updated dashboard'))
                    yield {'type':'progress'}
                    yield {'type':'done'}
                events = [event async for event in stream_live_artifacts(source(), root, initial_paths=[str(target)])]
                artifacts = [event for event in events if event['type']=='artifact']
                self.assertEqual(len(artifacts), 2)
                self.assertEqual(artifacts[0]['path'], 'dashboard.html')
                self.assertIn('Updated dashboard', artifacts[1]['content'])
                self.assertEqual(events[-1]['type'], 'done')
        asyncio.run(scenario())

    def test_no_existing_artifact_replay(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as directory:
                (Path(directory)/'existing.html').write_text(carbon_scaffold())
                async def source():
                    yield {'type':'done'}
                events = [event async for event in stream_live_artifacts(source(),directory)]
                self.assertEqual(events,[{'type':'done'}])
        asyncio.run(scenario())


if __name__ == '__main__':
    unittest.main()
