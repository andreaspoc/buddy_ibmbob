"""Instance name and organization, and the text that carries them into prompts and messages."""
import json
import os
import re
import time
from pathlib import Path

DEFAULT_NAME = 'Buddy'
_CACHE_SECONDS = 15
_cache = {'at': 0.0, 'value': None}
# "Office Buddy" and similar are product module names; "Buddy Office" likewise.
_ASSISTANT_WORD = re.compile(r"(?<![\w-])(?<!Office )(?<!Project )(?<!Notes )(?<!People )(?<!Learning )(?<!Decisions )Buddy(?![\w-])(?! (?:Office|Decisions|Projects|Tetragon)\b)")


def _environment_brand():
    return {'name': os.getenv('BUDDY_NAME', '').strip() or DEFAULT_NAME,
            'organization': os.getenv('BUDDY_ORGANIZATION', '').strip()}


def invalidate_brand_cache():
    _cache.update(at=0.0, value=None)


def current_brand():
    """Name and organization for this instance; never raises, so text can always be rendered."""
    now = time.monotonic()
    if _cache['value'] and now - _cache['at'] < _CACHE_SECONDS:
        return _cache['value']
    value = _environment_brand()
    database = os.getenv('DATABASE_URL', '')
    if database:
        try:
            import psycopg
            with psycopg.connect(database, connect_timeout=3) as db:
                row = db.execute('SELECT name, organization FROM bob_instance_brand WHERE id=1').fetchone()
            if row:
                value = {'name': row[0], 'organization': row[1]}
        except Exception:
            # Schema not created yet, or database briefly unavailable: use the fallback,
            # and retry once the short cache interval has passed.
            pass
    _cache.update(at=now, value=value)
    return value


def brand_name():
    return current_brand()['name']


def organization_label():
    """Organization name for certificates and headers, or the assistant name if none was set."""
    brand = current_brand()
    return brand['organization'] or brand['name']


def brand_text(text):
    """Render a product string or prompt template with this instance's identity."""
    brand = current_brand()
    name, organization = brand['name'], brand['organization']
    rendered = text.replace('{{ASSISTANT_NAME}}', name)
    rendered = rendered.replace('{{ORGANIZATION}}', organization or 'your organization')
    rendered = rendered.replace('{{ORGANIZATION_LABEL}}', organization or name)
    return rendered if name == DEFAULT_NAME else _ASSISTANT_WORD.sub(lambda _match: name, rendered)


def identity_instruction():
    """Authoritative identity, so older text saved in a session cannot keep a previous name."""
    brand = current_brand()
    workplace = f" for {brand['organization']}" if brand['organization'] else ''
    return (f"[Identity]: You are {brand['name']}, the AI assistant{workplace}. Use only this name for "
            'yourself, even if saved files mention a different one. Only a later [Assistant name] '
            'block from this user may change it.')


def normalize_identity(text: str) -> str:
    def remove_phrase(source, pattern, *, comma=False):
        pieces, end = [], 0
        # Find the phrase first, then consume its preceding whitespace once.
        # Starting a regex with \s* retries a long whitespace run at every offset.
        for match in re.finditer(pattern, source, re.IGNORECASE):
            start = match.start()
            while start > end and source[start - 1].isspace():
                start -= 1
            if comma and start > end and source[start - 1] == ',':
                start -= 1
            pieces.append(source[end:start])
            end = match.end()
        pieces.append(source[end:])
        return ''.join(pieces)

    text = remove_phrase(text, r'\(Powered by IBM Bob\)')
    return remove_phrase(text, r'powered by\s+(?:\*\*)?IBM Bob(?:\*\*)?', comma=True)


def refresh_identity_settings(root: Path) -> None:
    for path in (root / '.bob/settings.json', root / '.home/.bob/settings.json',
                 root / '.home/.bob/settings/settings.json'):
        if path.is_file():
            data = json.loads(path.read_text())
            instructions = data.get('customInstructions')
            if isinstance(instructions, str):
                updated = brand_text(normalize_identity(instructions))
                if updated != instructions:
                    data['customInstructions'] = updated
                    path.write_text(json.dumps(data, indent=2) + '\n')
    for folder in ('rules', 'rules-agent'):
        path = root / '.bob' / folder / 'assistant-identity.md'
        if path.is_file():
            original = path.read_text()
            updated = brand_text(normalize_identity(original))
            if updated != original:
                path.write_text(updated)
