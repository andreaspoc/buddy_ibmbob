"""Restrict stdio MCP servers to installed, purpose-built entry points."""
import sys


def validate_stdio_config(config):
    command, args = config.get('command'), config.get('args', [])
    env = config.get('env', {})
    python_modules = {
        'app.mcp_microsoft': ('app.mcp_microsoft', {'PYTHONPATH', 'BOB_MICROSOFT_TOKEN_FILE'}),
        'app.mcp_keycloak': ('app.mcp_keycloak', {'PYTHONPATH'}),
        'app.mcp_search': ('app.mcp_search', {'PYTHONPATH', 'BRAVE_API_KEY'}),
        'app.mcp_smtp': ('app.mcp_smtp', {'PYTHONPATH'}),
    }
    if command in ('python3', sys.executable) and isinstance(args, list) and len(args) == 2 and args[0] == '-m' and args[1] in python_modules:
        module, allowed_env = python_modules[args[1]]
        executable = 'python3' if command == 'python3' else sys.executable
        safe_args = ['-m', module]
    elif command == 'mcp-server-monday-api' and args == []:
        allowed_env = {'MONDAY_TOKEN'}
        executable, safe_args = 'mcp-server-monday-api', []
    else:
        raise ValueError('This stdio MCP command and its arguments are not permitted')
    if not isinstance(env, dict) or set(env) - allowed_env:
        raise ValueError('This stdio MCP environment is not permitted')
    return executable, safe_args
