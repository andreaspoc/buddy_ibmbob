"""Exercise memory security without requiring the web/database runtime."""
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, patch
import unittest
from datetime import datetime, timedelta, timezone


def load_memory_module():
    # Only dependency adapters are stubbed; sanitization, expiry, storage and
    # context functions execute directly from the production module.
    modules = {name: ModuleType(name) for name in ('fastapi', 'pydantic', 'app.auth', 'app.projects')}
    modules['fastapi'].APIRouter = MagicMock
    modules['fastapi'].Depends = lambda value: None
    modules['fastapi'].HTTPException = RuntimeError
    modules['pydantic'].BaseModel = object
    modules['pydantic'].Field = lambda **kwargs: None
    modules['app.auth'].current_user = lambda: None
    modules['app.projects'].database = MagicMock()
    modules['app.projects'].project_root = MagicMock()
    spec = importlib.util.spec_from_file_location('memory_security_subject', Path(__file__).parents[1] / 'app' / 'project_memory.py')
    subject = importlib.util.module_from_spec(spec)
    with patch.dict('sys.modules', modules):
        spec.loader.exec_module(subject)
    return subject


memory = load_memory_module()


class MemorySecurityTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'BUDDY_MEMORY_SIGNING_KEY': 'fixture-memory-signing-key-32-characters'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def signed(self, **changes):
        record = {'brief': 'Project facts', 'revision': 1,
                  'expires_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), **changes}
        record['signature'] = memory.memory_signature(record, 'alice', 'project', memory.signing_key())
        return record

    def test_signed_memory_accepts_exact_owner_project_and_content(self):
        view = memory.memory_view(self.signed(), username='alice', project_id='project')
        self.assertFalse(view['needs_renewal'])

    def test_tampering_or_scope_changes_require_owner_renewal(self):
        for field, value in (('brief', 'Altered instructions'), ('revision', 2),
                             ('expires_at', (datetime.now(timezone.utc) + timedelta(days=300)).isoformat())):
            record = {**self.signed(), field: value}
            with self.subTest(field=field):
                self.assertTrue(memory.memory_view(record, username='alice', project_id='project')['needs_renewal'])
        for owner, project in (('bob', 'project'), ('alice', 'different')):
            self.assertTrue(memory.memory_view(self.signed(), username=owner, project_id=project)['needs_renewal'])

    def test_unsigned_memory_requires_renewal_even_with_future_expiry(self):
        record = self.signed()
        record.pop('signature')
        self.assertTrue(memory.memory_view(record, username='alice', project_id='project')['needs_renewal'])
        for signature in ('invalid', '🔒', 42):
            self.assertTrue(memory.memory_view({**record, 'signature': signature},
                username='alice', project_id='project')['needs_renewal'])

    def test_provider_keys_cannot_sign_memory(self):
        with patch.dict('os.environ', {'BOB_API_KEY': 'fixture-provider-key-with-at-least-32-characters'}, clear=True):
            self.assertIsNone(memory.signing_key())
            with self.assertRaises(RuntimeError) as error:
                memory.save_memory('alice', 'project', SimpleNamespace(brief='facts', revision=0, expires_in_days=30))
            self.assertEqual(error.exception.args[0], 503)

    def test_service_key_fallback_and_invalid_primary_fail_closed(self):
        with patch.dict('os.environ', {'BUDDY_APP_AGENT_SECRET': 'fixture-service-key-with-at-least-32-characters'}, clear=True):
            self.assertIsNotNone(memory.signing_key())
        with patch.dict('os.environ', {'BUDDY_MEMORY_SIGNING_KEY': 'short',
                'BUDDY_APP_AGENT_SECRET': 'fixture-service-key-with-at-least-32-characters'}, clear=True):
            self.assertIsNone(memory.signing_key())

    def test_credentials_and_direct_identifiers_are_minimized(self):
        raw = ('api_key=fixture-secret Bearer fixture-bearer person@example.test '
               '123-45-6789 4111 1111 1111 1111\n'
               '-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----')
        result = memory.sanitize_brief(raw)
        for value in ('fixture-secret', 'fixture-bearer', 'person@example.test',
                      '123-45-6789', '4111 1111 1111 1111', 'fixture-key'):
            self.assertNotIn(value, result)
        self.assertIn('[redacted', result)

    def test_ordinary_project_facts_are_preserved(self):
        raw = 'Launch on 2026-11-01; owner Alice. Budget approved.'
        self.assertEqual(memory.sanitize_brief(raw), raw)

    def test_expiry_removes_content_and_preserves_revision(self):
        now = datetime.now(timezone.utc)
        result = memory.memory_view({'brief': 'expired facts', 'revision': 3,
                                     'expires_at': (now - timedelta(seconds=1)).isoformat()}, now)
        self.assertEqual(result['brief'], '')
        self.assertTrue(result['expired'])
        self.assertEqual(result['revision'], 3)

    def test_missing_invalid_and_naive_expiry_require_renewal(self):
        for expiry in (None, 'invalid', '2026-10-24T12:00:00'):
            view = memory.memory_view({'brief': 'owner can review this', 'expires_at': expiry})
            self.assertTrue(view['needs_renewal'])
            self.assertEqual(view['brief'], 'owner can review this')

    def test_save_sanitizes_before_database_write_and_sets_expiry(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = (1,)
        adapter = MagicMock()
        adapter.return_value.__enter__.return_value = db
        update = SimpleNamespace(brief='password=fixture-password', revision=2, expires_in_days=7)
        with patch.object(memory, 'read_memory'), patch.object(memory, 'database', adapter):
            result = memory.save_memory('alice', 'project', update)
        encoded = db.execute.call_args.args[1][0]
        self.assertNotIn('fixture-password', encoded)
        self.assertIn('expires_at', encoded)
        self.assertFalse(result['needs_renewal'])
        self.assertEqual(result['revision'], 3)

    def test_read_purges_expired_content_under_owner_lock(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = ({'brief': 'expired content', 'revision': 4,
            'expires_at': (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()},)
        adapter = MagicMock()
        adapter.return_value.__enter__.return_value = db
        with patch.object(memory, 'database', adapter):
            result = memory.read_memory('alice', 'project')
        self.assertEqual(result['brief'], '')
        self.assertEqual(result['revision'], 5)
        select = db.execute.call_args_list[1]
        self.assertIn('FOR UPDATE', select.args[0])
        self.assertEqual(select.args[1], ('project', 'alice'))
        write = db.execute.call_args_list[2]
        self.assertNotIn('expired content', write.args[1][0])

    def test_read_cleanup_does_not_resign_tampered_content(self):
        db = MagicMock()
        record = {**self.signed(), 'brief': 'api_key=fixture-compromised'}
        db.execute.return_value.fetchone.return_value = (record,)
        adapter = MagicMock()
        adapter.return_value.__enter__.return_value = db
        with patch.object(memory, 'database', adapter):
            view = memory.read_memory('alice', 'project')
        self.assertTrue(view['needs_renewal'])
        self.assertNotIn('fixture-compromised', view['brief'])
        import json
        stored = json.loads(db.execute.call_args.args[1][0])
        self.assertNotIn('signature', stored)

    def test_legacy_brief_never_enters_model_context_without_renewal(self):
        sessions = ModuleType('app.sessions')
        sessions.get_session = lambda *args: {'project_id': 'project'}
        with patch.dict('sys.modules', {'app.sessions': sessions}), \
                patch.object(memory, 'read_memory', return_value={'brief': 'legacy instructions', 'needs_renewal': True}):
            self.assertEqual(memory.context_for_session('alice', 'chat'), '')


if __name__ == '__main__':
    unittest.main()
