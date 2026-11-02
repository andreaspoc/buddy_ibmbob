import asyncio

import pytest
from cryptography.fernet import InvalidToken
from pydantic import ValidationError

from app import bob_key_settings as settings


def test_encryption_is_independent_and_key_is_validated(monkeypatch):
    monkeypatch.setenv('BUDDY_MEMORY_SIGNING_KEY', 'a' * 40)
    monkeypatch.delenv('BUDDY_CP4D_ENCRYPTION_KEY', raising=False)
    cipher = settings._cipher()
    token = cipher.encrypt(b'example-provider-key')
    assert b'example-provider-key' not in token
    assert cipher.decrypt(token) == b'example-provider-key'
    monkeypatch.setenv('BUDDY_MEMORY_SIGNING_KEY', 'b' * 40)
    with pytest.raises(InvalidToken):
        settings._cipher().decrypt(token)
    with pytest.raises(ValidationError):
        settings.KeyInput(api_key='bad\nkey')


def test_saved_key_precedes_environment_and_falls_back(monkeypatch):
    monkeypatch.setenv('BOB_API_KEY', 'compose-key')
    monkeypatch.setattr(settings, 'saved_key', lambda: 'ui-key')
    assert settings.effective_key() == 'ui-key'
    monkeypatch.setattr(settings, 'saved_key', lambda: '')
    assert settings.effective_key() == 'compose-key'


def test_runtime_passes_saved_key_to_both_aliases(monkeypatch):
    from app.acp_bridge import approval_child_environment
    monkeypatch.setattr(settings, 'effective_key', lambda: 'ui-key')
    monkeypatch.delenv('BOB_TEAM_ID', raising=False)
    async def check():
        async with approval_child_environment('/tmp', '/tmp/socket') as env:
            assert env['BOB_API_KEY'] == env['BOBSHELL_API_KEY'] == 'ui-key'
    asyncio.run(check())
