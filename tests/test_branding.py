import json
import tempfile
import unittest
from pathlib import Path
from app.branding import refresh_identity_settings


class BrandingTests(unittest.TestCase):
    def test_restored_settings_keep_other_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ('.bob/settings.json', '.home/.bob/settings/settings.json'):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({'customInstructions': 'You are Buddy, powered by IBM Bob.',
                                            'hooks': {'example': 'keep'}}))
            rule = root / '.bob/rules/assistant-identity.md'
            rule.parent.mkdir(parents=True)
            rule.write_text('Buddy (Powered by IBM Bob)\nYou are **Buddy**, powered by **IBM Bob**.')
            refresh_identity_settings(root)
            for relative in ('.bob/settings.json', '.home/.bob/settings/settings.json'):
                data = json.loads((root / relative).read_text())
                self.assertEqual(data['customInstructions'], 'You are Buddy.')
                self.assertEqual(data['hooks'], {'example': 'keep'})
            self.assertNotIn('IBM Bob', rule.read_text())
            first = rule.read_text()
            refresh_identity_settings(root)
            self.assertEqual(rule.read_text(), first)
