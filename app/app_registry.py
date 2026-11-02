"""User-visible app discovery. Manifests are administrator-installed data, not code."""
from app.branding import brand_text
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends
from app.auth import current_user
from app.plugin_client import enabled

router = APIRouter(prefix='/api/apps', tags=['apps'])
log = logging.getLogger(__name__)
CORE = (
    ('chat', 'Buddy chat', 'AI conversations and saved history', 'chat'),
    ('notes', 'Notes', 'Your notes and collections', 'notes'),
    ('presentations', 'Presentations', 'Design slides, decks, and pitches', 'presentations'),
    ('productivity', 'Productivity workspace', 'Planning & automation', 'productivity'),
    ('tasks', 'Tasks', 'Background work and results', 'tasks'),
    ('knowledge', 'Knowledge base', 'Company knowledge and documents', 'knowledge'),
    ('research', 'Research reports', 'Research and saved reports', 'research'),
    ('workflows', 'Workflows', 'Saved workflows and schedules', 'workflows'),
    ('search', 'Search saved work', 'Find conversations and files', 'search'),
    ('connections', 'MCP connections', 'Connected tools and services', 'connections'),
)
RESERVED = {item[0] for item in CORE} | {'office', 'people', 'projects', 'decisions', 'tetragon', 'docmost', 'members', 'apps', 'new-chat', 'learning'}


def _memberships(user):
    from app.auth import user_group_names
    result = set()
    if user.get('is_admin'):
        result.add('administrators')
    result |= user_group_names(user['username'])
    return result


def _safe_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        return False
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        return False
    if value.startswith('/'):
        return not value.startswith('//') and not value.lower().startswith(('/%2f', '/%5c'))
    try:
        return parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password and bool(parsed.port or 443)
    except ValueError:
        return False


def _installed_manifests(user, used=None):
    directory = Path(os.getenv('BUDDY_APP_MANIFEST_DIR', '/opt/bob-a2a/app-manifests'))
    if not directory.is_dir():
        return []
    result, used_set = [], set(RESERVED if used is None else used)
    for path in sorted(directory.glob('*.json'))[:100]:
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                continue
            data = json.loads(path.read_text())
            if not isinstance(data, dict) or data.get('enabled', True) is not True:
                continue
            identity = data.get('id', '')
            import re
            if not isinstance(identity, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', identity) or identity in used_set:
                continue
            name, description = data.get('name'), data.get('description', '')
            if not isinstance(name, str) or not name.strip() or len(name) > 100 or not isinstance(description, str) or len(description) > 300:
                continue
            users, groups = data.get('users', []), data.get('groups', [])
            if not isinstance(users, list) or not isinstance(groups, list) or not all(isinstance(value, str) for value in users + groups):
                continue
            if (users or groups) and user['username'] not in users and not _memberships(user).intersection(groups):
                continue
            if not _safe_url(data.get('url')):
                continue
            desktop_only = data.get('desktop_only', False)
            if not isinstance(desktop_only, bool):
                continue
            result.append({'id': identity, 'name': name.strip(), 'description': description,
                           'kind': 'installed', 'desktop_only': desktop_only,
                           'launch': {'kind': 'link', 'url': data['url']}})
            used_set.add(identity)
        except (OSError, ValueError, TypeError):
            log.warning('Ignoring invalid app registration')
    return result


def registry(user):
    apps = [{'id': identity, 'name': name, 'description': description, 'kind': 'core',
             'desktop_only': False, 'launch': {'kind': action}}
            for identity, name, description, action in CORE]
    if enabled('office'):
        apps.append({'id': 'office', 'name': 'Office Suite', 'description': 'Documents, spreadsheets and presentations',
                     'kind': 'installed', 'desktop_only': True, 'launch': {'kind': 'office'}})
    if enabled('learning'):
        apps.append({'id': 'learning', 'name': brand_text('Learning Buddy'), 'description': 'EPUB library, folder access and private assessments',
                     'kind': 'installed', 'desktop_only': False, 'launch': {'kind': 'link', 'url': '/learning/', 'target': '_self'}})
    if enabled('people'):
        apps.append({'id': 'people', 'name': 'Member chat', 'description': 'Messages, channels and collaboration',
                     'kind': 'installed', 'desktop_only': False, 'launch': {'kind': 'people'}})
    if enabled('projects'):
        apps.append({'id': 'projects', 'name': 'Projects', 'description': 'People, responsibilities, dependencies and change impact',
                     'kind': 'installed', 'desktop_only': False, 'launch': {'kind': 'projects'}})
    if enabled('decisions'):
        apps.append({'id': 'decisions', 'name': 'Decision service', 'description': 'Business decision tables, watsonx AI/ML models, rule simulator, and CP4D governance',
                     'kind': 'installed', 'desktop_only': False, 'launch': {'kind': 'decisions'}})
    if enabled('tetragon') and user.get('is_admin'):
        apps.append({'id': 'tetragon', 'name': 'Tetragon rules',
                     'description': 'Host runtime blocking policies, engine status and rule audit history',
                     'kind': 'installed', 'desktop_only': False,
                     'launch': {'kind': 'link', 'url': '/tetragon/'}})
    apps.extend(_installed_manifests(user, used={a['id'] for a in apps} | RESERVED))
    return {'version': 1, 'apps': apps}


@router.get('')
def available_apps(user: dict = Depends(current_user)):
    return registry(user)
