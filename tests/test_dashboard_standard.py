"""The default dashboard standard is built into every new dashboard and carries no data."""
import re
import tempfile
import unittest
from pathlib import Path

from app.carbon_chart_assets import embed_carbon_assets
from app.html_artifact_policy import DASHBOARD_CSS, DASHBOARD_RUNTIME, create_html_scaffold, html_artifact_instruction


class DashboardStandardTests(unittest.TestCase):
    def test_scaffold_carries_the_kit_and_the_board_structure(self):
        source = create_html_scaffold('Board')
        self.assertIn('<style id="bob-dashboard-standard">', source)
        self.assertIn(DASHBOARD_CSS, source)
        self.assertIn('<script id="bob-dashboard-runtime">', source)
        self.assertIn(DASHBOARD_RUNTIME, source)
        for marker in ('class="header"', 'class="header-meta"', 'class="nav-bar"', 'role="tablist"', 'id="panel-overview"', 'class="main"'):
            self.assertIn(marker, source)

    def test_runtimes_load_after_the_page_content(self):
        source = create_html_scaffold('Board')
        self.assertLess(source.index('</main>'), source.index('id="bob-dashboard-runtime"'))
        self.assertLess(source.index('id="buddy-chartjs"'), source.index('id="bob-dashboard-runtime"'))

    def test_every_chart_helper_class_has_a_style(self):
        for name in ('kpi-card', 'chart-card', 'donut-center', 'chart-replay-btn', 'entity-card', 'table-wrap', 'status-badge', 'prog-bar', 'chart-error'):
            self.assertIn('.' + name, DASHBOARD_CSS)

    def test_standard_is_the_default_but_the_user_can_override_it(self):
        instruction = html_artifact_instruction('dashboard')
        self.assertIn('DASHBOARD STANDARD: Unless the user explicitly asks for a different style or layout', instruction)
        self.assertIn('explicitly requests another palette', instruction)

    def test_edits_keep_the_existing_design(self):
        self.assertIn('Preserve the existing theme, layout and functionality when editing', html_artifact_instruction('dashboard'))

    def test_instruction_requires_honest_snapshot_figures(self):
        instruction = html_artifact_instruction('dashboard')
        self.assertIn('Show the date of the data rather than the viewer clock', instruction)
        self.assertIn('Omit a section the data cannot honestly support', instruction)
        self.assertIn('BobDashboard.escapeHtml must wrap every data value', instruction)

    def test_instruction_no_longer_asks_for_neutral_surfaces(self):
        self.assertNotIn('neutral surfaces', html_artifact_instruction('dashboard'))

    def test_kit_names_every_class_the_instruction_requires(self):
        instruction = html_artifact_instruction('dashboard')
        section = instruction[instruction.index('DASHBOARD STANDARD'):instruction.index('Helpers:')]
        for name in re.findall(r'\.([a-z][a-z-]+)', section):
            self.assertIn('.' + name, DASHBOARD_CSS, name)

    def test_chart_js_is_the_only_chart_library(self):
        instruction = html_artifact_instruction('dashboard')
        self.assertIn('Chart.js is the only chart library allowed', instruction)
        self.assertIn('unless the user explicitly names another library', instruction)
        self.assertIn('Keep the Carbon UI', instruction)
        self.assertIn('buddy-carbon-css', instruction)
        self.assertNotIn('bob-visual-runtime', instruction)
        scripts = re.findall(r'src="([^"]+)"', create_html_scaffold('Board'))
        self.assertEqual(len(scripts), 1)
        self.assertIn('chart.js', scripts[0])

    def test_saved_dashboard_carries_carbon_styles_without_the_chart_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'carbon-charts.css').write_text('.cds--btn{color:purple}')
            (root / 'carbon-charts.bundle.js').write_text('window.BuddyCarbonCharts={};')
            packed = embed_carbon_assets(create_html_scaffold('Board'), root)
            self.assertIn('<style id="buddy-carbon-css" data-buddy-carbon-embedded="true">.cds--btn{color:purple}</style>', packed)
            self.assertNotIn('/static/carbon-charts.css', packed)
            self.assertNotIn('BuddyCarbonCharts', packed)
            self.assertEqual(embed_carbon_assets(packed, root), packed)

    def test_kit_holds_design_only(self):
        kit = (Path('app/dashboard_standard.css').read_text(encoding='utf-8') + Path('app/dashboard_standard.js').read_text(encoding='utf-8')).lower()
        for private in ('monday.com', 'backend tickets'):
            self.assertNotIn(private, kit)


if __name__ == '__main__':
    unittest.main()
