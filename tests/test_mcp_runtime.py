"""Identity-bound MCP gateway tests with explicit transport fixtures."""
from contextlib import asynccontextmanager
import argparse
import asyncio
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch
from app import mcp_broker, mcp_client

@asynccontextmanager
async def fixture_session(*args,**kwargs):
    yield object()

class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        quota = patch('app.agent_budget._reserve_user_action')
        quota.start()
        self.addCleanup(quota.stop)
        mcp_broker._discovery_cache.clear()
        bootstrap = patch.object(mcp_broker, 'bootstrap_registry')
        bootstrap.start()
        self.addCleanup(bootstrap.stop)

    async def test_discovery_reused_across_runs_without_caching_calls_or_access(self):
        config = {'httpURL': 'https://fixture.invalid/mcp', 'headers': {'Authorization': 'fixture-secret'}}
        active = [True]
        registry = types.ModuleType('app.mcp_access')
        registry.allowed_servers = lambda username: {'fixture': config} if active[0] else {}
        registry.get_authorized_server = lambda username, name: config if active[0] and name == 'fixture' else None
        connections = []
        @asynccontextmanager
        async def connected(*args, **kwargs):
            connections.append(1)
            yield object()
        async def execute(config, action, **kwargs):
            return {'tools': {}} if action == 'capabilities' else [{'name': 'fixture-tool'}] if action == 'tools' else {'content': []}
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'app.mcp_access': registry}), patch.object(mcp_broker, 'open_session', connected), patch.object(mcp_broker, 'execute', side_effect=execute) as executed:
            for run in range(2):
                async with mcp_broker.mcp_broker(username='employee', workspace=f'{directory}/workspace{run}', user_home=f'{directory}/home{run}', authorize=AsyncMock(), assert_active=AsyncMock()) as socket:
                    await mcp_broker.request(socket, {'action': 'capabilities', 'server': 'fixture'})
                    await mcp_broker.request(socket, {'action': 'tools', 'server': 'fixture'})
                    self.assertEqual(len(connections), 1)
                    if run == 1:
                        await mcp_broker.request(socket, {'action': 'call', 'server': 'fixture', 'tool': 'fixture-tool', 'arguments': {}})
                        self.assertEqual(len(connections), 2)
                        active[0] = False
                        with self.assertRaises(PermissionError):
                            await mcp_broker.request(socket, {'action': 'tools', 'server': 'fixture'})
            self.assertEqual(executed.await_count, 3)

    def test_discovery_cache_isolated_expiring_bounded_and_metadata_only(self):
        config = {'headers': {'Authorization': 'fixture-secret'}}
        with patch.object(mcp_broker.time, 'monotonic', return_value=10):
            mcp_broker._remember_discovery('alice', 'fixture', config, 'tools', [{'name': 'search'}])
            found, result = mcp_broker._cached_discovery('alice', 'fixture', config, 'tools')
            self.assertTrue(found)
            result.clear()
            self.assertTrue(mcp_broker._cached_discovery('alice', 'fixture', config, 'tools')[1])
            self.assertFalse(mcp_broker._cached_discovery('bob', 'fixture', config, 'tools')[0])
            self.assertFalse(mcp_broker._cached_discovery('alice', 'fixture', {'headers': {'Authorization': 'rotated'}}, 'tools')[0])
            mcp_broker._remember_discovery('alice', 'fixture', config, 'call', {'content': ['never cache']})
            self.assertFalse(mcp_broker._cached_discovery('alice', 'fixture', config, 'call')[0])
        with patch.object(mcp_broker.time, 'monotonic', return_value=10 + mcp_broker.DISCOVERY_CACHE_TTL):
            self.assertFalse(mcp_broker._cached_discovery('alice', 'fixture', config, 'tools')[0])
        with patch.object(mcp_broker, 'DISCOVERY_CACHE_LIMIT', 2):
            for name in ['one', 'two', 'three']:
                mcp_broker._remember_discovery('alice', name, config, 'tools', [])
            self.assertEqual(len(mcp_broker._discovery_cache), 2)

    async def test_revocation_and_request_identity(self):
        configs = {'policy': {'command':'fixture', 'env': {'API_TOKEN':'fixture-secret'}}, 'disabled':{'disabled':True}}
        registry = types.ModuleType('app.mcp_access')
        registry.allowed_servers = lambda username: dict(configs) if username == 'employee' else {}
        registry.get_authorized_server = lambda username,name: configs.get(name) if username == 'employee' else None
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'app.mcp_access':registry}), patch.object(mcp_broker,'open_session',fixture_session), patch.object(mcp_broker,'execute',new=AsyncMock(return_value=[{'name':'search'}])) as execute:
            home, workspace = Path(directory)/'home',Path(directory)/'project'
            (home/'.bob/settings').mkdir(parents=True)
            raw = home/'.bob/settings/mcp.json'
            raw.write_text(json.dumps({'mcpServers':configs}))
            async with mcp_broker.mcp_broker(username='employee',workspace=str(workspace),user_home=str(home), authorize=AsyncMock(), assert_active=AsyncMock()) as socket:
                for file in home.rglob('*.json'):
                    self.assertNotIn('fixture-secret',file.read_text())
                    self.assertNotIn('disabled', json.loads(file.read_text())['mcpServers'])
                servers = await mcp_broker.request(socket, {'action':'servers'})
                self.assertEqual({s['name'] for s in servers}, {'policy','buddy-app'})
                self.assertEqual(await mcp_broker.request(socket, {'action':'tools','server':'policy'}), [{'name':'search'}])
                for payload in ({'action':'tools','server':'unregistered'}, {'action':'tools','server':'policy','username':'admin'}, {'action':'call','server':'policy','tool':'search','arguments':[],}, {'action':'tools','server':'policy','url':'https://example.invalid'}):
                    with self.assertRaises(PermissionError):
                        await mcp_broker.request(socket,payload)
                configs.clear()
                with self.assertRaises(PermissionError):
                    await mcp_broker.request(socket,{'action':'call','server':'policy','tool':'search','arguments':{}})
                execute.assert_awaited_once()
            self.assertFalse(Path(socket).exists())

    async def test_lazy_native_registration_preserves_on_demand_access(self):
        config = {'command': 'fixture'}
        registry = types.ModuleType('app.mcp_access')
        registry.allowed_servers = lambda username: {'fixture': config}
        registry.get_authorized_server = lambda username, name: config if name == 'fixture' else None
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'app.mcp_access': registry}), patch.object(mcp_broker, 'open_session', fixture_session), patch.object(mcp_broker, 'execute', new=AsyncMock(return_value=[{'name': 'search'}])) as execute:
            home, workspace = Path(directory) / 'home', Path(directory) / 'project'
            async with mcp_broker.mcp_broker(username='employee', workspace=str(workspace), user_home=str(home), active_servers=['fixture'], lazy_native=True) as socket:
                execute.assert_not_awaited()
                native = json.loads((home / '.bob/mcp.json').read_text())['mcpServers']
                self.assertEqual(set(native), {'buddy-app'})
                servers = await mcp_broker.request(socket, {'action': 'servers'})
                self.assertIn('fixture', {server['name'] for server in servers})
                execute.assert_not_awaited()
                self.assertEqual(await mcp_broker.request(socket, {'action': 'tools', 'server': 'fixture'}), [{'name': 'search'}])
                execute.assert_awaited_once()

    async def test_native_stdio_proxy_roundtrip(self):
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError:
            self.skipTest('MCP SDK is available in the application container')
        import sys
        fixture = """import asyncio,os
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool,TextContent,Resource,Prompt,GetPromptResult,PromptMessage
from mcp.server.lowlevel.helper_types import ReadResourceContents
s=Server('fixture')
calls=0
@s.list_tools()
async def tools():
    return [Tool(name='echo',inputSchema={'type':'object','properties':{'text':{'type':'string'}}})]
@s.call_tool()
async def call(name,args):
    global calls
    calls+=1
    return [TextContent(type='text',text=args.get('text','')+' '+os.environ['FIXTURE_SECRET']+' '+str(calls))]
@s.list_resources()
async def resources():
    return [Resource(uri='fixture://document',name='Fixture document')]
@s.list_resource_templates()
async def templates():
    return []
@s.read_resource()
async def read(uri):
    return [ReadResourceContents(content='fixture resource',mime_type='text/plain')]
@s.list_prompts()
async def prompts():
    return [Prompt(name='fixture-prompt')]
@s.get_prompt()
async def prompt(name,args):
    return GetPromptResult(messages=[PromptMessage(role='user',content=TextContent(type='text',text='fixture prompt'))])
async def main():
    async with stdio_server() as (r,w):
        await s.run(r,w,s.create_initialization_options())
asyncio.run(main())
"""
        config={'command':sys.executable,'args':['-c',fixture],'env':{'FIXTURE_SECRET':'private-fixture-credential'}}
        active=[True]
        registry=types.ModuleType('app.mcp_access')
        registry.allowed_servers=lambda username:{'fixture':config}
        registry.get_authorized_server=lambda username,name:config if active[0] and name=='fixture' else None
        # The fixture is an inline synthetic MCP server; command policy is
        # covered independently and does not permit this test-only command.
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'app.mcp_access': registry}), \
                patch('app.mcp_command_policy.validate_stdio_config', return_value=(sys.executable, ['-c', fixture])):
            async with mcp_broker.mcp_broker(username='employee',workspace=directory+'/project',user_home=directory+'/home', authorize=AsyncMock(), assert_active=AsyncMock()) as socket:
                descriptor=json.loads((Path(directory)/'home/.bob/mcp_settings.json').read_text())['mcpServers']['fixture']
                params=StdioServerParameters(command=descriptor['command'],args=descriptor['args'],env={'PATH':os.environ['PATH'],**descriptor['env']},cwd=directory+'/project')
                async with stdio_client(params) as streams:
                    async with ClientSession(*streams) as session:
                        initialized=await session.initialize()
                        self.assertIsNotNone(initialized.capabilities.resources)
                        self.assertIsNotNone(initialized.capabilities.prompts)
                        resources=await session.list_resources()
                        self.assertEqual(resources.resources[0].name,'Fixture document')
                        resource=await session.read_resource(resources.resources[0].uri)
                        self.assertEqual(resource.contents[0].text,'fixture resource')
                        templates=await session.list_resource_templates()
                        self.assertEqual(templates.resourceTemplates,[])
                        prompts=await session.list_prompts()
                        self.assertEqual(prompts.prompts[0].name,'fixture-prompt')
                        prompt=await session.get_prompt('fixture-prompt')
                        self.assertEqual(prompt.messages[0].content.text,'fixture prompt')
                        tools=await session.list_tools()
                        self.assertEqual(tools.tools[0].name,'echo')
                        result=await session.call_tool('echo',{'text':'fixture-result'})
                        self.assertFalse(result.isError)
                        self.assertEqual(result.content[0].text,'fixture-result [redacted] 1')
                        second=await session.call_tool('echo',{'text':'second'})
                        self.assertEqual(second.content[0].text,'second [redacted] 2')
                        active[0]=False
                        denied=await session.call_tool('echo',{'text':'revoked'})
                        self.assertTrue(denied.isError)
                        self.assertNotIn('fixture-result',str(denied))

    async def test_no_unknown_identity(self):
        registry = types.ModuleType('app.mcp_access')
        registry.allowed_servers=lambda username:{}
        registry.get_authorized_server=lambda username,name:None
        with patch.dict('sys.modules',{'app.mcp_access':registry}):
            with self.assertRaises(PermissionError):
                async with mcp_broker.mcp_broker(username=None,workspace='/tmp',user_home='/tmp'):
                    self.fail('No identity must fail closed')

    async def test_cli_runtime_never_reads_legacy(self):
        args = argparse.Namespace(action='servers')
        with patch.dict(os.environ,{'BOB_KNOWLEDGE_SOCKET':'fixture'},clear=True), patch.object(mcp_client,'load_servers') as load:
            with self.assertRaises(PermissionError):
                await mcp_client.run(args)
            load.assert_not_called()
        with patch.dict(os.environ,{'BOB_MCP_SOCKET':'/tmp/fixture-gone.sock'},clear=True), patch.object(mcp_client,'load_servers') as load:
            with self.assertRaises(OSError):
                await mcp_client.run(args)
            load.assert_not_called()

    async def test_revocation_while_request_running(self):
        registry = types.ModuleType('app.mcp_access')
        active = [True]
        config={'command':'fixture'}
        registry.allowed_servers=lambda username:{'fixture':config}
        registry.get_authorized_server=lambda username,name:config if active[0] else None
        async def perform(*args,**kwargs):
            active[0]=False
            return {'content':[{'type':'text','text':'private fixture'}]}
        with tempfile.TemporaryDirectory() as directory,patch.dict('sys.modules',{'app.mcp_access':registry}),patch.object(mcp_broker,'open_session',fixture_session),patch.object(mcp_broker,'execute',side_effect=perform):
            async with mcp_broker.mcp_broker(username='employee',workspace=directory+'/workspace',user_home=directory+'/home', authorize=AsyncMock(), assert_active=AsyncMock()) as socket:
                with self.assertRaises(PermissionError):
                    await mcp_broker.request(socket,{'action':'call','server':'fixture','tool':'read','arguments':{}})

if __name__=='__main__':
    unittest.main()
