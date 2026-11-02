"""Run only against a disposable PostgreSQL fixture."""
from contextlib import contextmanager
import os
import psycopg
import pytest
from app import buddy_profiles as profiles


@pytest.fixture
def isolated_db(monkeypatch):
    dsn = os.environ.get('BUDDY_PROFILE_TEST_DSN')
    if not dsn:
        pytest.skip('Disposable profile test database not configured')
    @contextmanager
    def connect():
        with psycopg.connect(dsn) as conn:
            yield conn
    monkeypatch.setattr(profiles, '_connect', connect)
    monkeypatch.setenv('BUDDY_MEMORY_SIGNING_KEY', 'fixture-encryption-key-' * 3)
    monkeypatch.delenv('BUDDY_CP4D_ENCRYPTION_KEY', raising=False)
    with connect() as db:
        db.execute('DROP TABLE IF EXISTS buddy_active_model_profile, buddy_model_profiles, bob_access_audit CASCADE')
        db.execute('CREATE TABLE bob_access_audit(actor TEXT, action TEXT, target TEXT, details JSONB)')
    yield connect


def test_profile_storage_and_default_switch(isolated_db):
    user = {'username': 'fixture-admin'}
    assert profiles.active_profile() == {'id': 'bob', 'provider': 'bob'}
    assert profiles.list_profiles(user)['enabled'] is False
    profile = profiles.create_profile(profiles.Profile(name='Fixture', provider='openai', model='fixture-model', api_key='fixture-provider-key'), user)
    assert profile['credentials_configured']
    assert 'fixture-provider-key' not in str(profile)
    with isolated_db() as db:
        encrypted = db.execute('SELECT credentials FROM buddy_model_profiles WHERE id=%s', (profile['id'],)).fetchone()[0]
        assert 'fixture-provider-key' not in encrypted
    with pytest.raises(profiles.HTTPException) as exc:
        profiles.select_profile(profiles.RuntimeSelection(enabled=True, profile_id=profile['id']), user)
    assert exc.value.status_code == 409
    assert profiles.active_profile() == {'id': 'bob', 'provider': 'bob'}
    profiles.select_profile(profiles.RuntimeSelection(enabled=False), user)
    assert profiles.active_profile() == {'id': 'bob', 'provider': 'bob'}
    assert profiles.delete_profile(profile['id'], user) == {'deleted': True}
