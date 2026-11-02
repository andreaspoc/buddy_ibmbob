"""Verify Bob's fallback MCP helper against a local fixture, not operational data."""
import asyncio
import argparse
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mcp_client import run

async def main():
    with tempfile.TemporaryDirectory() as folder:
        script = Path(folder) / 'fixture.py'
        script.write_text('''from mcp.server.fastmcp import FastMCP
mcp = FastMCP('Test fixture')
@mcp.tool()
def echo(text: str) -> str:
    return text
mcp.run(transport='stdio')
''')
        config = {'fixture': {'command': sys.executable, 'args': [str(script)],
                              'env': {'CUSTOM_API_KEY': 'fixture-only-secret'}}}
        with patch('app.mcp_client.load_servers', return_value=config):
            args = argparse.Namespace(action='servers', server='fixture')
            assert await run(args) == [{'name': 'fixture', 'disabled': False, 'transport': 'stdio'}]
            args.action = 'tools'
            tools = await run(args)
            assert tools[0]['name'] == 'echo' and 'text' in tools[0]['inputSchema']['properties']
            args.action = 'call'; args.tool = 'echo'; args.arguments = '{"text":"fixture-only-secret"}'
            result = await run(args)
            assert result['content'][0]['text'] == '[redacted]', result
        print('PASS: helper lists connections, discovers schemas, calls tools, and masks configured secrets')

if __name__ == '__main__':
    async def bounded():
        async with asyncio.timeout(20):
            await main()
    asyncio.run(bounded())
