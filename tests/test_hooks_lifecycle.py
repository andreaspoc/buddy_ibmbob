import pytest
import tempfile
import asyncio
from pathlib import Path
from app.hooks import (
    BUILTIN_HOOK_TEMPLATES,
    list_hooks,
    save_hook,
    delete_hook,
    toggle_hook,
    execute_event_hooks,
    run_single_hook,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_builtin_hook_templates_present():
    assert len(BUILTIN_HOOK_TEMPLATES) >= 4
    events = {t["event"] for t in BUILTIN_HOOK_TEMPLATES}
    assert "PreToolUse" in events
    assert "UserPromptSubmit" in events


def test_save_and_list_hooks():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        created = save_hook({
            "name": "Block Rm Rf",
            "event": "PreToolUse",
            "matcher": "^run_command$",
            "script_code": "#!/bin/bash\nexit 0\n",
        }, workspace_root=root)

        assert created["name"] == "Block Rm Rf"
        assert created["event"] == "PreToolUse"
        assert created["command"].endswith(".sh")

        hooks = list_hooks(workspace_root=root)
        assert len(hooks) == 1
        assert hooks[0]["name"] == "Block Rm Rf"
        assert hooks[0]["enabled"] is True

        # Toggle hook
        ok = toggle_hook(created["id"], False, workspace_root=root)
        assert ok is True
        hooks_after = list_hooks(workspace_root=root)
        assert hooks_after[0]["enabled"] is False

        # Delete hook
        del_ok = delete_hook(created["id"], workspace_root=root)
        assert del_ok is True
        assert len(list_hooks(workspace_root=root)) == 0


@pytest.mark.anyio
async def test_blocking_hook_halts_action():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Create blocking hook
        save_hook({
            "id": "block-test",
            "name": "Block Test",
            "event": "UserPromptSubmit",
            "matcher": ".*",
            "script_code": """#!/bin/bash
PAYLOAD=$(cat)
if echo "$PAYLOAD" | grep -q "SECRET_TOKEN"; then
  echo "Blocked: prompt contains secret token" >&2
  exit 2
fi
echo "Context: clean prompt"
exit 0
""",
        }, workspace_root=root)

        # Passing prompt
        ok1, out1, err1 = await execute_event_hooks(
            "UserPromptSubmit",
            {"prompt": "Hello world"},
            match_target="Hello world",
            workspace_root=root,
        )
        assert ok1 is True
        assert "clean prompt" in out1

        # Blocked prompt (exit 2)
        ok2, out2, err2 = await execute_event_hooks(
            "UserPromptSubmit",
            {"prompt": "My key is SECRET_TOKEN"},
            match_target="My key is SECRET_TOKEN",
            workspace_root=root,
        )
        assert ok2 is False
        assert "secret token" in err2
