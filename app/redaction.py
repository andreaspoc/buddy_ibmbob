"""Credential masking for public tool activity, including shell command titles."""
import re

SENSITIVE = re.compile(r'key|token|secret|password|authorization|credential', re.I)
_CREDENTIAL_NAME = re.compile(r'api[_-]?key|token|secret|password|authorization|credential', re.I)
_NAME = re.compile(r'[\w-]+')
_ASSIGNMENT_VALUE = re.compile(r'''(["']?\s*[:=]\s*["']?)([^\s"'&,}]+)''')
_URL_USERINFO = re.compile(r'(https?://)([^/@\s]+)@')


def _mask_assignments(value):
    pieces, end = [], 0
    for name in _NAME.finditer(value):
        if name.start() < end or not _CREDENTIAL_NAME.search(name[0]):
            continue
        assignment = _ASSIGNMENT_VALUE.match(value, name.end())
        if assignment:
            pieces.append(value[end:assignment.start(2)])
            pieces.append('[redacted]')
            end = assignment.end()
    pieces.append(value[end:])
    return ''.join(pieces)


def _mask_userinfo(match):
    # Both username and password must be nonempty; either may contain colons.
    return match[1] + '[redacted]@' if ':' in match[2][1:-1] else match[0]


def redact(value, secrets=(), *, mask_sensitive_keys=True):
    if isinstance(value, dict):
        return {key: '[redacted]' if mask_sensitive_keys and SENSITIVE.search(str(key)) else redact(item, secrets, mask_sensitive_keys=mask_sensitive_keys)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, secrets, mask_sensitive_keys=mask_sensitive_keys) for item in value]
    if not isinstance(value, str):
        return value
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            value = value.replace(secret, '[redacted]')
    value = re.sub(r'(?i)(Bearer\s+)[^\s\'"\\]+', r'\1[redacted]', value)
    value = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted]', value)
    value = _mask_assignments(value)
    value = _URL_USERINFO.sub(_mask_userinfo, value)
    return value


def config_secrets(config):
    """Collect exact values too, covering opaque credentials under custom headers."""
    values = []
    for section in ('headers', 'env'):
        for value in config.get(section, {}).values():
            if isinstance(value, str) and len(value) >= 4:
                values.append(value)
                if value.lower().startswith('bearer '):
                    values.append(value[7:])
    return values
