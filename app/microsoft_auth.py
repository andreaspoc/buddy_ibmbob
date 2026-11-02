"""Microsoft OAuth 2.0 authentication endpoints for connecting Microsoft 365 to an existing account."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from app import postgres_storage as storage
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

from app.auth import COOKIE, _connect, current_user
from starlette.concurrency import run_in_threadpool
from app.sessions import user_root
from app.workspace_config import ensure_microsoft_mcp, remove_microsoft_mcp, select_root
from app.business_connectors import BUSINESS_SCOPES

router = APIRouter(prefix="/auth/microsoft", tags=["microsoft"])

STATE_COOKIE = "bob_microsoft_oauth"
DEFAULT_SCOPES = [
    "offline_access",
    "User.Read",
    "Mail.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
    "MailboxFolder.Read",
    "MailboxFolder.ReadWrite",
    "MailboxSettings.Read",
    "Files.ReadWrite",
]


def _get_scopes(include_business: bool = False) -> str:
    raw = os.getenv("GRAPH_SCOPES", "").strip()
    scopes = [s.strip() for s in raw.replace(',', ' ').split() if s.strip()] if raw else list(DEFAULT_SCOPES)
    if include_business:
        scopes.extend(BUSINESS_SCOPES)
    return ' '.join(dict.fromkeys(scopes))


def _get_client_id() -> str:
    return os.getenv("AZURE_CLIENT_ID", "").strip()


def _get_client_secret() -> str:
    return os.getenv("AZURE_CLIENT_SECRET", "").strip()


def _get_tenant_id() -> str:
    return os.getenv("AZURE_TENANT_ID", "common").strip() or "common"


def _get_redirect_uri(request: Request) -> str:
    override = os.getenv("AZURE_REDIRECT_URI", "").strip()
    if override:
        return override
    forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost:3000"))
    return f"{forwarded_proto}://{host}/auth/microsoft/callback"


def _user_token_file(username: str) -> Path:
    token_dir = user_root(username, create=True) / ".home" / ".bob" / "tokens"
    return token_dir / "microsoft.json"


def _state_table(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS microsoft_oauth_states (
        state_hash TEXT PRIMARY KEY, username TEXT NOT NULL,
        session_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires BIGINT NOT NULL
    )""")


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _create_state(username: str, session: str, nonce: str) -> str:
    state = secrets.token_urlsafe(32)
    with _connect() as db:
        _state_table(db)
        db.execute("DELETE FROM microsoft_oauth_states WHERE expires <= %s", (int(time.time()),))
        db.execute("INSERT INTO microsoft_oauth_states VALUES (%s, %s, %s, %s, %s)",
                   (_digest(state), username, _digest(session), _digest(nonce), int(time.time()) + 900))
    return state


def _verify_state(state: str, username: str, session: str, nonce: str) -> bool:
    if not session or not nonce:
        return False
    with _connect() as db:
        _state_table(db)
        row = db.execute("""DELETE FROM microsoft_oauth_states
            WHERE state_hash = %s AND username = %s AND session_hash = %s
            AND nonce_hash = %s AND expires > %s RETURNING username""",
            (_digest(state), username, _digest(session), _digest(nonce), int(time.time()))).fetchone()
    return row is not None


@router.get("/status")
async def microsoft_status(request: Request) -> dict[str, Any]:
    """Check Microsoft 365 connection status for the signed-in user."""
    client_id = _get_client_id()
    try:
        user = await current_user(request)
    except HTTPException:
        return {
            "configured": bool(client_id),
            "connected": False,
            "account": None,
            "name": None,
            "signed_in": False,
        }

    token_file = _user_token_file(user["username"])
    content = await run_in_threadpool(storage.read_user_file, token_file)
    if content is None:
        return {
            "configured": bool(client_id),
            "connected": False,
            "account": None,
            "name": None,
            "signed_in": True,
        }

    try:
        data = json.loads(content)
        return {
            "configured": bool(client_id),
            "connected": bool(data.get("access_token")),
            "account": data.get("account"),
            "name": data.get("name"),
            "signed_in": True,
            "scopes": [scope.rsplit('/', 1)[-1] for scope in data.get('scope', '').split()],
            "missing_scopes": [scope for scope in BUSINESS_SCOPES if scope not in
                               [granted.rsplit('/', 1)[-1] for granted in data.get('scope', '').split()]],
        }
    except Exception:
        return {
            "configured": bool(client_id),
            "connected": False,
            "account": None,
            "name": None,
            "signed_in": True,
        }


@router.get("/login")
async def microsoft_login(request: Request, business: bool = Query(False)):
    """Connect Office for the current signed-in browser session."""
    user = await current_user(request)
    session = request.cookies.get(COOKIE)
    if not session:
        raise HTTPException(status_code=401, detail="Sign in using the browser before connecting Microsoft")
    client_id = _get_client_id()
    if not client_id:
        return HTMLResponse(
            content="""
            <html>
              <head><title>Microsoft Integration Not Configured</title></head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0c1b; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px;">
                <div style="background: #1e1933; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; max-width: 520px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                  <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                    <svg width="24" height="24" viewBox="0 0 21 21">
                      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                    </svg>
                    <h2 style="margin: 0; font-size: 20px; color: #fff;">Microsoft Integration Setup Required</h2>
                  </div>
                  <p style="color: #cbd5e1; font-size: 14px; line-height: 1.6;">
                    To enable Microsoft Office tools, configure your Microsoft Entra ID (Azure Portal) application details:
                  </p>
                  <pre style="background: #120e22; padding: 12px; border-radius: 6px; font-size: 13px; color: #a5b4fc; overflow-x: auto;">
AZURE_CLIENT_ID="your-client-id-here"
AZURE_CLIENT_SECRET="your-client-secret-here"
AZURE_TENANT_ID="common"</pre>
                  <p style="color: #94a3b8; font-size: 13px; line-height: 1.5;">
                    Add these variables to your <code>.env</code> file beside <code>docker-compose.yml</code> and restart the service.
                  </p>
                  <a href="/" style="display: inline-block; margin-top: 10px; padding: 10px 18px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 13px;">Return to Workspace</a>
                </div>
              </body>
            </html>
            """,
            status_code=503,
        )

    nonce = secrets.token_urlsafe(32)
    state = _create_state(user["username"], session, nonce)

    tenant = _get_tenant_id()
    redirect_uri = _get_redirect_uri(request)

    auth_params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": _get_scopes(include_business=business),
        "state": state,
        "prompt": "select_account",
    }
    auth_url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?{urlencode(auth_params)}"
    redirect = RedirectResponse(auth_url, status_code=302)
    secure = request.url.scheme == "https" or os.getenv("BOB_UI_SECURE_COOKIE") == "1"
    redirect.set_cookie(STATE_COOKIE, nonce, httponly=True, secure=secure,
                        samesite="lax", max_age=900, path="/auth/microsoft")
    redirect.headers["Cache-Control"] = "no-store"
    return redirect


@router.get("/callback")
async def microsoft_callback(
    request: Request,
    response: Response,
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
):
    """Attach Office tokens to the initiating account; never sign a user in."""
    user = await current_user(request)
    session = request.cookies.get(COOKIE, "")
    nonce = request.cookies.get(STATE_COOKIE, "")
    if not state or not _verify_state(state, user["username"], session, nonce):
        return RedirectResponse("/?microsoft_error=Invalid+or+expired+session+state")
    if error:
        detail = error_description or error or "Microsoft authorization was declined."
        return RedirectResponse("/?" + urlencode({"microsoft_error": detail}))
    if not code:
        return RedirectResponse("/?microsoft_error=Missing+authorization+code")

    client_id = _get_client_id()
    client_secret = _get_client_secret()
    tenant = _get_tenant_id()
    redirect_uri = _get_redirect_uri(request)

    token_url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    token_payload = {
        "client_id": client_id,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }
    if client_secret:
        token_payload["client_secret"] = client_secret

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(token_url, data=token_payload)
            if resp.status_code != 200:
                err_json = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                err_msg = err_json.get("error_description", f"Token request failed with status {resp.status_code}")
                return RedirectResponse("/?" + urlencode({"microsoft_error": err_msg}))

            token_data = resp.json()
            access_token = token_data.get("access_token")
            if not access_token:
                return RedirectResponse("/?microsoft_error=Microsoft+did+not+return+an+access+token")
            refresh_token = token_data.get("refresh_token")
            expires_in = token_data.get("expires_in", 3600)

            # Retrieve user profile from Microsoft Graph
            graph_resp = await client.get(
                "https://graph.microsoft.com/v1.0/me",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            profile = graph_resp.json() if graph_resp.status_code == 200 else {}
            account_email = profile.get("mail") or profile.get("userPrincipalName") or ""
            display_name = profile.get("displayName") or ""

    except Exception as exc:
        return RedirectResponse("/?" + urlencode({"microsoft_error": str(exc)}))

    username = user["username"]

    # Store token in user's isolated workspace
    user_tokens = _user_token_file(username)
    payload_to_store = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": time.time() + expires_in - 60,
        "account": account_email,
        "name": display_name,
        "client_id": client_id,
        "tenant_id": tenant,
        "scope": token_data.get('scope', ''),
    }
    storage.write_user_file(user_tokens, json.dumps(payload_to_store).encode("utf-8"))

    # Automatically register the Microsoft MCP server for Bob
    select_root(user_root(username, create=True))
    ensure_microsoft_mcp()

    redirect = RedirectResponse("/?microsoft=connected", status_code=302)
    redirect.delete_cookie(STATE_COOKIE, path="/auth/microsoft")
    redirect.headers["Cache-Control"] = "no-store"
    return redirect


@router.post("/disconnect")
async def microsoft_disconnect(request: Request) -> dict[str, bool]:
    """Disconnect Microsoft account and remove token."""
    user = await current_user(request)
    username = user["username"]
    token_file = _user_token_file(username)
    storage.remove_user_file(token_file)

    select_root(user_root(username, create=True))
    remove_microsoft_mcp()
    return {"success": True}
