"""Manage project-local Buddy skills and modes created through the UI."""

from __future__ import annotations

import json
import os
import re
import tempfile
from contextvars import ContextVar
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import yaml
from app import postgres_storage as storage
from app.skill_names import canonical_skill_name, migration_plan, rename_descriptor, descriptor_name


BUILTIN_MODES = [
    {"slug": "agent", "name": "Agent", "description": "Autonomously research, execute workflows, and solve problems.", "kind": "built-in"},
    {"slug": "presentation", "name": "Presentation", "description": "Create BobDeck slides and export to PowerPoint.", "kind": "built-in"},
    {"slug": "plan", "name": "Plan", "description": "Plan work before implementation.", "kind": "built-in"},
    {"slug": "ask", "name": "Ask", "description": "Answer questions and explain code.", "kind": "built-in"},
]
ALLOWED_GROUPS = {
    "read", "edit", "execute", "browser", "mcp", "skill", "todo", "subtask",
    "subagent", "mode", "workflow",
}
_mode_lock = Lock()
_integration_lock = Lock()
_selected_root: ContextVar[Path | None] = ContextVar("selected_workspace_root", default=None)


def select_root(path: Path) -> None:
    _selected_root.set(path)


def _root() -> Path:
    return _selected_root.get() or Path(os.getenv("BOB_WORKSPACE", "/workspace"))


def list_skills(*, restored: bool = False) -> list[dict[str, str]]:
    found = []
    root = _root()
    identity = storage.user_file_identity(root / '.bob' / 'skills' / 'placeholder')
    if identity and not restored:
        storage.migrate_skill_names(identity[0])
        descriptors = {item['path'] for item in storage.list_files(identity[0], 'user', internal=True)
                       if item['path'].startswith('.bob/skills/') and item['path'].endswith('/SKILL.md')}
        deleted = storage.deleted_skill_folders(identity[0])
        shipped = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / ".bob" / "skills"
        if shipped.is_dir():
            for sk in shipped.glob("*/SKILL.md"):
                target = canonical_skill_name(descriptor_name(sk.read_bytes(), sk.parent.name))
                rel_path = f".bob/skills/{target}/SKILL.md"
                if sk.parent.name not in deleted and target not in deleted and rel_path not in descriptors:
                    storage.write_user_file(root / rel_path, rename_descriptor(sk.read_bytes(), target))
                    descriptors.add(rel_path)
        paths = [root / path for path in sorted(descriptors)]
    else:
        if not restored:
            _migrate_local_skills(root)
        paths = sorted((root / '.bob' / 'skills').glob('*/SKILL.md'))
    for skill_file in paths:
        name = skill_file.parent.name
        description = ""
        content = skill_file.read_bytes() if restored else storage.read_user_file(skill_file)
        # A concurrent delete can remove a descriptor after the catalog scan.
        if content is None:
            continue
        text = content.decode("utf-8")
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
        metadata = yaml.safe_load(match.group(1)) if match else {}
        if isinstance(metadata, dict):
            name = str(metadata.get('name', name))
            description = str(metadata.get('description', ''))
        found.append({"name": name, "description": description})
    return found


def create_skill(slug: str, description: str, instructions: str) -> dict[str, str]:
    _validate_skill(slug, instructions)
    slug = canonical_skill_name(slug)
    list_skills()
    directory = _root() / ".bob" / "skills" / slug
    content = (
        f"---\nname: {slug}\ndescription: {json.dumps(description, ensure_ascii=False)}\n"
        "user-invocable: true\n---\n\n"
        f"{instructions.strip()}\n"
    )
    storage.write_user_file(directory / "SKILL.md", content.encode("utf-8"), exclusive=True, recreate_skill=True)
    return {"name": slug, "description": description}


def _validate_skill(name: str, instructions: str | None = None) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
        raise ValueError("Invalid skill name")
    if instructions is not None and not instructions.strip():
        raise ValueError("Skill instructions cannot be empty")


def _skill_document(name: str) -> tuple[Path, dict, str]:
    _validate_skill(name)
    # Seed shipped skills into the user's storage before reading an override.
    list_skills()
    name = resolve_skill_name(name)
    root = _root()
    identity = storage.user_file_identity(root / '.bob' / 'skills' / 'placeholder')
    if identity:
        paths = [root / item['path'] for item in storage.list_files(identity[0], 'user', internal=True)
                 if re.fullmatch(r"\.bob/skills/[a-z][a-z0-9-]{0,63}/SKILL\.md", item['path'])]
    else:
        paths = list((root / '.bob' / 'skills').glob('*/SKILL.md'))
    for path in paths:
        content = storage.read_user_file(path)
        if content is None:
            continue
        text = content.decode('utf-8')
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
        metadata = yaml.safe_load(match.group(1)) if match else {}
        if not isinstance(metadata, dict):
            raise ValueError("Invalid skill frontmatter")
        if metadata.get('name', path.parent.name) == name:
            return path, metadata, text[match.end():].strip() if match else text.strip()
    raise KeyError(f"Skill '{name}' not found")


def get_skill(name: str) -> dict[str, str]:
    _, metadata, instructions = _skill_document(name)
    return {"name": metadata['name'], "description": str(metadata.get('description', '')), "instructions": instructions}


def update_skill(name: str, description: str, instructions: str) -> dict[str, str]:
    _validate_skill(name, instructions)
    with _integration_lock:
        path, metadata, _ = _skill_document(name)
        name = metadata['name']
        metadata.update(name=name, description=description)
        frontmatter = yaml.safe_dump(metadata, sort_keys=False, allow_unicode=True).rstrip()
        storage.write_user_file(path, f"---\n{frontmatter}\n---\n\n{instructions.strip()}\n".encode('utf-8'))
    return {"name": name, "description": description, "instructions": instructions.strip()}


def _mode_file() -> Path:
    return _root() / ".bob" / "custom_modes.yaml"


def _read_custom_modes() -> list[dict]:
    path = _mode_file()
    content = storage.read_user_file(path)
    if content is None:
        return []
    data = yaml.safe_load(content.decode("utf-8")) or {}
    if not isinstance(data, dict) or not isinstance(data.get("customModes", []), list):
        raise ValueError("Invalid .bob/custom_modes.yaml format")
    return data.get("customModes", [])


def list_modes() -> list[dict[str, str]]:
    custom = [
        {
            "slug": item.get("slug", ""),
            "name": item.get("name", item.get("slug", "")),
            "description": item.get("description", ""),
            "kind": "custom",
        }
        for item in _read_custom_modes()
        if isinstance(item, dict) and isinstance(item.get("slug"), str)
    ]
    return BUILTIN_MODES + custom


def create_mode(
    slug: str,
    name: str,
    description: str,
    role_definition: str,
    instructions: str,
    groups: list[str],
) -> dict[str, str]:
    if not set(groups).issubset(ALLOWED_GROUPS):
        raise ValueError("Unsupported tool group")
    with _mode_lock:
        modes = _read_custom_modes()
        if slug in {item["slug"] for item in BUILTIN_MODES} or any(
            item.get("slug") == slug for item in modes if isinstance(item, dict)
        ):
            raise FileExistsError(f"Mode '{slug}' already exists")
        modes.append(
            {
                "slug": slug,
                "name": name,
                "description": description,
                "roleDefinition": role_definition,
                "customInstructions": instructions,
                "groups": groups,
            }
        )
        content = yaml.safe_dump({'customModes': modes}, sort_keys=False, allow_unicode=True)
        storage.write_user_file(_mode_file(), content.encode('utf-8'))
    return {"slug": slug, "name": name, "description": description, "kind": "custom"}


def _read_json(path: Path, key: str) -> dict:
    content = storage.read_user_file(path)
    if content is None:
        return {}
    data = json.loads(content)
    if not isinstance(data, dict) or not isinstance(data.get(key, {}), dict):
        raise ValueError(f"Invalid {path.name} format")
    return data.get(key, {})


def _write_json(path: Path, key: str, entries: dict) -> None:
    content = storage.read_user_file(path)
    data = json.loads(content) if content else {}
    if not isinstance(data, dict):
        raise ValueError(f'Invalid {path.name} format')
    data[key] = entries
    storage.write_user_file(path, (json.dumps(data, indent=2, ensure_ascii=False) + '\n').encode('utf-8'))


def _mcp_file() -> Path:
    if _selected_root.get():
        return _root() / ".home" / ".bob" / "mcp_settings.json"
    return Path(os.getenv("BOB_MCP_SETTINGS_FILE", "/root/.bob/mcp_settings.json"))


def _mcp_sources() -> list[Path]:
    global_file = Path(os.getenv("BOB_MCP_SETTINGS_FILE", "/root/.bob/mcp_settings.json"))
    default_root = Path(os.getenv("BOB_WORKSPACE", "/workspace"))
    # Match Bob's global-before-workspace precedence; user settings override defaults.
    return list(dict.fromkeys([
        global_file, global_file.parent / "mcp.json", global_file.parent / "settings" / "mcp.json",
        default_root / ".bob" / "mcp_settings.json", default_root / ".bob" / "mcp.json",
        _root() / ".bob" / "mcp_settings.json", _root() / ".bob" / "mcp.json",
        _mcp_file().parent / "mcp.json", _mcp_file().parent / "settings" / "mcp.json", _mcp_file(),
    ]))


def mcp_actor() -> str | None:
    identity = storage.user_file_identity(_root() / '.bob' / 'mcp.json')
    return identity[0] if identity else None


def migrate_mcp_registry() -> None:
    from app import mcp_access
    from app.auth import _connect
    from app.sessions import user_root
    mcp_access.ensure_schema()
    with _connect() as db:
        if db.execute('SELECT 1 FROM bob_mcp_migrations WHERE source=%s', ('legacy-registry-v1',)).fetchone():
            return
        administrators = [row[0] for row in db.execute('SELECT username FROM users WHERE is_admin ORDER BY username').fetchall()]
    global_root = Path(os.getenv('BOB_WORKSPACE', '/workspace'))
    global_file = Path(os.getenv('BOB_MCP_SETTINGS_FILE', '/root/.bob/mcp_settings.json'))
    sources = [global_file, global_file.parent / 'mcp.json', global_file.parent / 'settings' / 'mcp.json',
               global_root / '.bob' / 'mcp_settings.json', global_root / '.bob' / 'mcp.json']
    # Only administrator-owned legacy settings become central definitions. Read
    # stable descriptors directly; do not switch the caller's selected workspace.
    for administrator in administrators:
        root = user_root(administrator)
        home = root / '.home' / '.bob'
        sources += [root / '.bob' / 'mcp_settings.json', root / '.bob' / 'mcp.json',
                    home / 'mcp.json', home / 'settings' / 'mcp.json', home / 'mcp_settings.json']
    configs, deleted = {}, set()
    for path in dict.fromkeys(sources):
        content = storage.read_user_file(path)
        if not content:
            continue
        data = json.loads(content)
        configs.update(data.get('mcpServers', {}))
        deleted.update(data.get('deletedMcpServers', []))
    deleted.discard('brave_search')
    mcp_access.seed('legacy-registry-v1', configs, deleted)


def effective_mcp_servers() -> dict:
    from app import mcp_access
    migrate_mcp_registry()
    actor = mcp_actor()
    return mcp_access.allowed_servers(actor) if actor else {}


def list_mcps(*, admin=False) -> list[dict]:
    from app import mcp_access
    ensure_brave_mcp()
    actor = mcp_actor()
    return mcp_access.catalog(actor, include_all=admin) if actor else []


def get_mcp_config(name: str) -> dict | None:
    return effective_mcp_servers().get(name)


def build_mcp_config(
    transport: str, url: str, command: str, args: list[str],
    parameters: dict[str, str], headers: dict[str, str], env: dict[str, str],
    api_key: str, api_key_name: str, api_key_prefix: str,
) -> dict:
    if transport not in {"http", "sse", "stdio"}:
        raise ValueError("Unsupported MCP transport")
    if any(not isinstance(value, str) for value in [*parameters.values(), *headers.values(), *env.values()]):
        raise ValueError("Parameters, headers, and environment values must be strings")
    if transport == "stdio":
        if not command.strip():
            raise ValueError("Enter a command for the MCP server")
        if not args and " " in command:
            import shlex
            parts = shlex.split(command)
            if parts:
                command = parts[0]
                args = parts[1:]
        config: dict = {"command": command, "args": args}
        if env:
            config["env"] = dict(env)
        if api_key:
            if not api_key_name:
                api_key_name = "API_KEY"
            if not api_key_name.isidentifier():
                raise ValueError("Enter a valid environment variable name for the API key")
            config.setdefault("env", {})[api_key_name] = api_key
        from app.mcp_command_policy import validate_stdio_config
        validate_stdio_config(config)
    else:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Enter a valid HTTP or HTTPS MCP URL")
        if parameters:
            parsed = urlsplit(url)
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            query.update(parameters)
            url = urlunsplit(parsed._replace(query=urlencode(query)))
        config = {"httpURL" if transport == "http" else "url": url}
        if headers:
            config["headers"] = dict(headers)
        if api_key:
            if not api_key_name:
                api_key_name = "Authorization"
            if any(c in api_key_name for c in "\r\n:"):
                raise ValueError("Enter a valid header name for the API key")
            config.setdefault("headers", {})[api_key_name] = f"{api_key_prefix}{api_key}"
    return config


def create_mcp(
    name: str, transport: str, url: str, command: str, args: list[str],
    parameters: dict[str, str], headers: dict[str, str], env: dict[str, str],
    api_key: str, api_key_name: str, api_key_prefix: str,
    knowledge_base: str = 'company', audience: str = 'both',
    disabled: bool = False,
) -> dict:
    from app import mcp_access
    migrate_mcp_registry()
    config = build_mcp_config(transport, url, command, args, parameters, headers, env,
                             api_key, api_key_name, api_key_prefix)
    config['disabled'] = disabled
    return mcp_access.create(mcp_actor(), name, config, knowledge_base, audience)


def update_mcp(name: str, **values) -> dict:
    from app import mcp_access
    migrate_mcp_registry()
    base, audience = values.pop('knowledge_base', None), values.pop('audience', None)
    disabled = values.pop('disabled', None)
    config = build_mcp_config(**values)
    if disabled is not None:
        config['disabled'] = disabled
    elif name == 'monday-platform-local' and config.get('env', {}).get('MONDAY_TOKEN'):
        config['disabled'] = False
    return mcp_access.update(mcp_actor(), name, config, base, audience)


def delete_mcp(name: str) -> bool:
    from app import mcp_access
    migrate_mcp_registry()
    return mcp_access.delete(mcp_actor(), name)


def ensure_microsoft_mcp() -> None:
    from app import mcp_access
    migrate_mcp_registry()
    mcp_access.ensure_builtin('microsoft365', {'command': 'python3', 'args': ['-m', 'app.mcp_microsoft'],
                                              'env': {'PYTHONPATH': '/opt/bob-a2a'}})


def remove_microsoft_mcp() -> None:
    # Disconnecting delegated credentials affects only the caller, not the shared
    # definition or other employees' access. microsoft_auth removes their tokens.
    pass


def ensure_brave_mcp(target_path: Path | None = None) -> None:
    from app import mcp_access
    migrate_mcp_registry()
    config = {'command': 'python3', 'args': ['-m', 'app.mcp_search'],
              'env': {'PYTHONPATH': str(Path(__file__).resolve().parent.parent),
                      'BRAVE_API_KEY': os.getenv('BRAVE_API_KEY', '').strip()}}
    mcp_access.ensure_builtin('brave_search', config)
    mcp_access.ensure_builtin('monday-platform-local', {
        'command': 'mcp-server-monday-api', 'args': [],
        'env': {'MONDAY_TOKEN': ''}, 'disabled': True,
    })
    if target_path:
        servers = effective_mcp_servers()
        for path in [target_path, target_path.parent / 'mcp.json',
                     target_path.parent / 'settings' / 'mcp.json', _root() / '.bob' / 'mcp.json']:
            path.parent.mkdir(parents=True, exist_ok=True)
            existing = json.loads(path.read_text()) if path.is_file() else {}
            existing['mcpServers'] = servers
            path.write_text(json.dumps(existing, indent=2) + '\n')


def _agents_file() -> Path:
    return _root() / ".bob" / "a2a_agents.json"


def list_agents() -> list[dict[str, str]]:
    all_agents: dict[str, dict] = {}
    global_file = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / ".bob" / "a2a_agents.json"
    if global_file.is_file():
        all_agents.update(_read_json(global_file, "agents"))
    user_file = _agents_file()
    if user_file != global_file and storage.read_user_file(user_file) is not None:
        all_agents.update(_read_json(user_file, "agents"))
    result = [dict(_public_agent(agent), slug=slug) for slug, agent in sorted(all_agents.items())]
    actor = mcp_actor()
    if actor:
        from app.agent_catalog import activated_agents
        result.extend(activated_agents(actor))
    return result


def _public_agent(agent):
    return {key: value for key, value in agent.items() if key not in {'api_key', 'auth_token', 'headers', 'credentials'}}


def create_agent(slug: str, agent: dict[str, str]) -> dict[str, str]:
    if slug.startswith('catalog-'):
        raise ValueError('The catalog- prefix is reserved for shared A2A agents')
    with _integration_lock:
        agents = _read_json(_agents_file(), "agents")
        if slug in agents:
            raise FileExistsError(f"A2A agent '{slug}' already exists")
        agents[slug] = agent
        _write_json(_agents_file(), "agents", agents)
    return dict(_public_agent(agent), slug=slug)


def get_agent(slug: str) -> dict[str, str] | None:
    if slug.startswith('catalog-'):
        actor = mcp_actor()
        if not actor:
            return None
        from app.agent_catalog import get_authorized_agent
        return get_authorized_agent(actor, slug)
    user_file = _agents_file()
    user_agents = _read_json(user_file, "agents")
    if slug in user_agents:
        return user_agents[slug]
    global_file = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / ".bob" / "a2a_agents.json"
    if global_file != user_file and global_file.is_file():
        return _read_json(global_file, "agents").get(slug)
    return None


def update_agent(slug: str, updates: dict[str, str]) -> dict[str, str]:
    if slug.startswith('catalog-'):
        raise ValueError('Update shared agent credentials through the A2A catalog')
    with _integration_lock:
        user_file = _agents_file()
        agents = _read_json(user_file, "agents")
        if slug not in agents:
            # Check global
            global_file = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / ".bob" / "a2a_agents.json"
            global_agents = _read_json(global_file, "agents") if global_file.is_file() else {}
            if slug in global_agents:
                agents[slug] = dict(global_agents[slug])
            else:
                raise KeyError(f"A2A agent '{slug}' not found")
        agents[slug].update({k: v for k, v in updates.items() if v is not None and (k not in {'api_key', 'auth_token'} or bool(v.strip()))})
        _write_json(user_file, "agents", agents)
    return dict(_public_agent(agents[slug]), slug=slug)


def delete_agent(slug: str) -> None:
    if slug.startswith('catalog-'):
        raise ValueError('Deactivate shared agents through the A2A catalog')
    with _integration_lock:
        user_file = _agents_file()
        agents = _read_json(user_file, "agents")
        if slug in agents:
            del agents[slug]
            _write_json(user_file, "agents", agents)
            return
        global_file = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / ".bob" / "a2a_agents.json"
        global_agents = _read_json(global_file, "agents") if global_file.is_file() else {}
        if slug in global_agents:
            del global_agents[slug]
            _write_json(global_file, "agents", global_agents)
            return
        raise KeyError(f"A2A agent '{slug}' not found")


def delete_skill(name: str) -> None:
    _validate_skill(name)
    with _integration_lock:
        path, metadata, _ = _skill_document(name)
        storage.delete_skill_tree(path.parent, metadata['name'])


def resolve_skill_name(name: str) -> str:
    identity = storage.user_file_identity(_root() / '.bob/skills/placeholder')
    if identity:
        resolved = storage.resolve_skill_alias(identity[0], name)
        if resolved != name:
            return resolved
    return canonical_skill_name(name)


def _migrate_local_skills(root: Path) -> None:
    skills = root / '.bob/skills'
    descriptors = {path.parent.name: path.read_bytes() for path in skills.glob('*/SKILL.md')}
    for folder, (_, target) in migration_plan(descriptors).items():
        source = skills / folder
        destination = skills / target
        if source != destination:
            source.rename(destination)
        (destination / 'SKILL.md').write_bytes(rename_descriptor(descriptors[folder], target))
