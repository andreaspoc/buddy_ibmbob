from __future__ import annotations

from app.branding import brand_name, brand_text
import asyncio
import json
import logging
import os
import re
import signal
import time
import uuid
from dataclasses import dataclass, field
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from acp import PROTOCOL_VERSION, spawn_agent_process, ClientSideConnection
from acp.interfaces import Client
from acp.schema import AgentMessageChunk, TextContentBlock

from app.knowledge_broker import knowledge_broker
from app.mcp_broker import mcp_broker
from app.redaction import redact
from app.agent_sandbox import sandbox_command

STREAM_LINE_LIMIT = 64 * 1024 * 1024
logger = logging.getLogger(__name__)


def _approval_error_detail(exc, secrets=()):
    """Expose bounded error metadata, excluding request/response payloads."""
    from app.redaction import redact
    provider_secrets = [os.getenv(name, '') for name in ('BOB_API_KEY', 'BOBSHELL_API_KEY')]
    secrets = [*provider_secrets, *secrets]
    data = getattr(exc, 'data', None)
    if isinstance(data, dict) and 'TeamUserNotFoundError' in str(data.get('details', '')):
        return (brand_text('The configured Buddy API key and team were not accepted. '
                'Check key membership in the configured team. No CLI fallback was run.'))
    if isinstance(data, dict):
        provider_detail = str(data.get('details', ''))
        if 'input_schema' in provider_detail and re.search(r'(?i)(invalid|not valid)', provider_detail):
            return ('An MCP tool has an invalid input schema; no action was started. '
                    'Ask an administrator to check the tool schema.')
    detail = str(exc)
    if detail.strip().lower() == 'internal error' and isinstance(data, dict):
        metadata = {name: value for name, value in data.items()
                    if name in {'details', 'message', 'code', 'name', 'type'}
                    and isinstance(value, (str, int, float))}
        if metadata:
            detail += ': ' + json.dumps(redact(metadata, secrets), ensure_ascii=False)
    return redact(detail, secrets)[:2000]


def _approval_stderr_detail(stderr, secrets=()):
    """Keep error diagnostics in server logs, never known prompts or credentials."""
    from app.redaction import redact
    provider_secrets = [os.getenv(name, '') for name in ('BOB_API_KEY', 'BOBSHELL_API_KEY')]
    text = redact(stderr.decode(errors='replace'), [*provider_secrets, *secrets])
    lines = [line for line in text.splitlines()
             if not re.search(r'(?i)\b(prompt|messages|request.body|rawInput|rawOutput)\b', line)]
    return '\n'.join(lines)[-2000:]


async def _capture_approval_stderr(stream):
    """Drain continuously without retaining unbounded child output."""
    tail = b''
    while chunk := await stream.read(4096):
        tail = (tail + chunk)[-8192:]
    return tail


# Only runtime configuration and the Bob provider credential cross this boundary.
# Do not add generic suffix matching or a configurable secret pass-through here.
BOB_CHILD_ENV_NAMES = frozenset({
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "BOBSHELL_API_KEY", "BOB_API_KEY",
    # The isolated a2a CLI must enforce the same administrator policy as the API.
    "BOB_A2A_ALLOWED_ORIGINS", "BOB_A2A_ALLOW_PUBLIC_PORTS", "BOB_A2A_RELAXED_ORIGINS",
})


def bob_child_environment(user_home: str | None, knowledge_socket: str, mcp_socket: str | None = None) -> dict[str, str]:
    env = {name: os.environ[name] for name in BOB_CHILD_ENV_NAMES if name in os.environ}
    env["HOME"] = user_home or os.environ.get("HOME", "/root")
    env["BOB_KNOWLEDGE_SOCKET"] = knowledge_socket
    if mcp_socket:
        env["BOB_MCP_SOCKET"] = mcp_socket
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    env["PYTHONUNBUFFERED"] = "1"
    # Tool children have no database access, so their messages need the name passed in.
    env["BUDDY_NAME"] = brand_name()
    env["NODE_OPTIONS"] = "--no-warnings"
    return env


async def _terminate_process_group(proc: asyncio.subprocess.Process, grace_seconds: float = 1) -> None:
    """Terminate Buddy and tool subprocesses created in its dedicated session."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    # Children may outlive the CLI parent, so always check the whole group.
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_seconds)
    except TimeoutError:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()


async def _stop_process_group(proc: asyncio.subprocess.Process, grace_seconds: float = 1) -> None:
    cleanup = asyncio.create_task(_terminate_process_group(proc, grace_seconds))
    try:
        await asyncio.shield(cleanup)
    except asyncio.CancelledError:
        await cleanup
        raise


def _visible_detail(value: Any, secrets=()) -> Any:
    from app.redaction import redact
    return redact(value, [*secrets, *[os.getenv(name, '') for name in ('BOB_API_KEY', 'BOBSHELL_API_KEY')]])


def _task_exists(db_path: Path, task_id: str | None) -> bool:
    """Check if task_id exists in Buddy's SQLite task store."""
    if not task_id or not db_path.is_file():
        return False
    try:
        import sqlite3
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            row = conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return bool(row)
    except Exception:
        return False


def _get_task_usage(db_path: Path, task_id: str | None) -> dict[str, Any]:
    """Extract cumulative reported token count and cost from Buddy's SQLite task store."""
    if not task_id or not db_path.is_file():
        return {}
    import time
    for attempt in range(4):
        try:
            import sqlite3
            # Usage is optional metadata. A locked task store must not hold
            # completion for SQLite's default five-second busy timeout.
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.1) as conn:
                from app.task_usage import read_usage
                usage = read_usage(conn, [task_id]).get(task_id)
                if usage:
                    return usage
        except Exception:
            pass
        if attempt < 3:
            time.sleep(0.08)
    return {}


@dataclass
class CaptureClient(Client):
    """Minimal ACP client used by the HTTP/A2A wrapper."""

    text_chunks: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)

    async def request_permission(
        self,
        session_id: str,
        tool_call: Any,
        options: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Tool-free completions have no approval channel. Refuse unexpected tools.
        return {"outcome": {"outcome": "cancelled"}}

    async def session_update(
        self,
        session_id: str,
        update: Any,
        **kwargs: Any,
    ) -> None:
        try:
            payload = update.model_dump(mode="json", exclude_none=True)
        except Exception:
            payload = {"repr": repr(update)}
        self.events.append(payload)

        if isinstance(update, AgentMessageChunk):
            content = update.content
            if isinstance(content, TextContentBlock):
                self.text_chunks.append(content.text)


@asynccontextmanager
async def approval_child_environment(user_home, knowledge_socket, mcp_socket=None):
    env = bob_child_environment(user_home, knowledge_socket, mcp_socket)
    from app.bob_key_settings import effective_key
    api_key = await asyncio.to_thread(effective_key)
    if not api_key:
        raise RuntimeError('No Bob API key is configured. An administrator can add one under Administration, Bob API key.')
    env.update(BOB_API_KEY=api_key, BOBSHELL_API_KEY=api_key)
    team = os.getenv('BOB_TEAM_ID', '').strip()
    if not team:
        yield env
        return
    from app.acp_team_gateway import team_gateway
    async with team_gateway(team, api_key) as gateway:
        # This override is process-local. Bob ACP doesn't persist command/env
        # gateway overrides to settings; account credentials remain unchanged.
        yield {**env, 'BOB_GATEWAY_URL': gateway}


@asynccontextmanager
async def approval_agent_process(client, workspace, child_env, *, disable_mcp: bool = False):
    """Isolate ACP tool children and use only the allowlisted Buddy environment."""
    cmd = ['bob', 'acp', '--trust', '--accept-license', '--disable-subagents', '--log-level', 'warn']
    if disable_mcp:
        cmd.append('--disable-mcp')
    cmd = sandbox_command(cmd, workspace=workspace, environment=child_env)
    proc = await asyncio.create_subprocess_exec(*cmd,
        cwd=workspace, env=child_env, start_new_session=True,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        limit=STREAM_LINE_LIMIT)
    stderr_task = asyncio.create_task(_capture_approval_stderr(proc.stderr))
    conn = ClientSideConnection(client, proc.stdin, proc.stdout)
    try:
        yield conn, proc
    finally:
        try:
            try:
                await asyncio.wait_for(conn.close(), timeout=1)
            except TimeoutError:
                logger.warning('ACP connection close timed out; stopping agent process group')
        finally:
            await _stop_process_group(proc)
            proc.approval_stderr = await stderr_task


@dataclass
class ApprovalClient(CaptureClient):
    policy: dict = field(default_factory=dict)
    job_id: str = ''
    worker_token: str = ''
    policy_revision: int = -1
    guidance_interrupt: bool = False
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    activity_secrets: list[str] = field(default_factory=list)

    @staticmethod
    def payload(value):
        return value.model_dump(mode='json', by_alias=True, exclude_none=True) if hasattr(value, 'model_dump') else dict(value)

    async def session_update(self, session_id, update, **kwargs):
        await super().session_update(session_id, update, **kwargs)
        payload = self.payload(update)
        kind = payload.get('sessionUpdate', payload.get('session_update'))
        if kind == 'agent_message_chunk':
            content = payload.get('content', {})
            if content.get('type') == 'text':
                await self.queue.put({'type': 'delta', 'text': content.get('text', '')})
        elif kind in {'tool_call', 'tool_call_update'}:
            await self.queue.put({'type': 'tool', 'id': payload.get('toolCallId'),
                'name': _visible_detail(payload.get('title', 'Tool'), self.activity_secrets), 'status': payload.get('status', 'started'),
                'input': _visible_detail(payload.get('rawInput'), self.activity_secrets), 'output': _visible_detail(payload.get('rawOutput'), self.activity_secrets)})

    async def refresh_policy(self):
        from app import job_queue
        state = await asyncio.to_thread(job_queue.worker_approval_policy, self.job_id, self.worker_token)
        self.policy = state['policy']
        self.policy_revision = state['revision']

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        from app.approval_policy import review_required, once_option
        from app.execution_policy import ExecutionAuthorizer
        tool = self.payload(tool_call)
        available = [self.payload(option) for option in options]
        option_id = once_option(available)
        if not option_id:
            return {'outcome': {'outcome': 'cancelled'}}
        await self.refresh_policy()
        if self.guidance_interrupt:
            return {'outcome': {'outcome': 'cancelled'}}
        budget = getattr(self, 'execution_budget', None)
        if budget is not None:
            await budget.consume('tool')
        if not review_required(self.policy, tool):
            try:
                await ExecutionAuthorizer(username=getattr(self, 'actor_username', ''),
                    job_id=self.job_id, worker_token=self.worker_token,
                    emit=self.queue.put).assert_active()
            except PermissionError:
                return {'outcome': {'outcome': 'cancelled'}}
            return {'outcome': {'outcome': 'selected', 'optionId': option_id}}
        authorizer = ExecutionAuthorizer(username=getattr(self, 'actor_username', ''),
            job_id=self.job_id, worker_token=self.worker_token, emit=self.queue.put,
            secrets=self.activity_secrets)
        try:
            await authorizer.authorize({'action': 'acp_permission', 'session_id': session_id,
                                       'tool_call': tool}, force=True)
        except PermissionError:
            return {'outcome': {'outcome': 'cancelled'}}
        if self.guidance_interrupt:
            return {'outcome': {'outcome': 'cancelled'}}
        try:
            await authorizer.assert_active()
        except PermissionError:
            return {'outcome': {'outcome': 'cancelled'}}
        return {'outcome': {'outcome': 'selected', 'optionId': option_id}}


async def prompt_with_guidance(conn, session_id, prompt, client, job):
    """Cancel at an ACP checkpoint before continuing with new notes in the same session."""
    from app import chat_guidance
    client.guidance_interrupt = False
    pending = asyncio.create_task(conn.prompt(session_id=session_id, prompt=[TextContentBlock(type='text', text=prompt)]))
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=.5)
            if done:
                return pending.result(), False
            notes = await asyncio.to_thread(chat_guidance.instructions, str(job['id']), pending=True)
            if notes:
                client.guidance_interrupt = True
                await client.queue.put({'type': 'status', 'message': 'Pausing to apply your guidance…'})
                await conn.cancel(session_id=session_id)
                response = await asyncio.wait_for(pending, timeout=30)
                return response, True
    finally:
        if not pending.done():
            pending.cancel()
        # Child cancellation is expected; caller cancellation must propagate.
        await asyncio.gather(pending, return_exceptions=True)


class BobACPBridge:
    """
    Spawns one isolated Buddy subprocess per request, preferring ACP.

    This is intentionally simple for a test/development deployment:
      - no shared session state between HTTP calls
      - safe process cleanup after every call
      - concurrent HTTP requests do not share Buddy sessions
    """

    def __init__(self) -> None:
        self._approval_warmups = {}
        self.workspace = os.getenv("BOB_WORKSPACE", "/workspace")
        self.timeout_seconds = float(os.getenv("BOB_REQUEST_TIMEOUT", "900"))
        self.presentation_timeout_seconds = float(os.getenv("BOB_PRESENTATION_TIMEOUT", "1800"))

    @staticmethod
    def _team_args() -> list[str]:
        team_id = os.getenv("BOB_TEAM_ID", "").strip()
        return ["--team-id", team_id] if team_id else []

    @staticmethod
    def _requested_mcp_servers(payload: dict, available_servers: dict) -> list[str] | None:
        """Return configured MCP servers allowed for this session."""
        if not payload or not available_servers:
            return None
        return list(available_servers.keys())

    @classmethod
    def _payload_needs_mcp(cls, payload: dict) -> bool:
        if not payload:
            return False
        if payload.get('research') or payload.get('workflow'):
            return True
        skill_names = [s.lower() for s in ([payload.get('skill_name')] if payload.get('skill_name') else []) + payload.get('skill_names', [])]
        if any(s in {'research-buddy', 'build-mcp-server', 'configure-mcp'} for s in skill_names):
            return True
        prompt = payload.get('prompt', '').lower()
        mcp_keywords = {'mcp', 'deepwiki', 'docmost', 'monday', 'brave', 'search the web', 'web search', 'online search', 'browse the web', 'google', 'smtp', 'send email', 'send an email'}
        return any(k in prompt for k in mcp_keywords)

    async def stream(
        self, prompt: str, session_id: str | None = None, mode: str = "agent",
        workspace: str | None = None, user_home: str | None = None,
        shutdown_grace: float = 1, username: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        from app.app_actions import action_context
        context = action_context.get() or {}
        job = context.get('job')
        if job is not None:
            if job.get('username') != username:
                raise PermissionError('Agent job owner mismatch')
            # Research/workflow phases use the same permission callbacks as chat.
            # Never fall back to a noninteractive CLI with shell authority.
            phase_job = {**job, 'payload': {**job['payload'], 'session_id': session_id}}
            client = ApprovalClient(policy=phase_job['payload'].get('approval_policy', {}),
                                    job_id=str(job['id']), worker_token=str(job['worker_token']))
            submitted = asyncio.get_running_loop().create_future()
            submitted.set_result(prompt)
            task = asyncio.create_task(self._run_approval_runtime(client, submitted, phase_job,
                workspace=workspace or self.workspace, user_home=user_home, mode=mode))
            try:
                yield {'type': 'start'}
                while True:
                    event = await client.queue.get()
                    yield event
                    if event['type'] in {'done', 'error'}:
                        break
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            return
        raise PermissionError('Agent streaming requires an authenticated queued job with execution approvals')

    @staticmethod
    def _approval_identity(job, workspace, user_home, mode):
        return (str(job['id']), str(job['worker_token']), job['username'],
                job['workspace_id'], str(workspace), str(user_home), mode)

    def prewarm_approval(self, job: dict, *, workspace: str, user_home: str, mode: str = 'agent'):
        """Initialize the isolated process while its own job prepares context.

        HOME, brokers and tools remain scoped to this attempt's scratch tree. We
        deliberately do not pool them across jobs: those directories are removed
        and permissions/configuration may change between requests.
        """
        from app.agent_warmup import AgentWarmup
        if job['payload'].get('research') or job['payload'].get('workflow') or job['payload'].get('agent_name'):
            return None
        identity = self._approval_identity(job, workspace, user_home, mode)
        key = str(job['id'])
        existing = self._approval_warmups.get(key)
        if existing:
            if existing.identity != identity:
                raise RuntimeError('Prepared agent identity changed')
            return existing
        client = ApprovalClient(policy=job['payload']['approval_policy'], job_id=key,
                                worker_token=str(job['worker_token']))
        warmup = AgentWarmup(identity, client, asyncio.get_running_loop().create_future())
        warmup.task = asyncio.create_task(self._run_approval_runtime(
            client, warmup.prompt, job, workspace=workspace, user_home=user_home, mode=mode))
        self._approval_warmups[key] = warmup
        return warmup

    async def release_prepared(self, job_id):
        warmup = self._approval_warmups.pop(str(job_id), None)
        if warmup:
            await warmup.close()

    async def _run_approval_runtime(self, client, prompt_future, job, *, workspace, user_home, mode):
        limit = self.presentation_timeout_seconds if mode == 'presentation' else self.timeout_seconds
        try:
            async with asyncio.timeout(limit):
                await self._execute_approval_runtime(client, prompt_future, job,
                    workspace=workspace, user_home=user_home, mode=mode)
        except TimeoutError:
            await client.queue.put({'type': 'error', 'message': 'Agent execution time limit reached'})

    async def _execute_approval_runtime(self, client, prompt_future, job, *, workspace, user_home, mode):
        started_at = time.monotonic()
        bob_session_id = None
        proc = None
        prompt = current_prompt = ''
        try:
            from app.mcp_access import allowed_servers
            from app.redaction import config_secrets
            configs = await asyncio.to_thread(allowed_servers, job['username'])
            from app.bob_key_settings import effective_key
            client.activity_secrets = [await asyncio.to_thread(effective_key), *[secret for config in configs.values() for secret in config_secrets(config)]]
            from app.execution_policy import ExecutionAuthorizer
            from app.agent_budget import RunBudget
            from app.app_actions import action_context
            context = action_context.get() or {}
            client.actor_username = job['username']
            client.execution_budget = context.get('agent_budget') or RunBudget(job['username'])
            if client.execution_budget.username != job['username']:
                raise PermissionError('Agent budget owner mismatch')
            authorizer = ExecutionAuthorizer(username=job['username'], job_id=job['id'],
                worker_token=job['worker_token'], emit=client.queue.put, secrets=client.activity_secrets)
            requested = self._requested_mcp_servers(job.get('payload', {}), configs)
            disable_mcp = (requested is None)
            active_servers = requested if requested is not None else []
            await client.queue.put({'type': 'status', 'message': brand_text('Preparing Buddy…')})
            async with knowledge_broker(client.queue, username=job['username'], budget=client.execution_budget) as socket, mcp_broker(username=job['username'], workspace=workspace, user_home=user_home, active_servers=active_servers, lazy_native=True, allowed_agents=job.get('payload', {}).get('agent_slugs', ()), authorize=authorizer.authorize, assert_active=authorizer.assert_active, budget=client.execution_budget) as mcp_socket, approval_child_environment(user_home, socket, mcp_socket) as child_env:
                client.activity_secrets.append(child_env['BOB_API_KEY'])
                async with approval_agent_process(client, workspace, child_env, disable_mcp=disable_mcp) as (conn, proc):
                    await client.queue.put({'type': 'timing', 'phase': 'agent_process_started', 'elapsed_ms': round((time.monotonic() - started_at) * 1000)})
                    await conn.initialize(protocol_version=PROTOCOL_VERSION)
                    target_session_id = job.get('payload', {}).get('session_id')
                    db_path = (Path(user_home) if user_home else Path("/root")) / ".bob" / "db" / "bob.db"
                    session = None
                    resumed = False
                    if target_session_id and _task_exists(db_path, target_session_id):
                        try:
                            session = await conn.resume_session(session_id=target_session_id, cwd=workspace)
                            bob_session_id = target_session_id
                            resumed = True
                        except Exception as exc:
                            logger.warning('Failed to resume ACP session %s: %s; falling back to new session', target_session_id, exc)
                    if not resumed or not session:
                        session = await conn.new_session(cwd=workspace, mcp_servers=[])
                        bob_session_id = session.session_id
                    if not resumed and mode not in {'agent', 'presentation'}:
                        await conn.set_session_mode(session_id=session.session_id, mode_id=mode)
                    await client.queue.put({'type': 'timing', 'phase': 'agent_ready', 'elapsed_ms': round((time.monotonic() - started_at) * 1000)})
                    current_prompt = await asyncio.wait_for(asyncio.shield(prompt_future), timeout=self.timeout_seconds)
                    await client.queue.put({'type': 'timing', 'phase': 'prompt_submitted', 'elapsed_ms': round((time.monotonic() - started_at) * 1000)})
                    prompt = current_prompt
                    from app import chat_guidance
                    supports_guidance = chat_guidance.supported(job['payload'])
                    if supports_guidance:
                        await asyncio.to_thread(chat_guidance.open_intake, str(job['id']), str(job['worker_token']))
                    while True:
                        await client.execution_budget.consume('inference')
                        notes = await asyncio.to_thread(chat_guidance.instructions, str(job['id']), pending=True) if supports_guidance else []
                        if notes:
                            current_prompt += '\n\n[User instructions for this task]\n' + '\n'.join(note['instruction'] for note in notes)
                            await asyncio.to_thread(chat_guidance.applied, str(job['id']), str(job['worker_token']), [note['id'] for note in notes])
                            for note in notes:
                                await client.queue.put({'type': 'guidance', 'id': note['id'], 'text': note['instruction'], 'status': 'applied'})
                        if supports_guidance:
                            response, interrupted = await prompt_with_guidance(conn, session.session_id, current_prompt, client, job)
                        else:
                            response = await conn.prompt(session_id=session.session_id, prompt=[TextContentBlock(type='text', text=current_prompt)])
                            interrupted = False
                        if interrupted:
                            await client.queue.put({'type': 'delta', 'text': '', 'replace': True})
                            current_prompt = 'Continue this same task after the guidance checkpoint using saved work. Inspect the workspace and do not repeat completed external actions. Apply the new instructions and provide the updated answer.'
                            continue
                        reason = getattr(response, 'stop_reason', None)
                        if reason in {'cancelled', 'refusal'}:
                            usage = await asyncio.to_thread(_get_task_usage, Path(user_home) / '.bob' / 'db' / 'bob.db', bob_session_id)
                            await client.queue.put({'type': 'error', 'message': 'Agent action was cancelled or refused', 'session_id': bob_session_id, **usage})
                            break
                        if not supports_guidance or await asyncio.to_thread(chat_guidance.close_if_ready, str(job['id']), str(job['worker_token'])):
                            usage = await asyncio.to_thread(_get_task_usage, Path(user_home) / '.bob' / 'db' / 'bob.db', session.session_id)
                            await client.queue.put({'type': 'done', 'session_id': session.session_id, **usage})
                            break
                        await client.queue.put({'type': 'status', 'message': 'Applying your guidance…'})
                        current_prompt = 'Continue this same task using the saved workspace. Apply the new instructions below and provide an updated answer. Avoid repeating completed external actions.'
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            secrets = [*client.activity_secrets, prompt, current_prompt]
            detail = _approval_error_detail(exc, secrets)
            diagnostic = _approval_stderr_detail(getattr(proc, 'approval_stderr', b''), secrets)
            logger.warning('Human approval execution failed: %s%s', detail,
                           '\nACP stderr: ' + diagnostic if diagnostic else '')
            usage = await asyncio.to_thread(_get_task_usage, Path(user_home) / '.bob' / 'db' / 'bob.db', bob_session_id)
            await client.queue.put({'type': 'error', 'message': f'Human approval execution stopped: {detail}', **({'session_id': bob_session_id} if bob_session_id else {}), **usage})

    @staticmethod
    async def _prepared_event(warmup):
        try:
            return warmup.client.queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        receive = asyncio.create_task(warmup.client.queue.get())
        try:
            done, _ = await asyncio.wait({receive, warmup.task}, return_when=asyncio.FIRST_COMPLETED)
            if receive in done:
                return receive.result()
            # Drain events queued as the owner exited before reporting a broken
            # stream. Never retry a prompt whose tools may have already run.
            if not warmup.client.queue.empty():
                return warmup.client.queue.get_nowait()
            return {'type': 'error', 'message': 'Agent stopped before completing its response'}
        finally:
            receive.cancel()
            await asyncio.gather(receive, return_exceptions=True)

    async def stream_with_approvals(self, prompt: str, job: dict, *, workspace: str, user_home: str,
                                    mode: str = 'agent') -> AsyncIterator[dict[str, Any]]:
        """Use this attempt's prepared ACP connection, retaining tool approvals."""
        warmup = self.prewarm_approval(job, workspace=workspace, user_home=user_home, mode=mode)
        if warmup is None:
            raise RuntimeError('Selected approvals are unavailable for this workflow; no action was started')
        warmup.submit(self._approval_identity(job, workspace, user_home, mode), prompt)
        try:
            yield {'type': 'start'}
            while True:
                event = await self._prepared_event(warmup)
                yield event
                if event['type'] in {'done', 'error'}:
                    return
        finally:
            await self.release_prepared(job['id'])

    async def ask(self, prompt: str, workspace: str | None = None, user_home: str | None = None, *, username: str | None = None) -> dict[str, Any]:
        from app.agent_budget import RunBudget
        from app.app_actions import action_context
        context = action_context.get() or {}
        budget = context.get('agent_budget') or RunBudget(username)
        if budget.username != username:
            raise PermissionError('Agent budget owner mismatch')
        await budget.consume('inference')
        async with knowledge_broker(username=username, budget=budget) as socket, mcp_broker(username=username, workspace=workspace or self.workspace, user_home=user_home, budget=budget) as mcp_socket, approval_child_environment(user_home, socket, mcp_socket) as environment:
            return await self._ask(prompt, workspace, user_home, environment)

    async def _stream(
        self, prompt: str, session_id: str | None = None, mode: str = "agent",
        workspace: str | None = None, user_home: str | None = None,
        shutdown_grace: float = 1, child_env: dict[str, str] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Legacy headless tool execution is disabled; use queued ACP streaming."""
        raise PermissionError('Headless agent execution is disabled; use execution approvals')
        yield  # noqa: S1763 - intentional: preserves the async-generator contract for callers expecting an async iterator

    async def _ask_via_cli(self, prompt: str, workspace: str | None = None, user_home: str | None = None, child_env: dict[str, str] | None = None) -> dict[str, Any]:
        raise PermissionError('CLI authentication fallback is disabled; configure the ACP gateway')

    async def _ask(self, prompt: str, workspace: str | None = None, user_home: str | None = None, child_env: dict[str, str] | None = None) -> dict[str, Any]:
        if not child_env or not (child_env.get("BOBSHELL_API_KEY") or child_env.get("BOB_API_KEY")):
            raise RuntimeError(
                "No Bob API key is configured. An administrator can add one under Administration, Bob API key."
            )

        client = CaptureClient()

        async def _run() -> dict[str, Any]:
            # The OS sandbox confines the runtime; this tool-free client denies
            # permission requests rather than automatically authorizing actions.
            #
            # --accept-license makes first boot non-interactive. By starting this
            # image you are choosing to accept the IBM Bob ACP license; review it
            # first with: docker compose run --rm bob-agent bob --show-license acp
            try:
                command = sandbox_command(['bob', 'acp', '--trust',
                    '--accept-license', '--log-level', 'warn'],
                    workspace=workspace or self.workspace, environment=child_env)
                async with spawn_agent_process(
                    client, *command,
                    cwd=workspace or self.workspace,
                    env=child_env,
                ) as (conn, _proc):
                    await conn.initialize(protocol_version=PROTOCOL_VERSION)
                    session = await conn.new_session(
                        cwd=workspace or self.workspace,
                        mcp_servers=[],
                    )
                    response = await conn.prompt(
                        session_id=session.session_id,
                        prompt=[TextContentBlock(type="text", text=prompt)],
                    )

                    try:
                        prompt_response = response.model_dump(
                            mode="json", exclude_none=True
                        )
                    except Exception:
                        prompt_response = {"repr": repr(response)}

                    return {
                        "session_id": session.session_id,
                        "text": "".join(client.text_chunks).strip(),
                        "prompt_response": prompt_response,
                        "events": client.events,
                    }
            except Exception:
                # Authentication failure must not downgrade to auto-executing CLI.
                raise

        return await asyncio.wait_for(_run(), timeout=self.timeout_seconds)
