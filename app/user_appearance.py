"""Each account's interface appearance, so it follows the person across sign-ins and devices."""
import re
from typing import Literal

from psycopg.types.json import Jsonb
from pydantic import BaseModel, field_validator

from app.auth import _connect

_NAME_MAX_LENGTH = 24


class Appearance(BaseModel):
    accent: str
    assistantName: str
    companyName: str
    theme: Literal['copilotkit', 'carbon']

    @field_validator('accent')
    @classmethod
    def _valid_accent(cls, value: str) -> str:
        if not re.fullmatch(r'#[\da-fA-F]{6}', value):
            raise ValueError('Use a six digit hex colour')
        return value.lower()

    @field_validator('assistantName', 'companyName')
    @classmethod
    def _valid_name(cls, value: str) -> str:
        # Same rule as the settings form: starts with a letter or number, then also spaces, hyphens and apostrophes.
        if not (0 < len(value) <= _NAME_MAX_LENGTH and value[0].isalnum() and all(c.isalnum() or c in " '-" for c in value)):
            raise ValueError('Use letters, numbers, spaces, hyphens or apostrophes')
        return value


def read_appearance(username: str) -> dict | None:
    with _connect() as db:
        row = db.execute('SELECT settings FROM bob_user_appearance WHERE username=%s', (username,)).fetchone()
    return row[0] if row else None


def write_appearance(username: str, appearance: Appearance) -> dict:
    settings = appearance.model_dump()
    with _connect() as db:
        db.execute('INSERT INTO bob_user_appearance(username,settings) VALUES (%s,%s) '
                   'ON CONFLICT (username) DO UPDATE SET settings=EXCLUDED.settings, updated_at=now()',
                   (username, Jsonb(settings)))
    return settings
