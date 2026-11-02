"""Purpose- and body-bound short-lived capabilities for internal app-agent reads."""
import hashlib
import json
import os
import time
import jwt
from fastapi import HTTPException


def secret():
    value = os.getenv('BUDDY_APP_AGENT_SECRET') or os.getenv('OFFICE_JWT_SECRET', '')
    if len(value) < 32:
        raise HTTPException(503, 'Internal app collaboration is not configured')
    return value


def encode(username, payload):
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
    now = int(time.time())
    token = jwt.encode({'sub': username, 'aud': 'buddy-project-agent-read', 'iat': now, 'exp': now + 60,
                        'body_sha256': hashlib.sha256(raw).hexdigest()}, secret(), algorithm='HS256')
    return raw, token


def verify(authorization, raw):
    try:
        if not authorization.startswith('Bearer '):
            raise ValueError('Missing capability')
        claims = jwt.decode(authorization[7:], secret(), algorithms=['HS256'], audience='buddy-project-agent-read',
                            options={'require': ['sub', 'iat', 'exp', 'body_sha256']})
        if not isinstance(claims['sub'], str) or not claims['sub'] or not 0 < claims['exp'] - claims['iat'] <= 60:
            raise ValueError('Invalid capability')
        if claims['body_sha256'] != hashlib.sha256(raw).hexdigest():
            raise ValueError('Invalid body')
        return claims['sub']
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(401, 'Invalid app collaboration capability') from None
