"""Optional Docmost launcher. Buddy visibility never grants Docmost access."""
import os
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, Response
from app.auth import current_user

router = APIRouter(prefix='/integrations/docmost', tags=['docmost'])


def settings(user):
    url = os.getenv('DOCMOST_URL', '').strip()
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        return {'enabled': False}
    if not url or parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        return {'enabled': False}
    # Explicit allowlists only; no implicit access for all employees or administrators.
    from app.auth import user_group_names
    users = {name.strip() for name in os.getenv('DOCMOST_ALLOWED_USERS', '').split(',') if name.strip()}
    groups = {name.strip().lower() for name in os.getenv('DOCMOST_ALLOWED_GROUPS', '').split(',') if name.strip()}
    memberships = set()
    if user.get('is_admin'): memberships.add('administrators')
    memberships |= user_group_names(user['username'])
    if user['username'] not in users and not groups.intersection(memberships):
        return {'enabled': False}
    return {'enabled': True, 'url': url, 'embed': os.getenv('DOCMOST_EMBED', '0') == '1'}


@router.get('')
def configuration(response: Response, user: dict = Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return settings(user)
