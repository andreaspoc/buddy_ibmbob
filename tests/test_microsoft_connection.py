"""Microsoft connects Office only, with one-time state bound to the app session."""
import asyncio
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request
from app import microsoft_auth as ms


class StateDB:
    def __init__(self):
        self.rows = {}
        self.result = None

    def execute(self, sql, params=()):
        self.result = None
        if sql.startswith("INSERT"):
            self.rows[params[0]] = params[1:]
        elif "RETURNING username" in sql:
            digest, username, session, nonce, now = params
            row = self.rows.get(digest)
            if row and row[:3] == (username, session, nonce) and row[3] > now:
                del self.rows[digest]
                self.result = (username,)
        return self

    def fetchone(self):
        return self.result


@contextmanager
def state_connection():
    yield state_connection.db


def test_state_is_session_bound_and_single_use():
    state_connection.db = StateDB()
    with patch.object(ms, "_connect", state_connection):
        first = ms._create_state("alice", "session-a", "nonce-a")
        second = ms._create_state("alice", "session-a", "nonce-a")
        assert first != second
        assert not ms._verify_state(first, "bob", "session-a", "nonce-a")
        assert not ms._verify_state(first, "alice", "session-b", "nonce-a")
        assert not ms._verify_state(first, "alice", "session-a", "wrong")
        assert ms._verify_state(first, "alice", "session-a", "nonce-a")
        assert not ms._verify_state(first, "alice", "session-a", "nonce-a")
        with patch.object(ms.time, "time", return_value=10**12):
            assert not ms._verify_state(second, "alice", "session-a", "nonce-a")


def request():
    return Request({"type": "http", "method": "GET", "path": "/", "scheme": "http", "server": ("localhost", 3000), "headers": []})


def test_login_and_callback_require_existing_login():
    with patch.object(ms, "current_user", AsyncMock(side_effect=HTTPException(401, "Sign in required"))):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(ms.microsoft_login(request(), False))
        assert exc.value.status_code == 401
        with pytest.raises(HTTPException) as exc:
            asyncio.run(ms.microsoft_callback(request(), Response(), code="code", state="state"))
        assert exc.value.status_code == 401


def test_callback_rejects_state_before_contacting_microsoft():
    with patch.object(ms, "current_user", AsyncMock(return_value={"username": "alice"})), \
         patch.object(ms.httpx, "AsyncClient") as client:
        result = asyncio.run(ms.microsoft_callback(request(), Response(), code="code", state="state"))
        assert "Invalid" in result.headers["location"]
        client.assert_not_called()


def test_callback_connects_only_current_user_without_setting_session():
    from pathlib import Path
    client = AsyncMock()
    token_response = __import__('unittest.mock', fromlist=['Mock']).Mock()
    token_response.status_code = 200
    token_response.json.return_value = {"access_token": "graph-token", "refresh_token": "refresh", "expires_in": 3600}
    profile_response = __import__('unittest.mock', fromlist=['Mock']).Mock()
    profile_response.status_code = 200
    profile_response.json.return_value = {"mail": "office@example.com", "displayName": "Office User"}
    client.post.return_value = token_response
    client.get.return_value = profile_response
    client.__aenter__.return_value = client
    response = Response()
    with patch.object(ms, "current_user", AsyncMock(return_value={"username": "alice"})), \
         patch.object(ms, "_verify_state", return_value=True), \
         patch.object(ms.httpx, "AsyncClient", return_value=client), \
         patch.object(ms, "_user_token_file", return_value=Path("/tmp/alice-microsoft.json")), \
         patch.object(ms.storage, "write_user_file") as write, \
         patch.object(ms, "user_root", return_value=Path("/tmp/alice")), \
         patch.object(ms, "select_root"), patch.object(ms, "ensure_microsoft_mcp"):
        result = asyncio.run(ms.microsoft_callback(request(), response, code="code", state="state", error=None))
        assert result.headers["location"] == "/?microsoft=connected"
        write.assert_called_once()
        assert ms.COOKIE not in result.headers.get("set-cookie", "")
        assert "graph-token" in write.call_args.args[1].decode()
