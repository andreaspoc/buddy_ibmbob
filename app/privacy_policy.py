"""Administrator-defined rules for what may leave the platform, on every outbound channel."""
import logging
import time
from typing import Literal

from fastapi import APIRouter, Depends
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.admin_users import administrator
from app.auth import _connect
from app.origin_policy import same_origin
from app.personal_data import CATEGORIES, PersonalDataBlocked, normalized, scan_file, scan_text, scan_tool_arguments

router = APIRouter(prefix='/admin/privacy-policy', tags=['administration'])
logger = logging.getLogger('security.personal_data')
Action = Literal['allow', 'ask', 'block']
Channel = Literal['email', 'download', 'external_tool', 'external_agent', 'share']
CHANNELS = ('email', 'download', 'external_tool', 'external_agent', 'share')
CACHE_SECONDS = 15
_cache = (0.0, None)


class CustomRule(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    terms: list[str] = Field(min_length=1, max_length=200)
    action: Literal['ask', 'block'] = 'block'

    @field_validator('terms')
    @classmethod
    def usable_terms(cls, value):
        terms = [item.strip() for item in value if item.strip()]
        if not terms or any(len(item) > 200 for item in terms):
            raise ValueError('Enter terms of up to 200 characters')
        return terms


class PrivacyPolicy(BaseModel):
    model_config = ConfigDict(extra='forbid')
    categories: dict[str, Action] = Field(default_factory=dict)
    channels: dict[Channel, bool] = Field(default_factory=dict)
    custom_rules: list[CustomRule] = Field(default_factory=list, max_length=100)

    @field_validator('categories')
    @classmethod
    def known_categories(cls, value):
        if set(value) - set(CATEGORIES):
            raise ValueError('Unknown data category')
        return value


def _complete(policy: PrivacyPolicy) -> dict:
    # Anything not chosen by an administrator stays reviewed and enabled.
    data = policy.model_dump()
    data['categories'] = {label: data['categories'].get(label, 'ask') for label in CATEGORIES}
    data['channels'] = {name: data['channels'].get(name, True) for name in CHANNELS}
    return data


def _stored(config: dict) -> PrivacyPolicy:
    # Settings from removed features must not invalidate an administrator's other rules.
    return PrivacyPolicy(categories={key: value for key, value in config.get('categories', {}).items() if key in CATEGORIES},
                         channels=config.get('channels', {}), custom_rules=config.get('custom_rules', []))


def _schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS bob_privacy_policy (id INTEGER PRIMARY KEY CHECK(id=1), config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())')


def load_policy() -> dict:
    global _cache
    expires, cached = _cache
    if cached is not None and time.monotonic() < expires:
        return cached
    try:
        with _connect() as db:
            _schema(db)
            row = db.execute('SELECT config FROM bob_privacy_policy WHERE id=1').fetchone()
        policy = _complete(_stored(row[0])) if row else _complete(PrivacyPolicy())
    except Exception:  # An unreadable policy must never silently allow; everything is reviewed.
        logger.warning('privacy_policy_unavailable_using_review_defaults')
        return _complete(PrivacyPolicy())
    _cache = (time.monotonic() + CACHE_SECONDS, policy)
    return policy


def _detector(policy: dict):
    rules = [(rule['name'], [normalized(term) for term in rule['terms']]) for rule in policy['custom_rules']]

    def detect(text: str) -> set[str]:
        plain = normalized(text)
        return {name for name, terms in rules if any(term in plain for term in terms)}
    return detect


def decide(found, policy: dict) -> tuple[list[str], list[str]]:
    """Split findings into what can never leave and what a person must confirm."""
    custom = {rule['name']: rule['action'] for rule in policy['custom_rules']}
    blocked, ask = [], []
    for label in sorted(set(found)):
        action = custom.get(label) or policy['categories'].get(label, 'ask')
        if action == 'block':
            blocked.append(label)
        elif action == 'ask':
            ask.append(label)
    return blocked, ask


def review_text(text: str, channel: str, recipients=()) -> tuple[list[str], list[str]]:
    policy = load_policy()
    if not policy['channels'].get(channel, True):
        return [], []
    return decide(scan_text(text, recipients, _detector(policy)), policy)


def review_file(filename: str, data: bytes, channel: str, recipients=(), media_type: str = '') -> tuple[list[str], list[str]]:
    policy = load_policy()
    if not policy['channels'].get(channel, True):
        return [], []
    return decide(scan_file(filename, data, recipients, media_type, _detector(policy)), policy)


def review_arguments(arguments: dict, channel: str) -> tuple[list[str], list[str]]:
    policy = load_policy()
    if not policy['channels'].get(channel, True):
        return [], []
    return decide(scan_tool_arguments(arguments, _detector(policy)), policy)


def review_email(subject, body, recipients, markdown_attachment, attachments) -> tuple[list[str], list[str]]:
    policy = load_policy()
    if not policy['channels'].get('email', True):
        return [], []
    detector = _detector(policy)
    found = set(scan_text(subject + '\n' + body, recipients, detector))
    if markdown_attachment is not None:
        found.update(scan_text(markdown_attachment[1], recipients, detector))
    for filename, content, media_type in attachments or ():
        raw = content.encode('utf-8') if isinstance(content, str) else bytes(content)
        found.update(scan_file(filename, raw, recipients, media_type or '', detector))
    return decide(found, policy)


def raise_if_blocked(blocked) -> None:
    if blocked:
        raise PersonalDataBlocked(blocked)


def _public(policy: dict) -> dict:
    return {**policy, 'available_categories': list(CATEGORIES), 'available_channels': list(CHANNELS)}


@router.get('')
def get_policy(user=Depends(administrator)):
    return _public(load_policy())


@router.put('', dependencies=[Depends(same_origin)])
def save_policy(body: PrivacyPolicy, user=Depends(administrator)):
    global _cache
    config = _complete(body)
    with _connect() as db:
        _schema(db)
        db.execute('INSERT INTO bob_privacy_policy(id,config) VALUES (1,%s) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()', (Jsonb(config),))
        # Custom terms may themselves be sensitive, so the audit records only the change.
        db.execute('INSERT INTO bob_access_audit(actor,action,target) VALUES (%s,%s,%s)', (user['username'], 'configure-privacy-policy', 'privacy-policy'))
    _cache = (0.0, None)
    return _public(config)
