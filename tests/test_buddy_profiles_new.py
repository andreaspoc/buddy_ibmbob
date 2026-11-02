import pytest
from pydantic import ValidationError
from app.buddy_profiles import Profile, decrypt_credentials, public_profile
from app.bob_key_settings import _cipher


def test_profile_requires_endpoint_and_project():
    with pytest.raises(ValidationError):
        Profile(name='Custom', provider='openai_compatible', model='model')
    with pytest.raises(ValidationError):
        Profile(name='Watsonx', provider='watsonx', model='model', endpoint='https://example.com')
    with pytest.raises(ValidationError):
        Profile(name='Azure', provider='azure', model='model', endpoint='https://user:password@example.com')


def test_credentials_are_encrypted_and_not_public(monkeypatch):
    monkeypatch.setenv('BUDDY_MEMORY_SIGNING_KEY', 'a' * 40)
    monkeypatch.delenv('BUDDY_CP4D_ENCRYPTION_KEY', raising=False)
    encoded = _cipher().encrypt(b'{"api_key":"example-secret"}').decode()
    assert 'example-secret' not in encoded
    assert decrypt_credentials(encoded) == {'api_key': 'example-secret'}
    public = public_profile('id', {'provider': 'openai'}, encoded)
    assert 'example-secret' not in str(public) and encoded not in str(public)


def test_default_runtime_is_bob_when_disabled_or_unconfigured(monkeypatch):
    from contextlib import contextmanager
    from app import buddy_profiles

    class Result:
        def fetchone(self):
            return None
    class Database:
        def execute(self, query, *args):
            return Result()
    @contextmanager
    def connect():
        yield Database()
    monkeypatch.setattr(buddy_profiles, '_connect', connect)
    assert buddy_profiles.active_profile() == {'id': 'bob', 'provider': 'bob'}


def test_selection_defaults_to_bob_and_disabled():
    from app.buddy_profiles import RuntimeSelection
    selection = RuntimeSelection()
    assert not selection.enabled
    assert selection.profile_id == 'bob'
