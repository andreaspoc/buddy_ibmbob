"""Native read-only Keycloak configuration MCP, authenticated per user.

REST contracts: https://www.keycloak.org/docs-api/latest/rest-api/index.html
Only the issuer's realm is accessible. No user, membership, event, session,
credential, token, or write endpoints are exposed, even if the token permits them.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

MAX_RESPONSE_BYTES = 2_000_000
MAX_PAGE = 100
MAX_OFFSET = 100_000

REALM_FIELDS = {
    'realm': str, 'enabled': bool, 'sslRequired': str,
    'registrationAllowed': bool, 'registrationEmailAsUsername': bool,
    'rememberMe': bool, 'verifyEmail': bool, 'loginWithEmailAllowed': bool,
    'duplicateEmailsAllowed': bool, 'resetPasswordAllowed': bool,
    'editUsernameAllowed': bool, 'bruteForceProtected': bool,
    'permanentLockout': bool, 'failureFactor': int,
    'accessTokenLifespan': int, 'accessTokenLifespanForImplicitFlow': int,
    'ssoSessionIdleTimeout': int, 'ssoSessionMaxLifespan': int,
    'offlineSessionIdleTimeout': int, 'offlineSessionMaxLifespan': int,
    'browserFlow': str, 'registrationFlow': str, 'directGrantFlow': str,
    'resetCredentialsFlow': str, 'clientAuthenticationFlow': str,
}
CLIENT_FIELDS = {'id': str, 'clientId': str, 'name': str, 'enabled': bool, 'protocol': str, 'publicClient': bool}
ROLE_FIELDS = {'id': str, 'name': str, 'description': str, 'composite': bool, 'clientRole': bool}
FLOW_FIELDS = {'id': str, 'alias': str, 'description': str, 'providerId': str, 'topLevel': bool, 'builtIn': bool}
ALLOWED_SUFFIX = re.compile(r'(?:|/clients|/roles|/clients/[A-Za-z0-9_-]{1,200}/roles|/authentication/flows)\Z')
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)
mcp = FastMCP('Keycloak configuration', instructions='Read-only configuration for the authenticated issuer realm. Never retrieve user/profile/membership/event/session/credential data or execute writes. List responses are bounded pages, not complete inventories.')

@dataclass(frozen=True)
class Configuration:
    issuer: str
    admin_base: str
    realm: str
    client_id: str
    token: str = field(repr=False)


def configuration() -> Configuration:
    issuer = os.environ.get('BOB_KEYCLOAK_MCP_ISSUER', '').strip()
    client_id = os.environ.get('BOB_KEYCLOAK_MCP_CLIENT_ID', '').strip()
    token = os.environ.get('BOB_KEYCLOAK_MCP_TOKEN', '')
    try:
        parsed = urlsplit(issuer)
        _ = parsed.port
    except ValueError:
        raise ToolError('Keycloak issuer configuration is invalid.') from None
    path = parsed.path.rstrip('/')
    segments = path.split('/')
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
        or parsed.query or parsed.fragment or len(issuer) > 2000
        or len(segments) < 3 or segments[-2] != 'realms'
        or any(not re.fullmatch(r'[A-Za-z0-9._~-]+', part) or part in {'.', '..'} for part in segments[1:])):
        raise ToolError('Configure an HTTPS Keycloak issuer ending in /realms/realm.')
    if not client_id or len(client_id) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in client_id):
        raise ToolError('Keycloak client ID configuration is missing or invalid.')
    if not token or len(token) > 16384 or not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', token):
        raise ToolError('Sign in to the Keycloak catalogue connection before using this tool.')
    realm = segments[-1]
    prefix = '/'.join(segments[:-2])
    base = urlunsplit((parsed.scheme, parsed.netloc, prefix + '/admin/realms/' + realm, '', ''))
    return Configuration(issuer=urlunsplit((parsed.scheme, parsed.netloc, path, '', '')), admin_base=base, realm=realm, client_id=client_id, token=token)


def _http_client() -> httpx.Client:
    # Do not inherit proxy environment or allow redirect-based credential forwarding.
    return httpx.Client(timeout=httpx.Timeout(15.0, connect=5.0), verify=True, follow_redirects=False, trust_env=False)


def _read(suffix: str, params: dict[str, Any] | None = None) -> tuple[Configuration, Any]:
    config = configuration()
    if not ALLOWED_SUFFIX.fullmatch(suffix):
        raise ToolError('This Keycloak endpoint is not available in the read-only configuration connector.')
    url = config.admin_base + suffix
    if urlsplit(url).netloc != urlsplit(config.issuer).netloc:
        raise ToolError('Keycloak request origin is invalid.')
    try:
        with _http_client() as client:
            with client.stream('GET', url, params=params, headers={'Authorization': 'Bearer ' + config.token, 'Accept': 'application/json'}) as response:
                if response.status_code == 401:
                    raise ToolError('Keycloak sign-in expired or was rejected. Reconnect your catalogue account.')
                if response.status_code == 403:
                    raise ToolError('Your Keycloak account does not have permission to view this configuration.')
                if response.status_code == 404:
                    raise ToolError('The requested Keycloak realm or configuration was not found.')
                if response.status_code != 200:
                    raise ToolError('Keycloak could not complete this read-only request. Check the server availability and connection configuration.')
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                if content_type != 'application/json' and not content_type.endswith('+json'):
                    raise ToolError('Keycloak returned an unsupported response format.')
                try:
                    size = int(response.headers.get('Content-Length', '0'))
                except ValueError:
                    raise ToolError('Keycloak returned an invalid response size.') from None
                if size > MAX_RESPONSE_BYTES or size < 0:
                    raise ToolError('Keycloak configuration response exceeds the supported size. Request a smaller page.')
                chunks = bytearray()
                for chunk in response.iter_bytes(chunk_size=65536):
                    if len(chunks) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise ToolError('Keycloak configuration response exceeds the supported size. Request a smaller page.')
                    chunks.extend(chunk)
                return config, json.loads(chunks)
    except ToolError:
        raise
    except (httpx.HTTPError, ValueError, TypeError, UnicodeError):
        # Never include response bodies, URLs, tokens, or upstream exception text.
        raise ToolError('Keycloak returned an invalid response or could not be reached securely. Check your connection and try again.') from None


def _whitelist(value: Any, fields: dict[str, type]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ToolError('Keycloak returned an invalid configuration representation.')
    return {key: entry[:2048] if isinstance(entry, str) else entry
            for key, expected in fields.items()
            if key in value and type(entry := value[key]) is expected}


def _page(first: int, max_results: int) -> dict[str, Any]:
    if type(first) is not int or not 0 <= first <= MAX_OFFSET or type(max_results) is not int or not 1 <= max_results <= MAX_PAGE:
        raise ToolError('Use an offset between 0 and 100,000 and a page size between 1 and 100.')
    return {'first': first, 'max': max_results}


def _listing(suffix: str, fields: dict[str, type], first: int, max_results: int) -> dict[str, Any]:
    params = _page(first, max_results)
    if suffix.endswith('/roles') or suffix == '/roles':
        params['briefRepresentation'] = 'true'
    config, values = _read(suffix, params)
    if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
        raise ToolError('Keycloak returned an invalid configuration list.')
    items = [_whitelist(value, fields) for value in values[:max_results]]
    return {'realm': config.realm, 'items': items, 'first': first, 'max_results': max_results,
            'may_have_more': len(values) >= max_results, 'bounded_page': True}


@mcp.tool(annotations=READ_ONLY)
def keycloak_realm_configuration() -> dict[str, Any]:
    """Read whitelisted security/session/flow settings for the connected realm. Never returns users, secrets, SMTP, keys, or arbitrary realm attributes."""
    config, value = _read('')
    return {'realm': config.realm, 'configuration': _whitelist(value, REALM_FIELDS)}


@mcp.tool(annotations=READ_ONLY)
def keycloak_list_clients(first: int = 0, max_results: int = 50) -> dict[str, Any]:
    """List a bounded page of client IDs, names, enabled status, protocol, and public-client flag only. No secrets or service-account data."""
    return _listing('/clients', CLIENT_FIELDS, first, max_results)


@mcp.tool(annotations=READ_ONLY)
def keycloak_list_realm_roles(first: int = 0, max_results: int = 50) -> dict[str, Any]:
    """List role definitions in this realm; never includes user assignments or group membership."""
    return _listing('/roles', ROLE_FIELDS, first, max_results)


@mcp.tool(annotations=READ_ONLY)
def keycloak_list_client_roles(client_uuid: str, first: int = 0, max_results: int = 50) -> dict[str, Any]:
    """List configuration role definitions for a client's internal id from keycloak_list_clients (not its clientId). No assignments or membership."""
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', client_uuid):
        raise ToolError('Use a valid internal client ID returned by the client list.')
    return _listing('/clients/' + client_uuid + '/roles', ROLE_FIELDS, first, max_results)


@mcp.tool(annotations=READ_ONLY)
def keycloak_list_authentication_flows(max_results: int = 50) -> dict[str, Any]:
    """Read whitelisted authentication flow definitions. No executions, authenticator secrets, users, or events. Results are capped locally because this endpoint has no pagination."""
    _page(0, max_results)
    config, values = _read('/authentication/flows')
    if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
        raise ToolError('Keycloak returned an invalid authentication-flow list.')
    return {'realm': config.realm, 'items': [_whitelist(value, FLOW_FIELDS) for value in values[:max_results]], 'truncated': len(values) > max_results, 'max_results': max_results}


if __name__ == '__main__':
    mcp.run(transport='stdio')
