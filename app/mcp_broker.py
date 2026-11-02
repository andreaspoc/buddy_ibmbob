"""Per-run MCP gateway: identity is fixed by the service, credentials stay here."""
from __future__ import annotations
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import json
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import time
import secrets
from collections import OrderedDict
from app import personal_data
from app.redaction import redact, config_secrets

TRUSTED_MODULE_ROOT = str(Path(__file__).resolve().parent.parent)
MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
DISCOVERY_CACHE_TTL = 3600
DISCOVERY_CACHE_LIMIT = 256
DISCOVERY_CACHE_BYTES = 16 * 1024 * 1024
_discovery_cache = OrderedDict()
# Lives only in this process and the connector processes it starts, never the assistant's.
_PERSONAL_DATA_KEY = secrets.token_hex(32)
_APPROVAL_ARGUMENT = 'personal_data_approval'
_NATIVE_EMAIL_TOOLS = {('smtp', 'smtp_send_email'), ('microsoft365', 'microsoft_send_email')}


def _discovery_key(username, name, config, action):
    if action not in {'capabilities', 'tools', 'resources', 'templates', 'prompts'}:
        return None
    fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return username, name, fingerprint, action


def _cached_discovery(username, name, config, action):
    key = _discovery_key(username, name, config, action)
    cached = _discovery_cache.get(key)
    if cached is None:
        return False, None
    expires, encoded = cached
    if expires <= time.monotonic():
        del _discovery_cache[key]
        return False, None
    _discovery_cache.move_to_end(key)
    return True, json.loads(encoded)


def _remember_discovery(username, name, config, action, result):
    key = _discovery_key(username, name, config, action)
    if key is None:
        return
    encoded = json.dumps(result).encode()
    if len(encoded) > DISCOVERY_CACHE_BYTES:
        return
    _discovery_cache[key] = (time.monotonic() + DISCOVERY_CACHE_TTL, encoded)
    _discovery_cache.move_to_end(key)
    while len(_discovery_cache) > DISCOVERY_CACHE_LIMIT or sum(len(value[1]) for value in _discovery_cache.values()) > DISCOVERY_CACHE_BYTES:
        _discovery_cache.popitem(last=False)

@asynccontextmanager
async def open_session(config, *, user_home=None, workspace=None, server_name=None):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.sse import sse_client
    from mcp.client.streamable_http import streamable_http_client
    import httpx
    async with AsyncExitStack() as stack:
        if 'httpURL' in config:
            client = await stack.enter_async_context(httpx.AsyncClient(headers=config.get('headers', {}), timeout=30))
            streams = await stack.enter_async_context(streamable_http_client(config['httpURL'], http_client=client))
        elif 'url' in config:
            streams = await stack.enter_async_context(sse_client(config['url'], headers=config.get('headers', {})))
        else:
            from app.mcp_command_policy import validate_stdio_config
            executable, arguments = validate_stdio_config(config)
            from anyio import open_file
            stderr = await stack.enter_async_context(await open_file(os.devnull, 'w'))
            # Server credentials never enter the assistant process environment.
            env = {key: os.environ[key] for key in ('PATH','LANG','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS') if key in os.environ}
            if server_name == 'microsoft365' and config.get('command') in {'python3', sys.executable} and config.get('args') == ['-m', 'app.mcp_microsoft']:
                for key in ('DATABASE_URL', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'GRAPH_API_BASE', 'DEFAULT_TIMEZONE'):
                    if key in os.environ:
                        env[key] = os.environ[key]
            env.update(config.get('env', {}))
            if server_name == 'smtp' and config.get('command') in {'python3', sys.executable} and config.get('args') == ['-m', 'app.mcp_smtp']:
                env['DATABASE_URL'] = os.environ['DATABASE_URL']
            if server_name in {'smtp', 'microsoft365'}:
                env[personal_data.APPROVAL_KEY_ENV] = _PERSONAL_DATA_KEY
            env['HOME'] = user_home or str(Path.home())
            env['PYTHONPATH'] = TRUSTED_MODULE_ROOT
            # Python's -m normally searches the working directory first. MCP
            # workspaces can contain user files, so never import modules there.
            env['PYTHONSAFEPATH'] = '1'
            streams = await stack.enter_async_context(stdio_client(StdioServerParameters(command=executable, args=arguments, env=env, cwd=workspace), errlog=stderr.wrapped))
        session = await stack.enter_async_context(ClientSession(streams[0], streams[1]))
        initialized = await session.initialize()
        session._buddy_server_name = initialized.serverInfo.name
        session._buddy_capabilities = initialized.capabilities.model_dump(mode='json', exclude_none=True)
        yield session

def _prepare_outbound(payload):
    """Drop any assistant-supplied approval and apply the policy to what would leave."""
    from app import privacy_policy
    if payload.get('action') != 'call':
        return payload, [], []
    is_email = personal_data.is_email_tool(payload.get('tool'))
    arguments = {key: value for key, value in payload['arguments'].items() if key != _APPROVAL_ARGUMENT}
    blocked, ask = privacy_policy.review_arguments(arguments, 'email' if is_email else 'external_tool')
    return {**payload, 'arguments': arguments}, blocked, ask


def _blocked_result(blocked):
    return {'isError': True, 'content': [{'type': 'text', 'text': str(personal_data.PersonalDataBlocked(blocked))}]}


def _approved_arguments(name, payload):
    arguments = payload['arguments']
    if (name, payload['tool']) not in _NATIVE_EMAIL_TOOLS:
        return arguments
    token = personal_data.approval_token(_PERSONAL_DATA_KEY, arguments.get('to'), arguments.get('subject'),
                                         arguments.get('body'), arguments.get('is_html', False))
    return {**arguments, _APPROVAL_ARGUMENT: token}


async def execute(config, action, *, tool=None, arguments=None, session=None, **connection):
    if session is None:
        async with open_session(config, **connection) as connected:
            return await execute(config, action, tool=tool, arguments=arguments, session=connected)
    if action == 'capabilities':
        return session._buddy_capabilities
    if action in {'tools', 'resources', 'templates', 'prompts'}:
        method, field = {'tools': ('list_tools', 'tools'), 'resources': ('list_resources', 'resources'), 'templates': ('list_resource_templates', 'resourceTemplates'), 'prompts': ('list_prompts', 'prompts')}[action]
        result, cursor, seen, size = [], None, set(), 2
        # A remote server controls pagination. Timeouts alone do not prevent a
        # fast cyclic or huge response from exhausting process memory/compute.
        for _ in range(32):
            page = await getattr(session, method)(cursor=cursor)
            items = getattr(page, field)
            if len(result) + len(items) > 10000:
                raise ValueError('MCP discovery item limit exceeded')
            for item in items:
                value = item.model_dump(mode='json')
                size += len(json.dumps(value).encode()) + 2
                if size > MAX_RESPONSE:
                    raise ValueError('MCP discovery response limit exceeded')
                result.append(value)
            cursor = page.nextCursor
            if not cursor:
                # Input schema names are metadata, not credential values.
                return redact(result, config_secrets(config), mask_sensitive_keys=action != 'tools')
            if not isinstance(cursor, str) or len(cursor) > 8192 or cursor in seen:
                raise ValueError('Invalid or repeated MCP discovery cursor')
            seen.add(cursor)
        raise ValueError('MCP discovery page limit exceeded')
    if action == 'read_resource':
        result = await session.read_resource(arguments['uri'])
        return redact(result.model_dump(mode='json'), config_secrets(config))
    if action == 'get_prompt':
        result = await session.get_prompt(tool, arguments)
        return redact(result.model_dump(mode='json'), config_secrets(config))
    result = await session.call_tool(tool, arguments=arguments)
    return redact(result.model_dump(mode='json'), config_secrets(config))

async def request(socket, payload):
    encoded = json.dumps(payload).encode() + b'\n'
    if len(encoded) > MAX_REQUEST:
        raise ValueError('MCP request too large')
    reader, writer = await asyncio.open_unix_connection(socket, limit=MAX_RESPONSE)
    try:
        writer.write(encoded)
        await writer.drain()
        response = json.loads(await asyncio.wait_for(reader.readline(), 420))
        if 'error' in response:
            raise PermissionError(response['error'])
        return response['result']
    finally:
        writer.close()
        await writer.wait_closed()


def materialize_proxies(workspace, user_home, names, socket):
    """Overwrite every known legacy MCP source in this isolated scratch run."""
    if not workspace or not user_home:
        raise PermissionError('An isolated user workspace and home are required')
    descriptors = {name: {'command': sys.executable, 'args': ['-m', 'app.mcp_proxy', name],
                         'env': {'BOB_MCP_SOCKET': socket, 'PYTHONPATH': TRUSTED_MODULE_ROOT,
                                 'PYTHONSAFEPATH': '1'}} for name in names}
    for folder in (Path(user_home) / '.bob', Path(workspace) / '.bob'):
        if folder.is_symlink():
            folder.unlink()
        folder.mkdir(parents=True, exist_ok=True)
        settings_folder = folder / 'settings'
        if settings_folder.is_symlink():
            settings_folder.unlink()
        paths = {folder / 'mcp.json', folder / 'mcp_settings.json', folder / 'settings' / 'mcp.json'}
        # Legacy settings files can also embed mcpServers.
        paths.update(p for p in folder.rglob('*.json') if p.is_file() and not p.is_symlink())
        for path in paths:
            data = {}
            if path.is_file():
                try:
                    data = json.loads(path.read_text())
                except (ValueError, OSError):
                    pass
            if not isinstance(data, dict):
                continue
            if path.name not in {'mcp.json', 'mcp_settings.json'} and 'mcpServers' not in data:
                continue
            data['mcpServers'] = descriptors
            data.pop('deletedMcpServers', None)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Avoid writing through restored symlinks.
            if path.is_symlink():
                path.unlink()
            path.write_text(json.dumps(data, indent=2) + '\n')


def bootstrap_registry():
    from app.workspace_config import ensure_brave_mcp
    ensure_brave_mcp()


@asynccontextmanager
async def mcp_broker(*, username, workspace, user_home, active_servers=None,
                     allowed_agents=None, authorize=None, assert_active=None, budget=None,
                     lazy_native=False):
    from app.mcp_access import allowed_servers, get_authorized_server
    from app.app_actions import APP_SERVER, action_context, dispatch as dispatch_app
    context = action_context.get() or {}
    if not username:
        raise PermissionError('Authenticated MCP user required')
    from app.agent_budget import RunBudget
    from app.execution_policy import requires_approval
    budget = budget or context.get('agent_budget') or RunBudget(username)
    if budget.username != username:
        raise PermissionError('Agent budget owner mismatch')
    context.setdefault('agent_budget', budget)
    agent_scope = frozenset(allowed_agents if allowed_agents is not None else context.get('agent_slugs', ()))
    authorizer = context.get('execution_authorizer')
    authorize = authorize or (authorizer.authorize if authorizer else None)
    assert_active = assert_active or (authorizer.assert_active if authorizer else None)
    async def authorize_call(payload, config=None):
        if requires_approval(payload):
            if not authorize:
                raise PermissionError('Action requires an authenticated approval channel')
            await authorize(payload, config)
    async def review_personal_data(payload, config, categories):
        """Return a tool result when the owner did not agree to send; None to continue."""
        try:
            if not authorizer:
                raise PermissionError('No approval channel')
            await authorizer.authorize(payload, config, force=True, personal_data=categories)
        except PermissionError:
            return {'isError': True, 'content': [{'type': 'text', 'text':
                    'Not sent: this may contain personal data (' + ', '.join(categories) + ') and the user did not '
                    'approve sending it. Tell the user. Do not retry, reword, split or encode the content.'}]}
        return None
    async def assert_current(payload):
        if requires_approval(payload):
            if not assert_active:
                raise PermissionError('Execution checkpoint is unavailable')
            await assert_active()
    await asyncio.to_thread(bootstrap_registry)
    tasks = set()
    semaphore = asyncio.Semaphore(8)
    backends = {}

    async def backend(name, initial_config, queue):
        # The owner task both enters and exits SDK/AnyIO contexts. Keep stdio
        # state (browser sessions, etc.) throughout this assistant run.
        pending = None
        try:
            async with open_session(initial_config, user_home=user_home, workspace=workspace, server_name=name) as session:
                while True:
                    payload, pending = await queue.get()
                    if pending.cancelled():
                        pending = None
                        continue
                    current = await asyncio.to_thread(get_authorized_server, username, name)
                    if current != initial_config or not current or current.get('disabled'):
                        pending.set_exception(PermissionError('MCP access or configuration changed'))
                        pending = None
                        break
                    try:
                        categories, blocked = [], []
                        if requires_approval(payload):
                            payload, blocked, categories = await asyncio.to_thread(_prepare_outbound, payload)
                            refusal = _blocked_result(blocked) if blocked else await review_personal_data(payload, current, categories) if categories else None
                            if refusal is not None:
                                if not pending.done():
                                    pending.set_result(refusal)
                                pending = None
                                continue
                            if not categories:
                                await authorize_call(payload, current)
                            if pending.cancelled():
                                pending = None
                                continue
                            # Approval may wait minutes. Recheck the exact target
                            # and cancellation-sensitive authorization afterwards.
                            if await asyncio.to_thread(get_authorized_server, username, name) != current:
                                raise PermissionError('MCP configuration changed during approval')
                            await assert_current(payload)
                        if pending.cancelled():
                            pending = None
                            continue
                        arguments = _approved_arguments(name, payload) if categories else payload.get('arguments')
                        result = await asyncio.wait_for(execute(current, payload['action'], tool=payload.get('tool'), arguments=arguments, session=session), 100)
                        if not pending.done():
                            pending.set_result(result)
                    except Exception:
                        if not pending.done():
                            pending.set_exception(RuntimeError('MCP connection unavailable'))
                    pending = None
        except BaseException:
            if pending is not None and not pending.done():
                pending.set_exception(RuntimeError('MCP connection unavailable'))
        finally:
            while not queue.empty():
                _, future = queue.get_nowait()
                if not future.done():
                    future.set_exception(RuntimeError('MCP connection unavailable'))

    async def dispatch(name, config, payload):
        entry = backends.get(name)
        if entry is None or entry[1].done():
            queue = asyncio.Queue(maxsize=16)
            task = asyncio.create_task(backend(name, config, queue))
            entry = backends[name] = (queue, task)
        future = asyncio.get_running_loop().create_future()
        await entry[0].put((payload, future))
        try:
            return await asyncio.wait_for(future, 410)
        except BaseException:
            future.cancel()
            raise
    async def handle(reader, writer):
        task = asyncio.current_task()
        tasks.add(task)
        try:
            async with semaphore:
                raw = await asyncio.wait_for(reader.readline(), 5)
                if len(raw) > MAX_REQUEST:
                    raise ValueError('Request too large')
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError('Invalid request')
                action = payload.get('action')
                expected = {'action'} if action in {'servers', 'a2a_list'} else {'action', 'slug', 'prompt', 'context_id'} if action == 'a2a_ask' else {'action', 'server'} if action in {'tools','capabilities','resources','templates','prompts'} else {'action','server','arguments'} if action == 'read_resource' else {'action','server','tool','arguments'} if action in {'call','get_prompt'} else set()
                if not expected or set(payload) != expected:
                    raise ValueError('Invalid request')
                await budget.consume('remote' if action == 'a2a_ask' else 'tool')
                if action in {'a2a_list', 'a2a_ask'}:
                    from app.agent_attachments import dispatch as dispatch_a2a, authorized_agent
                    target = None
                    if action == 'a2a_ask':
                        if payload.get('slug') not in agent_scope:
                            raise PermissionError('Agent was not selected for this turn')
                        target = await asyncio.to_thread(authorized_agent, username, payload['slug'])
                        if not target or target.get('disabled') or target.get('enabled') is False:
                            raise PermissionError('A2A access denied')
                        await authorize_call(payload, target)
                    result = await asyncio.wait_for(dispatch_a2a(username, payload, allowed_slugs=agent_scope,
                        expected_agent=target, assert_active=assert_active), 110)
                elif action == 'servers':
                    servers = await asyncio.to_thread(allowed_servers, username)
                    result = [{'name': name, 'disabled': False, 'transport': 'http' if 'httpURL' in c else 'sse' if 'url' in c else 'stdio'} for name,c in sorted(servers.items()) if name in server_scope and not c.get('disabled') and name != APP_SERVER]
                    result.append({'name':APP_SERVER,'disabled':False,'transport':'stdio','builtin':True})
                else:
                    name = payload['server']
                    if not isinstance(name, str) or len(name) > 256:
                        raise ValueError('Invalid server')
                    if name not in server_scope:
                        raise PermissionError('MCP server was not selected for this turn')
                    if name == APP_SERVER:
                        if action == 'call':
                            await authorize_call(payload)
                            await assert_current(payload)
                        result = await dispatch_app(username,payload,context)
                    else:
                        config = await asyncio.to_thread(get_authorized_server, username, name)
                        if not config or config.get('disabled'):
                            raise PermissionError('MCP access denied')
                        if action == 'read_resource' and (not isinstance(payload['arguments'], dict) or set(payload['arguments']) != {'uri'} or not isinstance(payload['arguments']['uri'], str) or len(payload['arguments']['uri']) > 8192):
                            raise ValueError('Invalid resource URI')
                        if action in {'call', 'get_prompt'} and (not isinstance(payload['tool'],str) or not payload['tool'] or len(payload['tool']) > 256 or not isinstance(payload['arguments'],dict)):
                            raise ValueError('Invalid tool arguments')
                        # Reuse only short-lived discovery metadata for this exact
                        # user and configuration. Tool calls and resource contents
                        # always reach the backend; access is checked on both sides.
                        cached, result = _cached_discovery(username, name, config, action)
                        if not cached:
                            result = await dispatch(name, config, payload)
                            _remember_discovery(username, name, config, action, result)
                        # Revocation during a request also prevents returning its output.
                        if not await asyncio.to_thread(get_authorized_server, username, name):
                            raise PermissionError('MCP access denied')
                response = json.dumps({'result': result}).encode() + b'\n'
                if len(response) > MAX_RESPONSE:
                    raise ValueError('Response too large')
        except Exception:
            response = b'{"error":"MCP request denied or connection unavailable"}\n'
        finally:
            try:
                writer.write(response)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                tasks.discard(task)
    with tempfile.TemporaryDirectory(prefix='buddy-mcp-') as directory:
        socket = str(Path(directory) / 'gateway.sock')
        server = await asyncio.start_unix_server(handle, path=socket, limit=MAX_REQUEST + 1)
        os.chmod(socket, 0o600)
        try:
            servers = await asyncio.to_thread(allowed_servers, username)
            if active_servers is not None:
                # Lazy MCP: Only register specifically requested servers + internal app tools
                chosen = sorted({APP_SERVER, *[name for name in active_servers if name in servers and not servers[name].get('disabled')]})
            else:
                chosen = sorted({APP_SERVER, *[name for name, c in servers.items() if not c.get('disabled')]})
            server_scope = frozenset(chosen)
            # Native clients discover every registered server before prompting.
            # Keep external connectors in the authorized gateway scope, but let
            # the agent discover them through mcp_client only when needed.
            native_servers = [APP_SERVER] if lazy_native else chosen
            await asyncio.to_thread(materialize_proxies, workspace, user_home, native_servers, socket)
            yield socket
        finally:
            server.close()
            await server.wait_closed()
            active = list(tasks)
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            owners = [entry[1] for entry in backends.values()]
            for task in owners:
                task.cancel()
            await asyncio.gather(*owners, return_exceptions=True)
