"""Dashboards with broken scripts must be flagged, not delivered as silently blank charts."""
import base64
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.html_artifact_check import (BANNER_ID, CHART_LIBRARY, embed_chart_library, flag_changed_html, flag_script_errors, html_versions, inline_scripts, repair_optional_assignments,
                                     repair_scripts, script_errors)
from app.html_artifact_policy import CHARTJS_ASSET_TAG, SCRIPT_CHECK_COMMAND, create_html_scaffold, html_artifact_instruction

BROKEN = "<!doctype html><html><body class='x'>\n<canvas></canvas>\n<script>\nconst a = 1;\nconst = broken(;\n</script></body></html>"
VALID = '<html><body><script>const a = 1;</script></body></html>'


class ScriptErrorTests(unittest.TestCase):
    def test_the_real_failure_is_found_with_its_page_line(self):
        errors = script_errors(BROKEN)
        self.assertEqual(len(errors), 1)
        self.assertIn('line 5', errors[0])
        self.assertIn('SyntaxError', errors[0])

    def test_valid_pages_and_the_new_scaffold_pass(self):
        self.assertEqual(script_errors(VALID), [])
        self.assertEqual(script_errors(create_html_scaffold('Board')), [])

    def test_data_blocks_and_external_scripts_are_not_checked(self):
        source = '<script type="application/json">{not js</script><script src="a.js">broken(</script><script type="text/plain">(</script>'
        self.assertEqual(inline_scripts(source), [])

    def test_modules_are_checked_as_modules(self):
        self.assertEqual(script_errors('<script type="module">import x from "./x.js"; export { x };</script>'), [])
        self.assertTrue(script_errors('<script type="module">export (</script>'))

    def test_every_script_is_checked(self):
        self.assertEqual(len(script_errors('<script>(</script><script>ok();</script><script>)</script>')), 2)

    def test_check_is_skipped_when_node_is_missing_or_hangs(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired('node', 1)):
            with patch('app.html_artifact_check.subprocess.run', side_effect=error), self.assertLogs('app.html_artifact_check', 'WARNING'):
                self.assertEqual(script_errors('<script>(</script>'), [])

    def test_unparseable_node_output_still_reports_an_error(self):
        done = subprocess.CompletedProcess([], 1, '', '')
        with patch('app.html_artifact_check.subprocess.run', return_value=done):
            self.assertEqual(script_errors('<script>x</script>'), ['line 1: Syntax error'])


class BannerTests(unittest.TestCase):
    def test_broken_page_gets_one_visible_warning_right_after_body(self):
        updated, errors = flag_script_errors(BROKEN)
        self.assertTrue(errors)
        self.assertIn(f"<body class='x'><div id=\"{BANNER_ID}\" role=\"alert\"", updated)
        again, _ = flag_script_errors(updated)
        self.assertEqual(again.count(BANNER_ID), 1)

    def test_page_without_body_still_shows_the_warning(self):
        updated, _ = flag_script_errors('<script>(</script>')
        self.assertTrue(updated.startswith(f'<div id="{BANNER_ID}"'))

    def test_warning_is_removed_once_the_page_is_fixed(self):
        flagged, _ = flag_script_errors(BROKEN)
        fixed = flagged.replace('const = broken(;', '')
        cleaned, errors = flag_script_errors(fixed)
        self.assertEqual(errors, [])
        self.assertNotIn(BANNER_ID, cleaned)

    def test_valid_page_is_unchanged(self):
        self.assertEqual(flag_script_errors(VALID), (VALID, []))

    def test_error_text_is_escaped_and_limited(self):
        with patch('app.html_artifact_check.script_errors', return_value=['<b>1', '2', '3', 'fourth']):
            updated, errors = flag_script_errors('<body>')
        self.assertIn('&lt;b&gt;1', updated)
        self.assertNotIn('fourth', updated)
        self.assertEqual(len(errors), 4)


class SavedFileRepairTests(unittest.TestCase):
    REAL = "q('a')?.style&&(q('a')?.style.display='block');"

    def test_the_real_failure_is_repaired_in_the_saved_page(self):
        page = f'<body><script>{self.REAL}</script></body>'
        updated, errors = flag_script_errors(page)
        self.assertEqual(errors, [])
        self.assertNotIn(BANNER_ID, updated)
        self.assertIn("(q('a')?.style ?? {}).display='block'", updated)

    def test_repaired_forms_are_valid_javascript(self):
        for code in ('a?.b = 1', 'a?.b.c = 1', 'a?.b?.c = 1', "a?.['b'] = 1", "a?.b['c'] = 1", 'a.b?.c = 1', 'a?.f(1).c = 2', "get(['x'][0], 'y')?.z = 1"):
            fixed = repair_optional_assignments(code)
            self.assertNotEqual(fixed, code)
            self.assertEqual(script_errors(f'<script>{fixed}</script>'), [], code)

    def test_valid_and_unsafe_code_is_left_alone(self):
        for code in ('const a = b?.c;', 'if (a?.b == 1) x();', 'if (a?.b === 1) x();', 'const v = t ? .5 : 1;', 'const v = t?.5:1;', 'a?.b();', 'a?.b().c;',
                     "const s = 'a?.b = 1';", 'const s = "a?.b = 1";', 'const s = `a?.b = 1`;', '// a?.b = 1', '/* a?.b = 1 */', "const s = 'it\\'s a?.b = 1';",
                     'a?.;', 'a?.b(', 'a?.[1', 'a?.b[1', ')?.b = 1', '1?.b = 2', 'a?.b() = 1', "'open", '/* open', '// open', '(] x)?.b = 1', 'a?.b[(].c = 1', 'a?.b(].c = 1'):
            self.assertEqual(repair_optional_assignments(code), code, code)

    def test_only_inline_javascript_is_repaired(self):
        kept = '<p>a?.b = 1</p><script src="x.js">a?.b = 1</script><script type="application/json">{"k":"a?.b = 1"}</script><script type=text/plain>a?.b = 1</script>'
        self.assertEqual(repair_scripts(kept), kept)
        self.assertIn('(a ?? {}).b = 1', repair_scripts('<script type="text/javascript">a?.b = 1</script>'))

    def test_several_statements_keep_the_code_around_them(self):
        fixed = repair_optional_assignments('let n = 1; a?.b = 2; n = 3; a?.c = 4; n = 5;')
        self.assertEqual(fixed, 'let n = 1; (a ?? {}).b = 2; n = 3; (a ?? {}).c = 4; n = 5;')


class EmbeddedChartLibraryTests(unittest.TestCase):
    CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'

    def page(self, url=CDN):
        return f'<html><head><script src="{url}" crossorigin="anonymous"></script></head><body></body></html>'

    def test_bundled_copy_is_the_exact_published_release(self):
        digest = base64.b64encode(hashlib.sha384(CHART_LIBRARY.encode()).digest()).decode()
        self.assertIn(f'sha384-{digest}', CHARTJS_ASSET_TAG)
        self.assertNotIn('</script', CHART_LIBRARY.lower())

    def test_version_4_cdn_tags_are_replaced(self):
        for url in (self.CDN, 'https://cdn.jsdelivr.net/npm/chart.js', 'https://cdn.jsdelivr.net/npm/chart.js@4', 'https://unpkg.com/chart.js@4.4.1/dist/chart.umd.js',
                    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'):
            updated = embed_chart_library(self.page(url))
            self.assertNotIn(url, updated, url)
            self.assertIn('data-buddy-embedded="chart.js@4.4.4"', updated)

    def test_scaffold_tag_is_replaced_and_the_page_still_passes(self):
        updated = embed_chart_library(create_html_scaffold('Board'))
        self.assertNotIn('src="https://cdn.jsdelivr.net/npm/chart.js', updated)
        self.assertEqual(script_errors(updated), [])

    def test_other_versions_and_libraries_are_left_alone(self):
        for url in ('https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/2.9.4/Chart.min.js', 'https://cdn.jsdelivr.net/npm/echarts@5'):
            self.assertEqual(embed_chart_library(self.page(url)), self.page(url), url)

    def test_embedding_twice_changes_nothing(self):
        once = embed_chart_library(self.page())
        self.assertEqual(embed_chart_library(once), once)

    def test_file_near_the_size_limit_keeps_its_link(self):
        big = self.page() + 'x' * 1_900_000
        self.assertEqual(embed_chart_library(big), big)

    def test_repair_leaves_the_library_untouched(self):
        self.assertEqual(repair_optional_assignments(CHART_LIBRARY), CHART_LIBRARY)

    def test_changed_file_is_saved_with_the_library(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'board.html'
            target.write_text(self.page())
            self.assertEqual(flag_changed_html(directory, {}), {})
            self.assertIn('data-buddy-embedded', target.read_text())


class ChangedFileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def test_only_files_changed_by_this_job_are_touched(self):
        (self.root / 'old.html').write_text(BROKEN)
        before = html_versions(self.root)
        (self.root / 'new.html').write_text(BROKEN)
        with self.assertLogs('app.html_artifact_check', 'WARNING'):
            flagged = flag_changed_html(self.root, before)
        self.assertEqual(list(flagged), ['new.html'])
        self.assertNotIn(BANNER_ID, (self.root / 'old.html').read_text())
        self.assertIn(BANNER_ID, (self.root / 'new.html').read_text())

    def test_valid_new_file_is_left_exactly_as_written(self):
        target = self.root / 'ok.html'
        target.write_text(VALID)
        self.assertEqual(flag_changed_html(self.root, {}), {})
        self.assertEqual(target.read_text(), VALID)

    def test_private_folders_links_and_binary_files_are_skipped(self):
        (self.root / '.bob').mkdir()
        (self.root / '.bob' / 'x.html').write_text(BROKEN)
        (self.root / 'bin.html').write_bytes(b'\xff\xfe<script>(')
        (self.root / 'link.html').symlink_to(self.root / 'bin.html')
        self.assertEqual(flag_changed_html(self.root, {}), {})
        self.assertEqual(set(html_versions(self.root)), {self.root / 'bin.html'})


class SelfCheckInstructionTests(unittest.TestCase):
    def run_command(self, page):
        target = Path(self.directory.name) / 'page.html'
        target.write_text(page)
        return subprocess.run(['bash', '-c', SCRIPT_CHECK_COMMAND.replace('DASHBOARD_FILE', str(target))], capture_output=True, text=True, check=False)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def test_buddy_is_told_to_run_the_check(self):
        instruction = html_artifact_instruction('dashboard')
        self.assertIn(SCRIPT_CHECK_COMMAND, instruction)
        self.assertIn('never replace the whole file', instruction)

    def test_command_passes_good_pages_and_fails_the_real_mistake(self):
        good = self.run_command(create_html_scaffold('Board'))
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertIn('OK', good.stdout)
        self.assertNotEqual(self.run_command(BROKEN).returncode, 0)
        self.assertEqual(self.run_command('<script type="application/json">{not js</script>').returncode, 0)


if __name__ == '__main__':
    unittest.main()
