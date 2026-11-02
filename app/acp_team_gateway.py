"""Local compatibility adapter for Buddy ACP releases without --team-id.

Buddy signs method, path, body and timestamp. The configured team header is the
same routing header used by Buddy's supported headless --team-id argument.
"""
from __future__ import annotations

from app.branding import brand_text
import asyncio
import hmac
import json
import re
import socket
from contextlib import asynccontextmanager, contextmanager

import os
import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

UPSTREAM = os.getenv('BOB_API_UPSTREAM', 'https://api.us-east.bob.ibm.com').rstrip('/')
HOP_HEADERS = {'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'}


def gateway_app(team_id: str, api_key: str, client: httpx.AsyncClient) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    inference_upstream = UPSTREAM

    @app.api_route('/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    async def forward(request: Request, path: str):
        nonlocal inference_upstream
        # The adapter never accepts arbitrary destinations or unrelated keys.
        if not hmac.compare_digest(request.headers.get('authorization', ''), 'apikey ' + api_key):
            return Response(status_code=403)
        raw_path = request.scope['raw_path'].decode('ascii')
        if not raw_path.startswith(('/admin/v1/', '/inference/v1/', '/metrics-forwarder/', '/api/public/otel/', '/v1/orchestrate/')):
            return Response(status_code=404)
        query = request.scope.get('query_string', b'').decode('ascii')
        target = inference_upstream if raw_path.startswith('/inference/v1/') else UPSTREAM
        url = target + raw_path + ('?' + query if query else '')
        headers = {name: value for name, value in request.headers.items() if name.lower() not in HOP_HEADERS}
        headers['x-team-id'] = team_id
        outgoing = client.build_request(request.method, url, headers=headers, content=await request.body())
        if outgoing.url.raw_path != (raw_path + ('?' + query if query else '')).encode('ascii'):
            return Response(status_code=400)
        try:
            response = await client.send(outgoing, stream=True)
        except httpx.HTTPError:
            return Response(status_code=502)
        response_headers = {name: value for name, value in response.headers.items() if name.lower() not in HOP_HEADERS}
        if raw_path == '/admin/v1/profile' and response.status_code == 200:
            # Bob rewrites only the hostname for regional routing, retaining our
            # loopback port. Omit that optional transport hint to retain the
            # configured gateway. Account identities/limits are unchanged.
            try:
                payload = json.loads(await response.aread())
                instances = payload.get('instances', []) if isinstance(payload, dict) else []
                for instance in instances:
                    if not any(team.get('id') == team_id for team in instance.get('teams', [])):
                        continue
                    region = instance.get('region_domain')
                    if region:
                        host = region if region.startswith('api.') else 'api.' + region
                        if not re.fullmatch(r'api\.[a-z0-9-]+\.bob\.ibm\.com', host):
                            return Response(status_code=502)
                        inference_upstream = 'https://' + host
                    break
                def without_region(value):
                    if isinstance(value, dict):
                        return {key: without_region(item) for key, item in value.items() if key != 'region_domain'}
                    if isinstance(value, list):
                        return [without_region(item) for item in value]
                    return value
                for name in ('content-encoding', 'etag', 'content-md5', 'digest'):
                    response_headers.pop(name, None)
                return Response(json.dumps(without_region(payload)), status_code=200,
                    headers=response_headers)
            finally:
                await response.aclose()
        return StreamingResponse(response.aiter_raw(), status_code=response.status_code,
            headers=response_headers, background=BackgroundTask(response.aclose))

    return app


class LocalGatewayServer(uvicorn.Server):
    @contextmanager
    def capture_signals(self):
        yield

    def install_signal_handlers(self):
        pass


async def _cancel_gateway_tasks(task, server):
    # Drain child cancellation as a result while preserving cancellation of the
    # caller awaiting gather. Cancel requests before any cleanup can yield.
    tasks = [task, *server.server_state.tasks]
    for child in tasks:
        child.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@asynccontextmanager
async def team_gateway(team_id: str, api_key: str):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=30), follow_redirects=False) as client:
        server = LocalGatewayServer(uvicorn.Config(gateway_app(team_id, api_key, client),
            log_level='critical', access_log=False, lifespan='off', timeout_graceful_shutdown=1))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                if task.done():
                    await task
                    raise RuntimeError(brand_text('Buddy team adapter stopped before starting'))
                await asyncio.sleep(.01)
            else:
                raise RuntimeError(brand_text('Buddy team adapter failed to start'))
            yield f'http://127.0.0.1:{port}'
        finally:
            server.should_exit = True
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=3)
            except TimeoutError:
                await _cancel_gateway_tasks(task, server)
            except asyncio.CancelledError:
                await _cancel_gateway_tasks(task, server)
                raise
            finally:
                listener.close()
