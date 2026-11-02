"""Release archives retain runtime UI assets and omit development fixtures."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from scripts import package_app


class ReleaseTestSeparationTests(unittest.TestCase):
    def test_archive_keeps_runtime_assets_and_development_sources_on_disk(self):
        runtime = ['app/main.py', 'web/src/App.tsx', 'web/public/logo.svg',
                   'app/static/dist/index.html', 'plugins/learning/buddy_learning/service.py']
        development = ['tests/test_api.py', 'web/tests/fixture.html',
                       'plugins/learning/tests/test_parser.py', 'bindings/java/src/test/Test.java',
                       'bindings/nodejs/test.js', 'bindings/go/zen_test.go',
                       'web/src/example.test.ts', 'app/test_fixture.py',
                       'artifacts/audit/reproduce.mjs', 'reports/coverage.xml']
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in runtime + development:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture')
            archive = root / 'release.zip'
            with patch.object(package_app, 'SOURCE_DIR', root), patch.object(package_app, 'OUTPUT_ZIP', archive):
                package_app.build_zip()
            with ZipFile(archive) as result:
                self.assertEqual(set(result.namelist()), {'bob-acp/' + name for name in runtime})
            self.assertTrue(all((root / name).exists() for name in development))
