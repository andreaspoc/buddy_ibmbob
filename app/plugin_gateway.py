"""Same-origin transport for optional Office and people-chat services.

This middleware supplies transport, never identity: core and upstream must both
validate the original authentication cookie. Leave URLs unset for embedded mode.
"""
import asyncio
import os
import inspect
from urllib.parse import urlsplit

import httpx
from starlette.responses import JSONResponse

_HOP = {b"connection", b"keep-alive", b"proxy-authenticate", b"proxy-authorization", b"te", b"trailer", b"transfer-encoding", b"upgrade"}
_IDENTITY = {b"forwarded", b"x-real-ip", b"remote-user", b"x-user", b"x-user-id", b"x-username", b"x-auth-user", b"x-auth-request-user", b"x-auth-request-email"}


def _headers(headers):
    connection = {v.strip().lower() for k, value in headers if k.lower() == b"connection" for v in value.split(b",")}
    return [(k, v) for k, v in headers if k.lower() not in _HOP | _IDENTITY | connection and (k.lower() == b"x-forwarded-proto" or not k.lower().startswith((b"x-forwarded-", b"x-buddy-", b"x-authenticated-")))]


def _enabled(env, name):
    if name == "BUDDY_DECISIONS_ENABLED":
        val = env.get("BUDDY_DECISIONS_ENABLED")
        if val is None:
            val = env.get("BUDDY_ZEN_ENABLED")
        if val is None:
            val = "1"
        return str(val).strip().lower() not in {"0", "false", "no", "off"}
    return env.get(name, "false").strip().lower() not in {"0", "false", "no", "off"}


class PluginGatewayMiddleware:
    def __init__(self, app, *, environ=None, transport=None, websocket_connect=None):
        self.app = app
        env = os.environ if environ is None else environ
        self.routes = []
        for name, prefixes in (("OFFICE", ("/api/office", "/office-editor", "/static/office", "/static/office-bridge")), ("PEOPLE", ("/api/community",)), ("PROJECTS", ("/api/projects",)), ("LEARNING", ("/api/learning",)), ("DECISIONS", ("/api/decisions",)), ("TETRAGON", ("/api/tetragon", "/tetragon"))):
            url = env.get(f"BUDDY_{name}_PLUGIN_URL", "").rstrip("/")
            if url:
                parsed = urlsplit(url)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                    raise ValueError(f"BUDDY_{name}_PLUGIN_URL must be an HTTP origin")
            self.routes.append((prefixes, url, _enabled(env, f"BUDDY_{name}_ENABLED")))
        self.transport = transport
        self.websocket_connect = websocket_connect

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        path = scope["path"]
        for prefixes, url, enabled in self.routes:
            if any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes):
                if not enabled:
                    if scope["type"] == "websocket":
                        return await send({"type": "websocket.close", "code": 1013})
                    return await JSONResponse({"detail": "Plugin is disabled"}, status_code=503)(scope, receive, send)
                if not url:
                    break
                if scope["type"] == "websocket":
                    return await self._websocket(url, scope, receive, send)
                return await self._http(url, scope, receive, send)
        return await self.app(scope, receive, send)

    @staticmethod
    def _url(base, scope):
        path = scope.get("raw_path", scope["path"].encode("utf-8"))
        query = scope.get("query_string", b"")
        return base + path.decode("ascii") + ("?" + query.decode("ascii") if query else "")

    async def _http(self, base, scope, receive, send):
        async def body():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise asyncio.CancelledError()
                if message.get("body"):
                    yield message["body"]
                if not message.get("more_body", False):
                    break
        started = False
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False, timeout=httpx.Timeout(30, read=None)) as client:
                async with client.stream(scope["method"], self._url(base, scope), headers=_headers(scope["headers"]), content=body()) as response:
                    headers = _headers(response.headers.raw)
                    # Internal absolute redirects must stay on the public origin.
                    safe_headers = []
                    for key, value in headers:
                        if key.lower() == b"location":
                            target = value.decode("latin-1")
                            parsed = urlsplit(target)
                            if parsed.netloc:
                                origin = urlsplit(base)
                                host = dict(scope["headers"]).get(b"host", b"").decode("latin-1")
                                if parsed.netloc == origin.netloc:
                                    value = ((parsed.path or "/") + ("?" + parsed.query if parsed.query else "") + ("#" + parsed.fragment if parsed.fragment else "")).encode("latin-1")
                                elif parsed.netloc != host:
                                    continue
                        safe_headers.append((key, value))
                    await send({"type": "http.response.start", "status": response.status_code, "headers": safe_headers})
                    started = True
                    async for chunk in response.aiter_raw():
                        await send({"type": "http.response.body", "body": chunk, "more_body": True})
                    await send({"type": "http.response.body", "body": b""})
        except httpx.HTTPError:
            if started:
                raise
            await JSONResponse({"detail": "Plugin service unavailable"}, status_code=503)(scope, receive, send)

    async def _websocket(self, base, scope, receive, send):
        if self.websocket_connect is None:
            from websockets.asyncio.client import connect
            connector = connect
        else:
            connector = self.websocket_connect
        from_context_error = (OSError, TimeoutError)
        try:
            from websockets.exceptions import ConnectionClosed, InvalidHandshake
            from_context_error += (ConnectionClosed, InvalidHandshake)
        except ImportError:
            pass
        if (await receive())["type"] != "websocket.connect":
            return
        headers = _headers(scope["headers"])
        origin = next((v.decode("latin-1") for k, v in headers if k.lower() == b"origin"), None)
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in headers if k.lower() not in {b"origin", b"sec-websocket-key", b"sec-websocket-version", b"sec-websocket-extensions", b"sec-websocket-protocol"}]
        parsed = urlsplit(base)
        public_host = dict(scope["headers"]).get(b"host", parsed.netloc.encode()).decode("latin-1")
        headers = [(k, v) for k, v in headers if k.lower() != "host"]
        url = self._url(("wss://" if parsed.scheme == "https" else "ws://") + public_host, scope)  # noqa: S5332
        options = {"host": parsed.hostname, "port": parsed.port or (443 if parsed.scheme == "https" else 80)}
        if parsed.scheme == "https":
            options["server_hostname"] = parsed.hostname
        if "proxy" in inspect.signature(connector).parameters:
            options["proxy"] = None
        accepted = False
        try:
            async with connector(url, additional_headers=headers, origin=origin, subprotocols=scope.get("subprotocols") or None, max_size=50 * 1024 * 1024, **options) as upstream:
                await send({"type": "websocket.accept", "subprotocol": upstream.subprotocol})
                accepted = True
                async def outward():
                    while True:
                        msg = await receive()
                        if msg["type"] == "websocket.disconnect":
                            await upstream.close()
                            return
                        await upstream.send(msg.get("text") if msg.get("text") is not None else msg.get("bytes", b""))
                async def inward():
                    async for payload in upstream:
                        await send({"type": "websocket.send", "text" if isinstance(payload, str) else "bytes": payload})
                tasks = [asyncio.create_task(outward()), asyncio.create_task(inward())]
                try:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except from_context_error:
            pass
        finally:
            await send({"type": "websocket.close", "code": 1000 if accepted else 1013})
