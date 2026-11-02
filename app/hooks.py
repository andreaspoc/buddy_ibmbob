"""Buddy Lifecycle Hooks Engine & Management."""

from __future__ import annotations

import os
import re
import json
import uuid
import asyncio
import logging
import signal
from pathlib import Path
from typing import Any


def validate_hook_id(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) is None:
        raise ValueError("Hook ID must contain 1–80 letters, numbers, underscores or hyphens")
    return value


def record_hook_audit(user: Any, action: str, hook_id: str) -> None:
    """Scripts, commands, and credentials must never enter audit records."""
    user_id = (user.get("username") or user.get("id")) if isinstance(user, dict) else getattr(user, "id", None)
    logging.getLogger("security.hooks").info(
        "hook_mutation user_id=%r action=%r hook_id=%r", user_id, action, hook_id
    )
    # Authenticated API calls initialize bob_access_audit before reaching hooks.
    # Keep the administrative change visible in the existing audit history.
    with _connect_db() as conn:
        if conn is not None:
            conn.execute(
                "INSERT INTO bob_access_audit(actor,action,target) VALUES (%s,%s,%s)",
                (str(user_id), action, hook_id),
            )


def _safe_script_path(directory: Path, hook_id: str) -> Path:
    validate_hook_id(hook_id)
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError("Hook directory must not be a symbolic link")
    target = directory / f"{hook_id}.sh"
    if target.is_symlink() or target.resolve().parent != directory.resolve():
        raise ValueError("Hook path escapes its managed directory")
    return target


def _write_script(directory: Path, hook_id: str, content: str) -> None:
    target = _safe_script_path(directory, hook_id)
    directory.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o700)
        stream.write(content)


BUILTIN_HOOK_TEMPLATES = [
    {
        "id": "tpl-guard-destructive-commands",
        "name": "Guard Destructive Commands",
        "description": "Blocks rm -rf, mkfs, drop table/database, and git push --force commands before execution.",
        "event": "PreToolUse",
        "matcher": "^(run_command|execute_bash|bash|sh)$",
        "timeout": 5000,
        "is_blocking": True,
        "script_code": """#!/bin/bash
PAYLOAD=$(cat)
CMD=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('command', '') or data.get('tool_input', {}).get('CommandLine', ''))")

if echo "$CMD" | grep -Ei "(rm\\s+-[a-zA-Z]*r[a-zA-Z]*f|mkfs|drop\\s+database|drop\\s+table|git\\s+push\\s+.*--force)" > /dev/null; then
  echo "BLOCKED: Destructive command detected in tool input: $CMD" >&2
  exit 2
fi
exit 0
""",
    },
    {
        "id": "tpl-protect-sensitive-files",
        "name": "Protect Sensitive & Config Files",
        "description": "Prevents file write/edit actions targeting .env, .git/, id_rsa, and production configs.",
        "event": "PreToolUse",
        "matcher": "^(write_file|save_session_file|write_to_file|edit_file)$",
        "timeout": 5000,
        "is_blocking": True,
        "script_code": """#!/bin/bash
PAYLOAD=$(cat)
PATH_ARG=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('path', '') or data.get('tool_input', {}).get('TargetFile', ''))")

if echo "$PATH_ARG" | grep -Ei "(\\.env|\\.git/|id_rsa|\\.pem|credentials|production\\.json)$" > /dev/null; then
  echo "BLOCKED: Modifying sensitive or secret file '$PATH_ARG' is forbidden by workspace policy." >&2
  exit 2
fi
exit 0
""",
    },
    {
        "id": "tpl-scan-prompt-pii",
        "name": "Prompt Credentials & Secret Scanner",
        "description": "Scans prompts for accidentally pasted OpenAI/AWS keys or passwords before sending to model.",
        "event": "UserPromptSubmit",
        "matcher": ".*",
        "timeout": 5000,
        "is_blocking": True,
        "script_code": """#!/bin/bash
PAYLOAD=$(cat)
PROMPT=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('prompt', ''))")

if echo "$PROMPT" | grep -Ei "(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|password\\s*=\\s*['\\\"][^'\\\"]+)" > /dev/null; then
  echo "BLOCKED: Prompt contains potential hardcoded API credentials or secret token. Please remove secrets before submitting." >&2
  exit 2
fi
exit 0
""",
    },
    {
        "id": "tpl-auto-format-python",
        "name": "Auto-Format Python Files",
        "description": "Automatically runs formatting tools after Python file modifications.",
        "event": "PostToolUse",
        "matcher": "^(write_file|save_session_file|write_to_file)$",
        "timeout": 8000,
        "is_blocking": False,
        "script_code": """#!/bin/bash
PAYLOAD=$(cat)
FILE=$(echo "$PAYLOAD" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('tool_input', {}).get('path', '') or data.get('tool_input', {}).get('TargetFile', ''))")

if [[ "$FILE" == *.py ]] && [ -f "$FILE" ]; then
  python3 -m ruff format "$FILE" 2>/dev/null || python3 -m black "$FILE" 2>/dev/null || true
  echo "Formatted Python file: $FILE"
fi
exit 0
""",
    },
    {
        "id": "tpl-git-branch-context",
        "name": "Inject Git Branch & Status Context",
        "description": "Detects Git workspace branch and dirty file status to provide situational context.",
        "event": "SessionStart",
        "matcher": ".*",
        "timeout": 4000,
        "is_blocking": False,
        "script_code": """#!/bin/bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  STATUS=$(git status --short 2>/dev/null | head -n 5)
  echo "Active Git Branch: $BRANCH"
  if [ -n "$STATUS" ]; then
    echo "Pending changes:"
    echo "$STATUS"
  fi
fi
exit 0
""",
    },
]


import time
from contextlib import contextmanager, ExitStack

try:
    import psycopg
except ImportError:
    psycopg = None  # type: ignore


@contextmanager
def _connect_db():
    """Connect to PostgreSQL if DATABASE_URL is available; yields None otherwise."""
    db_url = os.getenv("DATABASE_URL")
    if not db_url or psycopg is None:
        yield None
        return
    with ExitStack() as stack:
        try:
            conn = stack.enter_context(psycopg.connect(db_url, autocommit=True))
            conn.execute("""
                    CREATE TABLE IF NOT EXISTS bob_lifecycle_hooks (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        description TEXT NOT NULL DEFAULT '',
                        event TEXT NOT NULL,
                        matcher TEXT NOT NULL DEFAULT '.*',
                        command TEXT NOT NULL DEFAULT '',
                        script_code TEXT NOT NULL DEFAULT '',
                        timeout INTEGER NOT NULL DEFAULT 5000,
                        enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        is_blocking BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at BIGINT NOT NULL,
                        updated_at BIGINT NOT NULL
                    )
            """)
        except Exception:
            yield None
            return
        yield conn


def _get_global_settings_path() -> Path | None:
    """Find Buddy's global settings file if configured (~/.bob/settings/settings.json)."""
    home = Path(os.getenv("HOME", "/root"))
    global_path = home / ".bob" / "settings" / "settings.json"
    if global_path.parent.is_dir() or (home / ".bob").is_dir():
        return global_path
    return None


def _get_global_hooks_dir() -> Path | None:
    home = Path(os.getenv("HOME", "/root"))
    if (home / ".bob").is_dir():
        return home / ".bob" / "hooks"
    return None


def _get_workspace_root(workspace_root: Path | None = None) -> Path:
    if workspace_root:
        return Path(workspace_root)
    return Path(os.getenv("BOB_WORKSPACE", os.getcwd()))


def _settings_path(workspace_root: Path | None = None) -> Path:
    return _get_workspace_root(workspace_root) / ".bob" / "settings.json"


def _hooks_dir(workspace_root: Path | None = None) -> Path:
    return _get_workspace_root(workspace_root) / ".bob" / "hooks"


def _write_disk_settings(config: dict[str, Any], workspace_root: Path | None = None) -> None:
    """Write settings.json to workspace and sync to global settings if available."""
    # 1. Workspace settings.json
    path = _settings_path(workspace_root)
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Hook settings must not use symbolic links")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    # 2. Global settings (~/.bob/settings/settings.json)
    global_path = _get_global_settings_path()
    if global_path:
        try:
            if global_path.is_symlink() or global_path.parent.is_symlink():
                raise ValueError("Global hook settings must not use symbolic links")
            global_path.parent.mkdir(parents=True, exist_ok=True)
            existing_global = {}
            if global_path.is_file():
                try:
                    existing_global = json.loads(global_path.read_text(encoding="utf-8"))
                except Exception:
                    existing_global = {}
            existing_global["hooks"] = config.get("hooks", {})
            global_path.write_text(json.dumps(existing_global, indent=2), encoding="utf-8")
        except Exception:
            pass


def get_hooks_config(workspace_root: Path | None = None) -> dict[str, Any]:
    """Read .bob/settings.json and return hooks configuration."""
    path = _settings_path(workspace_root)
    if not path.is_file():
        global_path = _get_global_settings_path()
        if global_path and global_path.is_file():
            path = global_path
        else:
            return {"hooks": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"hooks": {}}
        if "hooks" not in data or not isinstance(data["hooks"], dict):
            data["hooks"] = {}
        return data
    except Exception:
        return {"hooks": {}}


def list_hooks(workspace_root: Path | None = None) -> list[dict[str, Any]]:
    """Return all configured hooks from PostgreSQL database with disk sync, falling back to disk."""
    results: list[dict[str, Any]] = []

    # 1. Try reading from PostgreSQL
    with _connect_db() as conn:
        if conn is not None:
            try:
                rows = conn.execute("""
                    SELECT id, name, description, event, matcher, command, script_code, timeout, enabled, is_blocking
                    FROM bob_lifecycle_hooks
                    ORDER BY created_at ASC
                """).fetchall()
                for row in rows:
                    results.append({
                        "id": row[0],
                        "name": row[1],
                        "description": row[2],
                        "event": row[3],
                        "matcher": row[4],
                        "command": row[5],
                        "script_code": row[6],
                        "timeout": row[7],
                        "enabled": bool(row[8]),
                        "is_blocking": bool(row[9]),
                    })
            except Exception:
                pass

    # If DB had hooks, sync them to disk so Bob CLI can execute them
    if results:
        _sync_hooks_to_disk(results, workspace_root)
        return results

    # 2. If DB is empty or unavailable, read from disk
    config = get_hooks_config(workspace_root)
    hooks_map = config.get("hooks", {})

    for event_name, hook_entries in hooks_map.items():
        if not isinstance(hook_entries, list):
            continue
        for entry in hook_entries:
            if not isinstance(entry, dict):
                continue
            hook_id = entry.get("id") or str(uuid.uuid4())
            try:
                validate_hook_id(hook_id)
            except ValueError:
                continue
            name = entry.get("name") or hook_id
            description = entry.get("description", "")
            enabled = entry.get("enabled", True)
            matcher = entry.get("matcher", ".*")
            is_blocking = entry.get("is_blocking", event_name in {"UserPromptSubmit", "PreToolUse"})

            sub_hooks = entry.get("hooks", [])
            first_cmd = sub_hooks[0] if sub_hooks and isinstance(sub_hooks[0], dict) else {}
            command = first_cmd.get("command", "")
            timeout = first_cmd.get("timeout", 5000)

            script_code = ""
            if command.startswith("./.bob/hooks/") or command.startswith(".bob/hooks/"):
                rel_path = command.lstrip("./")
                try:
                    full_script = _safe_script_path(_hooks_dir(workspace_root), hook_id)
                except ValueError:
                    continue
                if rel_path != f"bob/hooks/{hook_id}.sh":
                    continue
                if full_script.is_file():
                    try:
                        script_code = full_script.read_text(encoding="utf-8")
                    except Exception:
                        pass

            item = {
                "id": hook_id,
                "name": name,
                "description": description,
                "event": event_name,
                "matcher": matcher,
                "command": command,
                "script_code": script_code,
                "timeout": timeout,
                "enabled": enabled,
                "is_blocking": is_blocking,
            }
            results.append(item)

    # If disk has hooks but DB was empty, import to DB for persistence
    if results:
        with _connect_db() as conn:
            if conn is not None:
                try:
                    now = int(time.time() * 1000)
                    for h in results:
                        conn.execute("""
                            INSERT INTO bob_lifecycle_hooks
                            (id, name, description, event, matcher, command, script_code, timeout, enabled, is_blocking, created_at, updated_at)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (id) DO NOTHING
                        """, (
                            h["id"], h["name"], h["description"], h["event"], h["matcher"],
                            h["command"], h["script_code"], h["timeout"], h["enabled"],
                            h["is_blocking"], now, now
                        ))
                except Exception:
                    pass

    return results


def _sync_hooks_to_disk(hooks: list[dict[str, Any]], workspace_root: Path | None = None) -> None:
    """Ensure disk files (settings.json & .bob/hooks/*.sh) match hook list."""
    hooks_dir = _hooks_dir(workspace_root)
    hooks_dir.mkdir(parents=True, exist_ok=True)
    global_hooks_dir = _get_global_hooks_dir()
    if global_hooks_dir:
        try:
            global_hooks_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    hooks_map: dict[str, list[dict[str, Any]]] = {}

    for h in hooks:
        hook_id = h["id"]
        try:
            validate_hook_id(hook_id)
        except ValueError:
            continue
        event = h["event"]
        script_code = h.get("script_code", "").strip()
        command = h.get("command", "").strip()

        if script_code:
            script_filename = f"{hook_id}.sh"
            _write_script(hooks_dir, hook_id, script_code)
            if global_hooks_dir:
                _write_script(global_hooks_dir, hook_id, script_code)
            command = f"./.bob/hooks/{script_filename}"

        target_list = hooks_map.setdefault(event, [])
        target_list.append({
            "id": hook_id,
            "name": h["name"],
            "description": h.get("description", ""),
            "matcher": h.get("matcher", ".*"),
            "enabled": h.get("enabled", True),
            "is_blocking": h.get("is_blocking", True),
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": h.get("timeout", 5000),
                }
            ],
        })

    config = get_hooks_config(workspace_root)
    config["hooks"] = hooks_map
    _write_disk_settings(config, workspace_root)


def save_hook(hook_data: dict[str, Any], workspace_root: Path | None = None) -> dict[str, Any]:
    """Create or update a lifecycle hook in PostgreSQL database, settings.json, and script files."""
    hooks_dir = _hooks_dir(workspace_root)
    hooks_dir.mkdir(parents=True, exist_ok=True)
    global_hooks_dir = _get_global_hooks_dir()

    hook_id = hook_data.get("id") or f"hook-{uuid.uuid4().hex[:8]}"
    validate_hook_id(hook_id)
    _safe_script_path(hooks_dir, hook_id)
    if global_hooks_dir:
        _safe_script_path(global_hooks_dir, hook_id)
    name = hook_data.get("name") or "Custom Lifecycle Hook"
    description = hook_data.get("description", "")
    event = hook_data.get("event") or "PreToolUse"
    matcher = hook_data.get("matcher", ".*")
    timeout = int(hook_data.get("timeout", 5000))
    enabled = hook_data.get("enabled", True)
    is_blocking = hook_data.get("is_blocking", event in {"UserPromptSubmit", "PreToolUse"})
    script_code = hook_data.get("script_code", "").strip()

    # Determine command path and write script file
    command = hook_data.get("command", "").strip()
    if script_code:
        script_filename = f"{hook_id}.sh"
        _write_script(hooks_dir, hook_id, script_code)
        if global_hooks_dir:
            _write_script(global_hooks_dir, hook_id, script_code)
        command = f"./.bob/hooks/{script_filename}"
    elif not command:
        command = f"./.bob/hooks/{hook_id}.sh"

    now = int(time.time() * 1000)

    # 1. Persist to PostgreSQL
    with _connect_db() as conn:
        if conn is not None:
            try:
                conn.execute("""
                    INSERT INTO bob_lifecycle_hooks
                    (id, name, description, event, matcher, command, script_code, timeout, enabled, is_blocking, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      name = EXCLUDED.name,
                      description = EXCLUDED.description,
                      event = EXCLUDED.event,
                      matcher = EXCLUDED.matcher,
                      command = EXCLUDED.command,
                      script_code = EXCLUDED.script_code,
                      timeout = EXCLUDED.timeout,
                      enabled = EXCLUDED.enabled,
                      is_blocking = EXCLUDED.is_blocking,
                      updated_at = EXCLUDED.updated_at
                """, (
                    hook_id, name, description, event, matcher, command, script_code,
                    timeout, enabled, is_blocking, now, now
                ))
            except Exception:
                pass

    # 2. Persist to Disk (.bob/settings.json + ~/.bob/settings/settings.json)
    config = get_hooks_config(workspace_root)
    hooks_map = config.setdefault("hooks", {})

    for evt_name, entries in list(hooks_map.items()):
        if isinstance(entries, list):
            hooks_map[evt_name] = [e for e in entries if isinstance(e, dict) and e.get("id") != hook_id]

    target_list = hooks_map.setdefault(event, [])
    target_list.append({
        "id": hook_id,
        "name": name,
        "description": description,
        "matcher": matcher,
        "enabled": enabled,
        "is_blocking": is_blocking,
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": timeout,
            }
        ],
    })

    _write_disk_settings(config, workspace_root)

    return {
        "id": hook_id,
        "name": name,
        "description": description,
        "event": event,
        "matcher": matcher,
        "command": command,
        "script_code": script_code,
        "timeout": timeout,
        "enabled": enabled,
        "is_blocking": is_blocking,
    }


def delete_hook(hook_id: str, workspace_root: Path | None = None) -> bool:
    """Delete a hook from database, .bob/settings.json, and cleanup script files."""
    validate_hook_id(hook_id)
    for directory in [_hooks_dir(workspace_root), _get_global_hooks_dir()]:
        if directory:
            _safe_script_path(directory, hook_id)
    found = False

    # 1. Delete from PostgreSQL
    with _connect_db() as conn:
        if conn is not None:
            try:
                cur = conn.execute("DELETE FROM bob_lifecycle_hooks WHERE id = %s", (hook_id,))
                if cur.rowcount > 0:
                    found = True
            except Exception:
                pass

    # 2. Delete from Disk
    config = get_hooks_config(workspace_root)
    hooks_map = config.get("hooks", {})

    for evt_name, entries in list(hooks_map.items()):
        if isinstance(entries, list):
            original_len = len(entries)
            hooks_map[evt_name] = [e for e in entries if isinstance(e, dict) and e.get("id") != hook_id]
            if len(hooks_map[evt_name]) < original_len:
                found = True

    if found:
        _write_disk_settings(config, workspace_root)

        # Cleanup script files
        for h_dir in [_hooks_dir(workspace_root), _get_global_hooks_dir()]:
            if h_dir:
                script_file = _safe_script_path(h_dir, hook_id)
                if script_file.is_file():
                    try:
                        script_file.unlink()
                    except Exception:
                        pass

    return found


def toggle_hook(hook_id: str, enabled: bool, workspace_root: Path | None = None) -> bool:
    """Toggle a hook's enabled state in database and settings.json."""
    validate_hook_id(hook_id)
    for directory in [_hooks_dir(workspace_root), _get_global_hooks_dir()]:
        if directory:
            _safe_script_path(directory, hook_id)
    found = False

    # 1. Update in PostgreSQL
    with _connect_db() as conn:
        if conn is not None:
            try:
                cur = conn.execute(
                    "UPDATE bob_lifecycle_hooks SET enabled = %s, updated_at = %s WHERE id = %s",
                    (enabled, int(time.time() * 1000), hook_id)
                )
                if cur.rowcount > 0:
                    found = True
            except Exception:
                pass

    # 2. Update in Disk
    config = get_hooks_config(workspace_root)
    hooks_map = config.get("hooks", {})

    for evt_name, entries in hooks_map.items():
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and entry.get("id") == hook_id:
                    entry["enabled"] = enabled
                    found = True

    if found:
        _write_disk_settings(config, workspace_root)

    return found


async def run_single_hook(
    command: str,
    payload: dict[str, Any],
    cwd: Path | str,
    timeout_ms: int = 5000,
) -> tuple[int, str, str]:
    """Execute a single hook subprocess with payload passed via stdin."""
    timeout_sec = min(30.0, max(0.1, timeout_ms / 1000.0))
    input_bytes = json.dumps(payload).encode("utf-8")
    cwd_path = str(cwd)

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd_path,
            start_new_session=True,
            env={key: value for key, value in os.environ.items()
                 if key in {"PATH", "LANG", "LC_ALL", "TZ"}},
        )
        async def read_bounded(stream):
            chunks = bytearray()
            while True:
                chunk = await stream.read(8192)
                if not chunk:
                    return bytes(chunks)
                chunks.extend(chunk)
                if len(chunks) > 65536:
                    raise ValueError("Hook output exceeded 64 KiB")

        async def communicate_bounded():
            async def feed():
                try:
                    proc.stdin.write(input_bytes)
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    proc.stdin.close()
            tasks = [asyncio.create_task(coro) for coro in (
                feed(), read_bounded(proc.stdout), read_bounded(proc.stderr), proc.wait()
            )]
            try:
                _, stdout, stderr, _ = await asyncio.gather(*tasks)
                return stdout, stderr
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        stdout_data, stderr_data = await asyncio.wait_for(
            communicate_bounded(), timeout=timeout_sec,
        )
        return (
            proc.returncode if proc.returncode is not None else -1,
            stdout_data.decode("utf-8", errors="replace").strip(),
            stderr_data.decode("utf-8", errors="replace").strip(),
        )
    except BaseException as exc:
        if "proc" in locals():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # Drain buffered pipes as well as reaping: wait() alone can deadlock
            # when a terminated child filled an asyncio stream buffer.
            await proc.communicate()
        if isinstance(exc, asyncio.CancelledError):
            raise
        if isinstance(exc, asyncio.TimeoutError):
            return (-1, "", f"Hook execution timed out after {timeout_sec}s")
        if not isinstance(exc, Exception):
            raise
        return (-1, "", f"Hook execution failed: {exc}")


async def execute_event_hooks(
    event_name: str,
    payload: dict[str, Any],
    match_target: str = "",
    workspace_root: Path | None = None,
) -> tuple[bool, str, str]:
    """
    Run all active hooks matching event_name and match_target.
    Returns: (allowed: bool, output_context: str, error_message: str)
    Enforcement hook failures deny the action; exit code 2 always blocks.
    """
    root = _get_workspace_root(workspace_root)
    hooks = list_hooks(root)
    active_hooks = [h for h in hooks if h.get("event") == event_name and h.get("enabled", True)]

    collected_output: list[str] = []

    for hook in active_hooks:
        try:
            validate_hook_id(hook.get("id"))
        except ValueError:
            return (False, "", "Invalid persisted hook ID; administrator review required")
        matcher = hook.get("matcher", ".*")
        if matcher and matcher != ".*":
            try:
                if not re.search(matcher, match_target or "", re.I):
                    continue
            except Exception:
                pass

        command = hook.get("command")
        if not command:
            continue

        timeout = hook.get("timeout", 5000)
        code, out, err = await run_single_hook(command, payload, cwd=root, timeout_ms=timeout)

        # Enforcement hooks fail closed on timeout, output overflow, and crashes.
        if code == 2 or (code != 0 and hook.get("is_blocking", True)):
            msg = err or out or f"Blocked by hook '{hook.get('name')}'"
            return (False, "", msg)

        if out:
            collected_output.append(out)

    return (True, "\n".join(collected_output), "")
