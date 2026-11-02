"""Old browser tabs retain their hashed module dependencies across releases."""
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi import FastAPI
from app.frontend_assets import frontend_assets


class FrontendAssetsTests(unittest.IsolatedAsyncioTestCase):
    async def test_previous_modules_current_priority_and_missing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            current, archive = Path(directory) / 'current', Path(directory) / 'archive'
            current.mkdir()
            archive.mkdir()
            (current / 'current.js').write_text('current')
            (archive / 'old-office.js').write_text('old office module')
            (archive / 'current.js').write_text('obsolete')
            (Path(directory) / 'private.txt').write_text('private')
            app = FastAPI()
            app.mount('/assets', frontend_assets(current, archive))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                old = await client.get('/assets/old-office.js')
                self.assertEqual(old.status_code, 200)
                self.assertEqual(old.text, 'old office module')
                self.assertIn('javascript', old.headers['content-type'])
                self.assertEqual((await client.get('/assets/current.js')).text, 'current')
                self.assertEqual((await client.get('/assets/missing.js')).status_code, 404)
                self.assertEqual((await client.get('/assets/%2e%2e/private.txt')).status_code, 404)
