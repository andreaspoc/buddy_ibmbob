"""Reuse a process-local S3 connection pool across bounded download threads."""
from __future__ import annotations

import os
from threading import Lock

_lock = Lock()
_identity = None
_client = None


def client():
    import boto3
    from botocore.config import Config

    global _identity, _client
    endpoint = os.environ['BOB_S3_ENDPOINT']
    if not endpoint.startswith('https://'):
        raise ValueError('BOB_S3_ENDPOINT must use HTTPS')
    identity = (os.getpid(), *(os.getenv(name) for name in (
        'BOB_S3_ENDPOINT', 'BOB_S3_REGION', 'BOB_S3_ACCESS_KEY_ID',
        'BOB_S3_SECRET_ACCESS_KEY')))
    with _lock:
        if _identity == identity:
            return _client
        # Build an explicit Session under the lock: sessions themselves are not
        # thread-safe, but their clients can share connections across threads.
        created = boto3.session.Session().client(
            's3', endpoint_url=endpoint,
            region_name=os.getenv('BOB_S3_REGION') or None,
            aws_access_key_id=os.environ['BOB_S3_ACCESS_KEY_ID'],
            aws_secret_access_key=os.environ['BOB_S3_SECRET_ACCESS_KEY'],
            config=Config(max_pool_connections=32, connect_timeout=10,
                          read_timeout=120,
                          retries={'mode': 'standard', 'total_max_attempts': 3}))
        # Do not close a replaced pool while another request is still using it.
        _identity, _client = identity, created
        return created
