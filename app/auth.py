"""Local username/password accounts with server-side session cookies."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import time
import threading
from contextlib import contextmanager

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import HTTPException, Request, Response
import psycopg
from psycopg.errors import UniqueViolation


COOKIE = "bob_ui_session"
USER_RE = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
GROUP_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)


_schema_lock = threading.Lock()
_initialized_databases: set[str] = set()


@contextmanager
def _connect():
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        database_url = os.environ["DATABASE_URL"]
        with _schema_lock:
            if database_url not in _initialized_databases:
                connection.execute("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, is_admin BOOLEAN NOT NULL)")
                connection.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), expires BIGINT NOT NULL)")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_user_profiles (username TEXT PRIMARY KEY REFERENCES users(username), display_name TEXT NOT NULL)")
                connection.execute("ALTER TABLE bob_user_profiles ADD COLUMN IF NOT EXISTS email TEXT")
                connection.execute("ALTER TABLE bob_user_profiles ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_user_appearance (username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, settings JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_admin_email_grants (email TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_access_audit (id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now())")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_auth_migrations (name TEXT PRIMARY KEY)")
                connection.execute("CREATE TABLE IF NOT EXISTS bob_instance_brand (id INTEGER PRIMARY KEY CHECK (id=1), name TEXT NOT NULL, organization TEXT NOT NULL DEFAULT '', logo BYTEA, logo_media_type TEXT, logo_version INTEGER NOT NULL DEFAULT 0, setup_complete BOOLEAN NOT NULL DEFAULT FALSE, provider_choice TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())")
                from app.access_migration import migrate_fixed_groups
                from app.app_groups import schema as app_groups_schema
                app_groups_schema(connection)
                migrate_fixed_groups(connection)
                # An installation that already has users is not a first run, so it never sees the wizard.
                connection.execute("INSERT INTO bob_instance_brand (id,name,organization,setup_complete) SELECT 1,%s,%s,EXISTS(SELECT 1 FROM users) ON CONFLICT DO NOTHING",
                                    (os.getenv('BUDDY_NAME', '').strip() or 'Buddy', os.getenv('BUDDY_ORGANIZATION', '').strip()))
                seeded = connection.execute("INSERT INTO bob_auth_migrations VALUES ('initial-administrator-email') ON CONFLICT DO NOTHING RETURNING name").fetchone()
                if seeded:
                    initial_admin = os.getenv('BUDDY_INITIAL_ADMIN_EMAIL', '').strip().lower()
                    if initial_admin:
                        connection.execute("INSERT INTO bob_admin_email_grants(email,created_by) VALUES (%s,'bootstrap') ON CONFLICT DO NOTHING", (initial_admin,))
                connection.commit()
                _initialized_databases.add(database_url)
        yield connection


def has_users() -> bool:
    with _connect() as db:
        return db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None


def create_user(username: str, password: str, admin: bool = False, setup: bool = False) -> dict:
    username = username.strip().lower()
    if not USER_RE.fullmatch(username):
        raise ValueError("Username must have 3–64 lowercase letters, numbers, or hyphens and start with a letter")
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters")
    with _connect() as db:
        if setup and db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            raise ValueError("Setup is already complete")
        try:
            db.execute("INSERT INTO users VALUES (%s, %s, %s)", (username, _hasher.hash(password), admin))
        except UniqueViolation as exc:
            raise ValueError("Username already exists") from exc
    return {"username": username, "is_admin": admin}


def authenticate(username: str, password: str) -> dict | None:
    with _connect() as db:
        row = db.execute("SELECT username, password_hash, is_admin FROM users WHERE username = %s", (username.strip().lower(),)).fetchone()
    if not row:
        return None
    try:
        _hasher.verify(row[1], password)
    except VerifyMismatchError:
        return None
    return {"username": row[0], "is_admin": bool(row[2])}


def start_session(response: Response, user: dict, request: Request) -> None:
    token = secrets.token_urlsafe(32)
    with _connect() as db:
        db.execute("INSERT INTO sessions VALUES (%s, %s, %s)", (hashlib.sha256(token.encode()).hexdigest(), user["username"], int(time.time()) + 7 * 86400))
    secure = request.url.scheme == "https" or os.getenv("BOB_UI_SECURE_COOKIE") == "1"
    response.set_cookie(COOKIE, token, httponly=True, secure=secure, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"


def _user_groups(db, username: str) -> list[dict]:
    rows = db.execute("SELECT g.id,g.name FROM bob_app_group_members m JOIN bob_app_groups g ON g.id=m.group_id WHERE m.username=%s ORDER BY lower(g.name)", (username,)).fetchall()
    return [{"id": str(row[0]), "name": row[1]} for row in rows]


def user_profile(username: str, is_admin: bool) -> dict:
    with _connect() as db:
        row = db.execute("SELECT display_name,email FROM bob_user_profiles WHERE username=%s", (username,)).fetchone()
        groups = _user_groups(db, username)
    return {"username": username, "is_admin": is_admin, "display_name": row[0] if row else username, "email": row[1] if row else None, "groups": groups}


def extract_session_token(request: Request) -> str | None:
    token = request.cookies.get(COOKIE)
    auth_header = request.headers.get("Authorization", "")
    api_key_header = request.headers.get("X-API-Key") or request.headers.get("x-api-key")
    if not token and auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    elif not token and api_key_header:
        token = api_key_header.strip()
    return token


async def current_user(request: Request) -> dict:
    cached = request.scope.get('state', {}).get('boundary_user')
    if cached:
        return cached
    token = extract_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in required")
    with _connect() as db:
        row = db.execute(
            "SELECT users.username, users.is_admin FROM sessions JOIN users ON users.username = sessions.username WHERE token_hash = %s AND expires > %s",
            (hashlib.sha256(token.encode()).hexdigest(), int(time.time())),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Sign in required")
    from app.sessions import user_root
    from app.workspace_config import select_root
    select_root(user_root(row[0], create=True))
    return user_profile(row[0], bool(row[1]))


def end_session(request: Request, response: Response) -> None:
    token = extract_session_token(request)
    if token:
        with _connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = %s", (hashlib.sha256(token.encode()).hexdigest(),))
    response.delete_cookie(COOKIE, path="/")


def list_users() -> list[dict]:
    with _connect() as db:
        rows = db.execute("SELECT u.username,u.is_admin,p.display_name,p.email FROM users u LEFT JOIN bob_user_profiles p ON p.username=u.username ORDER BY u.username").fetchall()
        members = db.execute("SELECT m.username,g.id,g.name FROM bob_app_group_members m JOIN bob_app_groups g ON g.id=m.group_id ORDER BY lower(g.name)").fetchall()
    groups: dict[str, list[dict]] = {}
    for username, identity, name in members:
        groups.setdefault(username, []).append({"id": str(identity), "name": name})
    return [{"username": row[0], "is_admin": bool(row[1]), "display_name": row[2] or row[0], "email": row[3], "groups": groups.get(row[0], [])} for row in rows]


def knowledge_access(username: str) -> dict | None:
    """Read current assignments from storage; unknown accounts receive no access."""
    with _connect() as db:
        row = db.execute("SELECT is_admin FROM users WHERE username=%s", (username,)).fetchone()
        if not row:
            return None
        return {"is_admin": bool(row[0]), "groups": [group["id"] for group in _user_groups(db, username)]}


def user_group_names(username: str) -> set[str]:
    """Names for deployment settings that refer to groups by name; compared in lower case."""
    with _connect() as db:
        return {group["name"].lower() for group in _user_groups(db, username)}


def valid_audience(value) -> bool:
    """'both' means everyone; anything else must be a group that exists right now."""
    if value == "both":
        return True
    if not isinstance(value, str) or not GROUP_ID_RE.fullmatch(value):
        return False
    with _connect() as db:
        return db.execute("SELECT 1 FROM bob_app_groups WHERE id=%s", (value,)).fetchone() is not None