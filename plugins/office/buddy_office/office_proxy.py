"""Same-origin proxy for the Office editor, including its websocket transport."""
import asyncio
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter, Request, HTTPException, WebSocket, WebSocketDisconnect
from starlette.responses import StreamingResponse, JSONResponse
from starlette.background import BackgroundTask
from buddy_office.office import internal_url

router = APIRouter()
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization'}


NATIVE_AI_GUID = '9DC93CDB-B576-4F0C-B55E-FCC9C48DD007'


def without_native_ai(catalog):
    """Retain other vendor plugins; omit the bundled AI catalog and autostart."""
    if not isinstance(catalog, dict):
        raise ValueError('Invalid Office plugin catalog')
    result = dict(catalog)
    for key in ('pluginsData', 'autostart'):
        if key in result:
            if not isinstance(result[key], list):
                raise ValueError('Invalid Office plugin list')
            result[key] = [value for value in result[key]
                           if isinstance(value, str) and NATIVE_AI_GUID not in value.upper()
                           and '/ai/' not in value.lower()]
    return result


def headers(request):
    result = {key: value for key, value in request.headers.items() if key.lower() not in HOP}
    result['x-forwarded-host'] = request.headers.get('host', '') + '/office-editor'
    result['x-forwarded-proto'] = request.headers.get('x-forwarded-proto', request.url.scheme)
    return result


def allowed(path):
    return path.split('/')[0] not in ('example', 'info', 'command', 'coauthoring', 'converter', 'ConvertService.ashx', 'docbuilder', 'hosting', 'healthcheck')


@router.api_route('/office-editor/{path:path}', methods=['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'])
async def proxy(path: str, request: Request):
    if not allowed(path) or '..' in path or '\\' in path:
        raise HTTPException(404)
    # Docs 9.3 does not implement editorConfig.plugins.disable. Filter the
    # server catalog as well, so the vendor AI UI cannot compete with Ask Bob.
    if NATIVE_AI_GUID in path.upper():
        raise HTTPException(404)
    if request.method in ('GET', 'HEAD') and path.endswith(('header-logo_s.svg', 'dark-logo_s.svg', 'logo_s.svg', 'logo-white_s.svg', 'logo.svg')):
        from starlette.responses import Response
        return Response(
            content='<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
            media_type='image/svg+xml',
            headers={'Cache-Control': 'no-store'},
        )
    if request.method in ('GET', 'HEAD') and (path == 'plugins.json' or path.endswith('/plugins.json')):
        async with httpx.AsyncClient(timeout=10) as plugin_client:
            try:
                upstream = await plugin_client.get(internal_url() + '/' + path)
                upstream.raise_for_status()
                catalog = without_native_ai(upstream.json())
            except (httpx.HTTPError, ValueError):
                raise HTTPException(503, 'Office plugins are starting or unavailable')
        return JSONResponse(catalog, headers={'Cache-Control': 'no-store'})
    http = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10), follow_redirects=False)
    target = internal_url() + '/' + path
    if request.url.query:
        target += '?' + request.url.query
    try:
        upstream = await http.send(http.build_request(request.method, target, headers=headers(request), content=request.stream()), stream=True)
    except httpx.HTTPError:
        await http.aclose()
        raise HTTPException(503, 'Office editor is starting or unavailable')
    async def cleanup():
        await upstream.aclose()
        await http.aclose()
    response_headers = {key: value for key, value in upstream.headers.items() if key.lower() not in HOP | {'content-encoding', 'content-length'}}
    # Stream raw bytes, preserving compression and size when supplied.
    for key in ('content-encoding', 'content-length'):
        if key in upstream.headers:
            response_headers[key] = upstream.headers[key]
    return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code,
                             headers=response_headers, background=BackgroundTask(cleanup))


@router.websocket('/office-editor/{path:path}')
async def socket_proxy(socket: WebSocket, path: str):
    import websockets
    origin = socket.headers.get('origin')
    if origin and urlsplit(origin).netloc != socket.headers.get('host'):
        await socket.close(code=1008)
        return
    if not allowed(path) or '..' in path or '\\' in path:
        await socket.close(code=1008)
        return
    target = internal_url().replace('http://', 'ws://', 1).replace('https://', 'wss://', 1) + '/' + path  # noqa: S5332
    if socket.url.query:
        target += '?' + socket.url.query
    try:
        async with websockets.connect(target, origin=origin, additional_headers={
            'X-Forwarded-Host': socket.headers.get('host', '') + '/office-editor',
            'X-Forwarded-Proto': socket.headers.get('x-forwarded-proto', 'http')}, max_size=MAX_WS_BYTES) as upstream:
            await socket.accept()
            async def browser_to_editor():
                while True:
                    message = await socket.receive()
                    if message['type'] == 'websocket.disconnect':
                        return
                    await upstream.send(message.get('bytes') if message.get('bytes') is not None else message['text'])
            async def editor_to_browser():
                async for message in upstream:
                    if isinstance(message, bytes):
                        await socket.send_bytes(message)
                    else:
                        await socket.send_text(message)
            tasks = [asyncio.create_task(browser_to_editor()), asyncio.create_task(editor_to_browser())]
            try:
                _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except (OSError, websockets.WebSocketException, WebSocketDisconnect):
        try:
            await socket.close(code=1011)
        except RuntimeError:
            pass


MAX_WS_BYTES = 50 * 1024 * 1024
