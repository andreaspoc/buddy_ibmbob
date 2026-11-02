"""Realm-scoped membership snapshots from already verified Keycloak ID tokens.

No request headers, display names or local profile flags confer group access.
Membership updates take effect on the user's next verified SSO login.
"""
import os


def realm():
    return os.getenv('KEYCLOAK_ISSUER', '').strip().rstrip('/')


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS bob_keycloak_group_sync (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, groups_present BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(issuer,subject),
        FOREIGN KEY(issuer,subject) REFERENCES bob_keycloak_identities(issuer,subject) ON DELETE CASCADE)''')
    db.execute('''CREATE TABLE IF NOT EXISTS bob_keycloak_group_memberships (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, group_path TEXT NOT NULL,
        PRIMARY KEY(issuer,subject,group_path),
        FOREIGN KEY(issuer,subject) REFERENCES bob_keycloak_identities(issuer,subject) ON DELETE CASCADE)''')
    db.execute('CREATE INDEX IF NOT EXISTS bob_keycloak_groups_path ON bob_keycloak_group_memberships(issuer,group_path)')


def valid_group_path(value):
    return (isinstance(value, str) and 1 < len(value) <= 512 and value.startswith('/')
            and not value.endswith('/') and not any(ord(c) < 32 or c == '\\' for c in value)
            and all(part not in ('', '.', '..') for part in value.split('/')[1:]))


def verified_groups(claims):
    values = claims.get('groups')
    if not isinstance(values, list) or len(values) > 1000 or not all(valid_group_path(v) for v in values):
        return [], False
    return sorted(set(values)), True


def sync(db, issuer, subject, claims):
    groups, present = verified_groups(claims)
    # Called in resolve_identity's transaction, after signature/issuer/nonce validation.
    db.execute('DELETE FROM bob_keycloak_group_memberships WHERE issuer=%s AND subject=%s', (issuer, subject))
    for group in groups:
        db.execute('INSERT INTO bob_keycloak_group_memberships(issuer,subject,group_path) VALUES(%s,%s,%s)', (issuer, subject, group))
    db.execute('''INSERT INTO bob_keycloak_group_sync(issuer,subject,groups_present) VALUES(%s,%s,%s)
        ON CONFLICT(issuer,subject) DO UPDATE SET groups_present=excluded.groups_present,updated_at=now()''', (issuer, subject, present))
