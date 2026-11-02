"""Run with the MCP dependency installed: python3 tests/mcp_health_integration.py."""
import asyncio
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.mcp_health import probe_mcp

FIXTURE = '''
import sys
from mcp.server.fastmcp import FastMCP
mcp = FastMCP('Connection test', host='127.0.0.1', port=int(sys.argv[2]) if len(sys.argv)>2 else 8000)
@mcp.tool()
def ping() -> str:
    return 'pong'
mcp.run(transport=sys.argv[1])
'''

async def main():
    with tempfile.TemporaryDirectory() as folder:
        script = Path(folder) / 'server.py'
        script.write_text(FIXTURE)
        config = {'command': sys.executable, 'args': [str(script), 'stdio'],
                  'env': {'PYTHONPATH': os.getenv('PYTHONPATH', '')}}
        result = await probe_mcp(config, cwd=folder)
        assert result['status'] == 'working' and result['tools'] == ['ping'], result
        print('PASS: stdio handshake and tool discovery')
        virtual_root = str(Path(folder) / 'database-only-user')
        result = await probe_mcp(config, cwd=virtual_root)
        assert result['status'] == 'working' and result['tools'] == ['ping'], result
        assert not Path(virtual_root).exists()
        print('PASS: database-only workspace uses a temporary working directory')
        # Built-in servers import app modules after changing cwd. The health
        # check must inherit the broker's trusted PYTHONPATH, not the shell cwd.
        result = await probe_mcp({'command': sys.executable, 'args': ['-m', 'app.mcp_smtp']}, cwd=folder, server_name='smtp')
        assert result['status'] == 'working' and result['tools'] == ['smtp_send_email'], result
        print('PASS: built-in SMTP discovery from an isolated working directory')
        result = await probe_mcp({'command': '/missing/mcp-command'}, cwd=folder)
        assert result['status'] == 'error' and 'Command not found' in result['message'], result
        print('PASS: missing command')
        for transport, key, endpoint in [('streamable-http', 'httpURL', 'mcp'), ('sse', 'url', 'sse')]:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            proc = subprocess.Popen([sys.executable, str(script), transport, str(port)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        _, writer = await asyncio.open_connection('127.0.0.1', port)
                        writer.close()
                        await writer.wait_closed()
                        break
                    except OSError:
                        await asyncio.sleep(.05)
                result = await probe_mcp({key: f'http://127.0.0.1:{port}/{endpoint}'}, cwd=folder)
                assert result['status'] == 'working' and result['tools'] == ['ping'], result
                print(f'PASS: {transport} handshake and tool discovery')
            finally:
                proc.terminate()
                proc.wait(timeout=5)

if __name__ == '__main__':
    asyncio.run(main())
