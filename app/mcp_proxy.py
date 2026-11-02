"""Native stdio MCP adapter for the service's identity-bound gateway."""
import asyncio
import os
import sys
from app.mcp_broker import request

async def serve(name):
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, CallToolResult
    socket = os.environ.get('BOB_MCP_SOCKET')
    if not socket:
        raise PermissionError('Authenticated MCP gateway required')
    capabilities = await request(socket, {'action':'capabilities','server':name})
    server = Server(name)
    if 'tools' in capabilities:
        @server.list_tools()
        async def list_tools():
            return [Tool.model_validate(tool) for tool in await request(socket, {'action':'tools','server':name})]
        @server.call_tool()
        async def call_tool(tool, arguments):
            result = await request(socket, {'action':'call','server':name,'tool':tool,'arguments':arguments or {}})
            return CallToolResult.model_validate(result)
    if 'resources' in capabilities:
        import base64
        from mcp.types import Resource, ResourceTemplate
        from mcp.server.lowlevel.helper_types import ReadResourceContents
        @server.list_resources()
        async def resources():
            return [Resource.model_validate(value) for value in await request(socket, {'action':'resources','server':name})]
        @server.list_resource_templates()
        async def templates():
            return [ResourceTemplate.model_validate(value) for value in await request(socket, {'action':'templates','server':name})]
        @server.read_resource()
        async def read(uri):
            result = await request(socket, {'action':'read_resource','server':name,'arguments':{'uri':str(uri)}})
            return [ReadResourceContents(content=item['text'] if 'text' in item else base64.b64decode(item['blob']), mime_type=item.get('mimeType'), meta=item.get('_meta')) for item in result['contents']]
    if 'prompts' in capabilities:
        from mcp.types import Prompt, GetPromptResult
        @server.list_prompts()
        async def prompts():
            return [Prompt.model_validate(value) for value in await request(socket, {'action':'prompts','server':name})]
        @server.get_prompt()
        async def get_prompt(prompt, arguments):
            result = await request(socket, {'action':'get_prompt','server':name,'tool':prompt,'arguments':arguments or {}})
            return GetPromptResult.model_validate(result)
    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())

if __name__ == '__main__':
    asyncio.run(serve(sys.argv[1]))
