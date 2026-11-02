"""Execution-side approvals. Agent-authored flags and MCP hints grant no authority."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from datetime import datetime, timedelta, timezone

from app.redaction import redact

APP_READ_TOOLS = frozenset({
    'notes_list', 'notes_get', 'office_list', 'office_folders', 'office_read',
    'office_open', 'office_close', 'app_agents_list', 'app_agents_delegate',
})
BRAVE_READ_TOOLS = frozenset({
    'brave_web_search', 'fetch_web_page',
})
DISCOVERY_ACTIONS = frozenset({'servers', 'tools', 'capabilities', 'resources',
                               'templates', 'prompts', 'a2a_list'})
APPROVAL_SECONDS = 300
POLICY_VERSION = 'agent-execution-v1'


def action_digest(actor: str, payload: dict, target_config=None) -> str:
    """Bind configuration as well as normalized parameters; never log credentials."""
    encoded = json.dumps({'actor': actor, 'request': payload, 'target_config': target_config},
                         sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                         allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def requires_approval(payload: dict) -> bool:
    action = payload.get('action')
    if action in DISCOVERY_ACTIONS:
        return False
    if action == 'call' and payload.get('server') == 'buddy-app' and payload.get('tool') in APP_READ_TOOLS:
        return False
    if action == 'call' and payload.get('server') == 'brave_search' and payload.get('tool') in BRAVE_READ_TOOLS:
        return False
    # External tool annotations/names are not an authorization policy. Unknown
    # tools, writes and external agent disclosures are subject to the owner policy.
    return True


class ExecutionAuthorizer:
    def __init__(self, *, username, job_id, worker_token, emit, secrets=()):
        self.username = username
        self.job_id = str(job_id)
        self.worker_token = str(worker_token)
        self.emit = emit
        self.secrets = secrets

    async def assert_active(self):
        from app import job_queue
        await asyncio.to_thread(job_queue.assert_execution_active,
                                self.job_id, self.worker_token, self.username)

    async def authorize(self, payload: dict, target_config=None, *, force=False, personal_data=None):
        if not force and not requires_approval(payload):
            return
        if payload.get('action') == 'a2a_ask' and personal_data is None:
            from app import privacy_policy
            blocked, personal_data = await asyncio.to_thread(privacy_policy.review_text, str(payload.get('prompt') or ''), 'external_agent')
            privacy_policy.raise_if_blocked(blocked)
        if not self.username or not self.job_id or not self.worker_token or not self.emit:
            raise PermissionError('This action requires an active authenticated approval channel')
        from app import job_queue
        await self.assert_active()
        from app.approval_policy import review_required
        tool = payload.get('tool_call') if payload.get('action') == 'acp_permission' else {'kind': 'execute'}
        state = await asyncio.to_thread(job_queue.worker_approval_policy, self.job_id, self.worker_token)
        if not personal_data and not review_required(state['policy'], tool or {}):
            return
        digest = action_digest(self.username, payload, target_config)
        approval_id = str(uuid.uuid4())
        expires = datetime.now(timezone.utc) + timedelta(seconds=APPROVAL_SECONDS)
        target = payload.get('server') or payload.get('slug') or 'agent runtime'
        operation = payload.get('tool') or payload.get('action')
        event = {
            'type': 'approval', 'approval_id': approval_id, 'job_id': self.job_id,
            'title': f'Review {operation} on {target}',
            'detail': redact(payload, self.secrets), 'status': 'pending',
            'options': ['approve', 'reject'], 'tool': tool or {},
            'actor': self.username, 'action_digest': digest, 'policy_version': POLICY_VERSION,
            'expires_at': expires.isoformat(), 'scope': 'action',
        }
        if personal_data:
            from app.personal_data import is_email_tool
            subject = ('This email' if is_email_tool(payload.get('tool'))
                       else 'This request to an external agent' if payload.get('action') == 'a2a_ask'
                       else f"This action on {target}")
            event['title'] = subject + ' may contain personal data: ' + ', '.join(personal_data) + '. Send it anyway?'
            event['personal_data'] = list(personal_data)
            event['mandatory'] = True
        await asyncio.to_thread(job_queue.create_approval, self.job_id, self.worker_token, event)
        # No execution if durable creation or user-visible audit delivery fails.
        await self.emit(event)
        deadline = time.monotonic() + APPROVAL_SECONDS
        while time.monotonic() < deadline:
            await self.assert_active()
            await asyncio.to_thread(job_queue.auto_resolve_approval, self.job_id, self.worker_token, approval_id)
            decision = await asyncio.to_thread(job_queue.consume_execution_approval,
                self.job_id, self.worker_token, approval_id, self.username, digest)
            if decision is not None:
                approved = decision == 'approve'
                await self.emit({**event, 'status': 'approved' if approved else 'rejected'})
                if not approved:
                    raise PermissionError('Action approval was rejected or expired')
                return
            await asyncio.sleep(.25)
        raise PermissionError('Action approval expired')
