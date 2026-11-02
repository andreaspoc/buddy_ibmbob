"""One read-access rule shared by the Projects UI and internal agent handoffs."""
import os
from fastapi import HTTPException
from app import job_queue


def require_reader(user):
    if user.get('is_admin'):
        return user
    issuer = os.getenv('KEYCLOAK_ISSUER', '').strip().rstrip('/')
    with job_queue._connect() as db:
        if not issuer or not db.execute("SELECT to_regclass('public.bob_keycloak_identities') AS relation").fetchone()['relation']:
            raise HTTPException(403, 'Sign in with the configured Keycloak account')
        if not db.execute('SELECT 1 FROM bob_keycloak_identities WHERE username=%s AND issuer=%s', (user['username'], issuer)).fetchone():
            raise HTTPException(403, 'A verified Keycloak account is required')
    return user
