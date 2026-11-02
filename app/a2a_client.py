"""Small JSON-RPC A2A client for registered text agents."""

from __future__ import annotations

import asyncio
import os
import json
import uuid
import re
from urllib.parse import urlsplit, urlunsplit, urljoin

import httpx
from .safe_http import allowed_origins, async_transport, origin, validate_url as safe_validate_url

MAX_RESPONSE_BYTES = 2_000_000

def _allow_public_ports():
    """A2A-only flexibility; resolved private addresses still need exact grants."""
    return os.getenv('BOB_A2A_ALLOW_PUBLIC_PORTS', '0').strip().lower() in {'1', 'true', 'yes'}


def _trusted_hosts():
    if os.getenv('BOB_A2A_RELAXED_ORIGINS', '0').strip().lower() not in {'1', 'true', 'yes'}:
        return frozenset()
    return frozenset(entry[1] for entry in allowed_origins(os.getenv('BOB_A2A_ALLOWED_ORIGINS', '')))

def _approved_origins():
    origins = set()
    for env_var in ("BOB_A2A_ALLOWED_ORIGINS", "BOB_MCP_ALLOWED_ORIGINS", "BOB_ALLOWED_ORIGINS"):
        val = os.getenv(env_var, "").strip()
        if val:
            try:
                origins.update(allowed_origins(val))
            except Exception:
                pass
    for service_url_var in ("DOCMOST_URL", "BOB_INTERNAL_A2A_URL", "KEYCLOAK_ISSUER"):
        svc = os.getenv(service_url_var, "").strip()
        if svc:
            try:
                origins.add(origin(svc))
            except Exception:
                pass
    return frozenset(origins)

async def _bound_response(response):
    if "text/event-stream" in response.headers.get("content-type", ""):
        return
    chunks, size = [], 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise ValueError("Agent response exceeds download limit")
        chunks.append(chunk)
    response._content = b"".join(chunks)


def validate_mcp_url(url: str) -> str:
    """Preserve MCP's existing exact-origin policy regardless of A2A settings."""
    return safe_validate_url(url, _approved_origins())


def validate_url(url: str) -> str:
    try:
        return safe_validate_url(url, _approved_origins(), allow_public_ports=_allow_public_ports(),
                                 trusted_hosts=_trusted_hosts())
    except ValueError as exc:
        if str(exc) == 'Nonstandard web ports require an approved origin':
            scheme, host, port = origin(url)
            authority = f'[{host}]' if ':' in host else host
            raise ValueError(
                f'Nonstandard web ports require an approved origin: {scheme}://{authority}:{port}. '
                'Ask the deployment administrator to add this exact trusted origin to '
                'BOB_A2A_ALLOWED_ORIGINS and recreate the API and worker containers. '
                'The Agent Card and its advertised endpoint must each use an approved origin.'
            ) from exc
        raise


def _discovered_endpoint(endpoint: str, card_url: str) -> str:
    """Fix reverse-proxy HTTP advertisements only within the fetched HTTPS origin."""
    # Validate structure before comparing or reconstructing untrusted card URLs.
    origin(endpoint)
    if origin(card_url)[0] == 'https' and origin(endpoint)[0] == 'http':
        parts = urlsplit(endpoint)
        candidate = urlunsplit(parts._replace(scheme='https'))
        if origin(candidate) == origin(card_url):
            endpoint = candidate
    validate_url(endpoint)
    return endpoint


async def discover_agent(card_url: str, endpoint_override: str = "", *, bearer_token: str = "",
                         api_key: str = "", api_key_header: str = "x-api-key") -> dict[str, str]:
    validate_url(card_url)
    bearer_token = bearer_token.strip()
    if '\n' in bearer_token or '\r' in bearer_token:
        raise ValueError('Bearer token cannot contain line breaks')
    api_key = api_key.strip()
    if '\n' in api_key or '\r' in api_key:
        raise ValueError('API key cannot contain line breaks')
    api_key_header = api_key_header or 'x-api-key'
    if api_key and (not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", api_key_header)
                    or api_key_header.lower() in {'host', 'cookie', 'authorization', 'content-length'}):
        raise ValueError('Unsupported API key header')
    credential_origin = origin(card_url)
    if endpoint_override:
        validate_url(endpoint_override)
    async with httpx.AsyncClient(timeout=httpx.Timeout(12, connect=5), follow_redirects=False,
            trust_env=False, transport=async_transport(_approved_origins(), allow_public_ports=_allow_public_ports(), trusted_hosts=_trusted_hosts()),
            event_hooks={"response": [_bound_response]}) as client:
        current = card_url
        for _ in range(6):
            validate_url(current)
            # Discovery credentials never follow redirects to another origin,
            # even when that origin is independently approved for connections.
            headers = {'Authorization': f'Bearer {bearer_token}'} if bearer_token and origin(current) == credential_origin else {}
            if api_key and origin(current) == credential_origin:
                headers[api_key_header] = api_key
            response = await client.get(current, headers=headers)
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("Agent Card redirect has no destination")
                current = urljoin(current, location)
                continue
            response.raise_for_status()
            card = response.json()
            break
        else:
            raise ValueError("Too many Agent Card redirects")
    if not isinstance(card, dict):
        raise ValueError("Agent Card must be a JSON object")

    interfaces = card.get("supportedInterfaces") or []
    if interfaces:
        interface = next(
            (item for item in interfaces if isinstance(item, dict) and item.get("protocolBinding", "").upper() == "JSONRPC"),
            None,
        )
        if not interface:
            raise ValueError("Agent Card has no JSON-RPC interface")
        endpoint = interface.get("url")
        version = interface.get("protocolVersion", "1.0")
    else:
        if card.get("preferredTransport", "JSONRPC").upper() != "JSONRPC":
            raise ValueError("Agent Card does not prefer JSON-RPC")
        endpoint = card.get("url")
        version = card.get("protocolVersion", "0.3")

    # Normalize before network policy validation: an explicitly approved HTTPS
    # origin must not be rejected because its proxy advertises HTTP internally.
    # Explicit endpoint overrides retain their exact administrator-supplied URL.
    endpoint = endpoint_override or _discovered_endpoint(endpoint, current)
    validate_url(endpoint)

    # Detect API key security scheme if present
    api_key_header = "x-api-key"
    schemes = card.get("securitySchemes") or {}
    if isinstance(schemes, dict):
        for s_name, s_val in schemes.items():
            if isinstance(s_val, dict) and s_val.get("type") == "apiKey":
                api_key_header = s_val.get("name") or api_key_header
                break

    if not str(version).startswith(("0.3", "1.")):
        raise ValueError(f"A2A version {version} is not supported by this UI")
    return {
        "name": str(card.get("name") or "A2A agent"),
        "description": str(card.get("description") or ""),
        "card_url": card_url,
        "endpoint": endpoint,
        "protocol_version": str(version),
        "api_key_header": api_key_header,
        "streaming": bool(card.get("capabilities", {}).get("streaming")) if isinstance(card.get("capabilities"), dict) else False,
        "capabilities": card.get("capabilities") if isinstance(card.get("capabilities"), dict) else {},
        "skills": [{"id": str(skill.get("id", ""))[:200], "name": str(skill.get("name", ""))[:200],
                    "description": str(skill.get("description", ""))[:2000]}
                   for skill in (card.get("skills") if isinstance(card.get("skills"), list) else [])[:100] if isinstance(skill, dict)],
        "icon": str(card.get("iconUrl") or "")[:2000],
    }


def _text_parts(message: dict | None, *, separator: str = "\n") -> str:
    if not isinstance(message, dict):
        return ""
    values = []
    for part in message.get("parts", []):
        if not isinstance(part, dict):
            continue
        if isinstance(part.get("text"), str):
            values.append(part["text"])
        elif "data" in part:
            values.append("\n```json\n" + json.dumps(part["data"], ensure_ascii=False, indent=2) + "\n```\n")
        elif isinstance(part.get("file"), dict):
            # Preserve file references/content without silently downloading remote URLs.
            values.append("\n```json\n" + json.dumps({"file": part["file"]}, ensure_ascii=False, indent=2) + "\n```\n")
    return separator.join(values)


def _task_state(task):
    return str((task.get("status") or {}).get("state", "")).lower().removeprefix("task_state_").replace("_", "-")


STOP_STATES = {"completed", "failed", "canceled", "cancelled", "rejected", "input-required", "auth-required"}


async def _wait_for_remote_task(task, fetch_task, timeout, *, poll_interval=2):
    """Wait for a completion notification from bounded remote status requests.

    Non-streaming A2A agents require GetTask requests. Timers schedule those
    requests; only an RPC completion/error signals the waiting Event.
    """
    if _task_state(task) in STOP_STATES:
        return task
    if not task.get("id"):
        raise RuntimeError("Agent returned an unfinished task without an ID")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    completed = asyncio.Event()
    failure = None
    timer = None
    request = None
    closed = False

    def incomplete():
        return RuntimeError(f"Agent task {task['id']} is still {_task_state(task) or 'unknown'}; response is incomplete")

    def schedule():
        nonlocal timer
        timer = loop.call_later(min(poll_interval, max(0, deadline - loop.time())), start_request)

    def start_request():
        nonlocal request
        if not closed:
            request = asyncio.create_task(refresh())

    async def refresh():
        nonlocal task, failure
        try:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise incomplete()
            task = await asyncio.wait_for(fetch_task(task["id"]), remaining)
            if _task_state(task) in STOP_STATES:
                completed.set()
            elif not task.get("id"):
                raise RuntimeError("Agent returned an unfinished task without an ID")
            else:
                schedule()
        except asyncio.CancelledError as exc:
            if not closed:
                failure = exc
                completed.set()
            raise
        except Exception as exc:
            failure = exc
            completed.set()

    schedule()
    try:
        try:
            await asyncio.wait_for(completed.wait(), max(0, deadline - loop.time()))
        except asyncio.TimeoutError:
            raise incomplete() from None
        if failure is not None:
            raise failure
        return task
    finally:
        closed = True
        if timer is not None:
            timer.cancel()
        if request is not None:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)


def _result_text(result: dict) -> tuple[str, str | None, dict | None]:
    payload = result.get("task") or result.get("message") or result
    if not isinstance(payload, dict):
        return "", None, None
    if "parts" in payload:
        return _text_parts(payload), payload.get("contextId"), None

    task = payload
    text = "\n\n".join(value for artifact in task.get("artifacts") or []
                       if (value := _text_parts(artifact)))
    if not text:
        for message in reversed(task.get("history") or []):
            if message.get("role") in {"agent", "ROLE_AGENT"}:
                text = _text_parts(message)
                if text:
                    break
    if not text:
        text = _text_parts((task.get("status") or {}).get("message"))
    return text, task.get("contextId"), task


async def send_message(
    agent: dict[str, str], prompt: str, context_id: str | None = None,
    cookie: str | None = None, auth_token: str | None = None, on_event=None,
) -> dict[str, str | None]:
    version = agent["protocol_version"]
    is_v1 = version.startswith("1.")
    message = {
        "role": "ROLE_USER" if is_v1 else "user",
        "messageId": uuid.uuid4().hex,
        "parts": [{"text": prompt}] if is_v1 else [{"kind": "text", "text": prompt}],
    }
    if context_id:
        message["contextId"] = context_id
    method = "SendMessage" if is_v1 else "message/send"
    params = {
        "message": message,
        "configuration": {"returnImmediately": False} if is_v1 else {"blocking": True},
    }

    effective_token = auth_token or agent.get("auth_token")

    # Custom API key from agent config (e.g., x-api-key for Langflow or external services)
    custom_api_key = agent.get("api_key")
    custom_header_name = agent.get("api_key_header") or "x-api-key"

    request_timeout = min(900, max(0.001, float(os.getenv("BOB_REQUEST_TIMEOUT", "900"))))
    validate_url(agent["endpoint"])
    async with httpx.AsyncClient(timeout=httpx.Timeout(request_timeout, connect=5), follow_redirects=False,
            trust_env=False, transport=async_transport(_approved_origins(), allow_public_ports=_allow_public_ports(), trusted_hosts=_trusted_hosts()),
            event_hooks={"response": [_bound_response]}) as client:
        async def call(method_name: str, call_params: dict) -> dict:
            headers = {
                "Content-Type": "application/json",
                "A2A-Version": "1.0" if is_v1 else "0.3",
            }
            if cookie:
                headers["Cookie"] = cookie
            if effective_token:
                headers["Authorization"] = f"Bearer {effective_token}"
            if custom_api_key:
                headers[custom_header_name] = custom_api_key

            response = await client.post(
                agent["endpoint"],
                json={"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method_name, "params": call_params},
                headers=headers,
            )
            response.raise_for_status()
            body = response.json()
            if body.get("error"):
                error = body["error"]
                raise RuntimeError(str(error.get("message") or error))
            return body.get("result") or {}

        async def finish_task(task):
            async def fetch_task(task_id):
                result = await call("GetTask" if is_v1 else "tasks/get", {"id": task_id})
                _, _, updated = _result_text(result)
                if not updated:
                    raise RuntimeError("Agent returned an invalid task polling response")
                return updated

            task = await _wait_for_remote_task(task, fetch_task, request_timeout)
            if _task_state(task) in {"failed", "canceled", "cancelled", "rejected"}:
                raise RuntimeError(_text_parts((task.get("status") or {}).get("message")) or f"Agent task {_task_state(task)}")
            return task

        # Older saved registrations lack capabilities; discover them without
        # replaying a request that might already have started remote work.
        streaming = agent.get("streaming")
        if streaming is None and agent.get("card_url"):
            try:
                card_headers = {}
                if cookie: card_headers["Cookie"] = cookie
                if effective_token: card_headers["Authorization"] = f"Bearer {effective_token}"
                if custom_api_key: card_headers[custom_header_name] = custom_api_key
                validate_url(agent["card_url"])
                card = await client.get(agent["card_url"], headers=card_headers, timeout=12)
                card.raise_for_status()
                streaming = bool((card.json().get("capabilities") or {}).get("streaming"))
            except (httpx.HTTPError, ValueError):
                streaming = False
        # Transport selection must not depend on a UI callback: the CLI used
        # by Buddy benefits from the same streaming protocol as the sidebar.
        if streaming:
            async def emit(event):
                if on_event:
                    await on_event(event)

            headers = {"Content-Type": "application/json", "Accept": "text/event-stream",
                       "A2A-Version": "1.0" if is_v1 else "0.3"}
            if cookie: headers["Cookie"] = cookie
            if effective_token: headers["Authorization"] = f"Bearer {effective_token}"
            if custom_api_key: headers[custom_header_name] = custom_api_key
            state = StreamState(context_id)
            async with client.stream("POST", agent["endpoint"], headers=headers,
                    json={"jsonrpc": "2.0", "id": uuid.uuid4().hex,
                          "method": "SendStreamingMessage" if is_v1 else "message/stream",
                          "params": params}) as response:
                response.raise_for_status()
                if "text/event-stream" not in response.headers.get("content-type", ""):
                    body = json.loads(await response.aread())
                    if body.get("error"): raise RuntimeError(str(body["error"]))
                    text, new_context, task = _result_text(body.get("result") or {})
                    if task:
                        text, new_context, _ = _result_text(await finish_task(task))
                    await emit({"type": "delta", "text": text})
                    return {"text": text, "context_id": new_context or context_id}
                async for body in sse_messages(response):
                    for event in state.consume(body):
                        await emit(event)
                    if state.terminal:
                        break
            # Recover interrupted/incomplete streams only. A successful final
            # event already confirms completion; do not add another round trip
            # or wait for the HTTP connection to close after it.
            if state.task_id and (not state.terminal or not state.text):
                task = await finish_task(await call("GetTask" if is_v1 else "tasks/get", {"id": state.task_id}))
                for event in state.consume({"result": task}):
                    await emit(event)
            return {"text": state.text, "context_id": state.context_id}

        result = await call(method, params)
        text, new_context, task = _result_text(result)
        if task:
            task = await finish_task(task)
            text, new_context, _ = _result_text(task)

    if not text:
        state = (task.get("status") or {}).get("state") if task else ""
        text = f"Agent returned no text response. Task state: {state or 'unknown'}."
    return {"text": text, "context_id": new_context or context_id}


async def sse_messages(response):
    """Decode SSE frames, including multiline data and an unterminated last frame."""
    data = []
    size = 0
    async for line in response.aiter_lines():
        size += len(line.encode("utf-8"))
        if size > MAX_RESPONSE_BYTES:
            raise ValueError("Agent stream exceeds download limit")
        if line == "":
            if data:
                payload = "\n".join(data)
                data = []
                if payload != "[DONE]": yield json.loads(payload)
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data and "\n".join(data) != "[DONE]":
        yield json.loads("\n".join(data))


class StreamState:
    """Merge A2A artifact updates without losing whitespace or duplicating snapshots."""
    def __init__(self, context_id=None):
        self.context_id = context_id
        self.text = ""
        self.artifacts = {}
        self.task_id = None
        self.terminal = False

    def consume(self, body):
        if body.get("error"):
            raise RuntimeError(str(body["error"].get("message") or body["error"]))
        result = body.get("result") or {}
        payload = next((result[k] for k in ("artifactUpdate", "statusUpdate", "task", "message")
                        if isinstance(result.get(k), dict)), result)
        self.context_id = payload.get("contextId") or self.context_id
        self.task_id = payload.get("taskId") or (payload.get("id") if "status" in payload else None) or self.task_id
        events = []
        text = self.text
        def parts(item):
            return _text_parts(item, separator="")
        if "artifact" in payload:
            artifact = payload["artifact"]
            key = artifact.get("artifactId", "default")
            value = parts(artifact)
            self.artifacts[key] = (self.artifacts.get(key, "") if payload.get("append") else "") + value
            text = "\n\n".join(self.artifacts.values())
        elif "parts" in payload:
            text = parts(payload)
        elif payload.get("artifacts"):
            self.artifacts = {a.get("artifactId", str(i)): parts(a) for i, a in enumerate(payload["artifacts"])}
            text = "\n\n".join(self.artifacts.values())
        elif "history" in payload and not text:
            text, _, _ = _result_text(payload)
        status = payload.get("status") or {}
        if status:
            message = _text_parts(status.get("message"))
            state = _task_state(payload)
            self.terminal = state in STOP_STATES
            if state in {"failed", "canceled", "cancelled", "rejected"}:
                raise RuntimeError(message or f"Agent task {state}")
            if message:
                events.append({"type": "status", "message": message})
                if state in {"completed", "input-required", "input_required"} and not text:
                    text = message
        if text != self.text:
            events.append({"type": "delta", "text": text[len(self.text):] if text.startswith(self.text) else text,
                           "replace": not text.startswith(self.text)})
            self.text = text
        return events


async def stream_message(agent, prompt, context_id=None, **kwargs):
    """Expose callback streaming with bounded backpressure and cancellation."""
    from contextlib import suppress
    queue = asyncio.Queue(maxsize=64)
    async def produce():
        try:
            result = await send_message(agent, prompt, context_id, on_event=queue.put, **kwargs)
            await queue.put({"type": "a2a_result", **result})
        except Exception as error:
            await queue.put(error)
        else:
            await queue.put(None)
    task = asyncio.create_task(produce())
    try:
        while True:
            event = await queue.get()
            if event is None: break
            if isinstance(event, Exception): raise event
            yield event
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError): await task
