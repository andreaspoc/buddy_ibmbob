"""SSRF-safe HTTP transports: resolve at connect, pin IP, preserve TLS hostname."""
from __future__ import annotations

import functools
import anyio
import ipaddress
import socket
from urllib.parse import urlsplit

import httpcore
import httpx
from httpcore._backends.anyio import AnyIOBackend


def origin(url):
    try:
        p = urlsplit(url)
        if (p.scheme not in {'http', 'https'} or not p.hostname or p.username or p.password
                or p.fragment or '%' in p.hostname or '*' in p.hostname or '\\' in url or len(url) > 4096):
            raise ValueError('Only HTTP(S) URLs without credentials or fragments are supported')
        return p.scheme, p.hostname.lower(), p.port or (443 if p.scheme == 'https' else 80)
    except (TypeError, AttributeError, ValueError) as exc:
        raise ValueError('Invalid HTTP destination') from exc


def allowed_origins(value):
    result = set()
    for item in value.split(','):
        if not item.strip():
            continue
        item = item.strip()
        p = urlsplit(item)
        if p.path not in ('', '/') or p.query:
            raise ValueError('Approved A2A origins must not contain paths or queries')
        result.add(origin(item))
    return frozenset(result)


# Cloud metadata literals below are SSRF denylist entries, never request targets.
def _sensitive(address):
    return (address.is_loopback or address.is_link_local or address.is_reserved
            or address.is_unspecified or address.is_multicast
            or str(address) in {'fd00:ec2::254', '100.100.100.200'})


def validate_url(url, allowed=(), *, allow_public_ports=False, trusted_hosts=()):
    target = origin(url)
    if target not in allowed:
        trusted_host = target[1] in trusted_hosts
        if target[2] not in {80, 443} and not (allow_public_ports or trusted_host):
            raise ValueError('Nonstandard web ports require an approved origin')
        try:
            address = ipaddress.ip_address(target[1])
        except ValueError:
            address = None
        if address is not None and not address.is_global and not (trusted_host and not _sensitive(address)):
            raise ValueError('Private, loopback, or reserved destinations are blocked')
    return url


def resolve(host, port, *, allow_private=False, block_sensitive=False):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    ips = list(dict.fromkeys(item[4][0] for item in addresses))
    if (not ips or (not allow_private and any(not ipaddress.ip_address(ip).is_global for ip in ips))
            or (block_sensitive and any(_sensitive(ipaddress.ip_address(ip)) for ip in ips))):
        raise ValueError('Private, loopback, or reserved destinations are blocked')
    return ips[0]


class PublicNetworkBackend(httpcore.SyncBackend):
    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        host = host.decode('ascii') if isinstance(host, bytes) else host
        ip = resolve(host, port)
        # httpcore retains the original hostname for SNI/certificate verification.
        return super().connect_tcp(ip, port, timeout, local_address, socket_options)


class ApprovedNetworkBackend(AnyIOBackend):
    def __init__(self, approved=(), trusted_hosts=()):
        self.approved = approved
        self.trusted_hosts = trusted_hosts

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        host = host.decode('ascii') if isinstance(host, bytes) else host
        # Scheme policy is checked by the transport before pool dispatch. Only
        # hosts/ports explicitly granted an origin can bypass public-IP checks.
        private = any(entry[1:] == (host.lower(), port) for entry in self.approved)
        trusted_host = host.lower() in self.trusted_hosts
        with anyio.fail_after(timeout or 5):
            ip = await anyio.to_thread.run_sync(
                functools.partial(resolve, host, port, allow_private=private or trusted_host,
                                  block_sensitive=trusted_host and not private), abandon_on_cancel=True)
        return await super().connect_tcp(ip, port, timeout, local_address, socket_options)


class ApprovedTransport(httpx.AsyncHTTPTransport):
    def __init__(self, approved=(), *, allow_public_ports=False, trusted_hosts=()):
        super().__init__(retries=0, trust_env=False)
        self.approved = approved
        self.allow_public_ports = allow_public_ports
        self.trusted_hosts = trusted_hosts
        self._pool._network_backend = ApprovedNetworkBackend(approved, trusted_hosts)

    async def handle_async_request(self, request):
        validate_url(str(request.url), self.approved, allow_public_ports=self.allow_public_ports,
                     trusted_hosts=self.trusted_hosts)
        # A grant for HTTPS must never authorize the HTTP variant of the host.
        target = origin(str(request.url))
        if (target not in self.approved and target[1] not in self.trusted_hosts
                and any(entry[1:] == target[1:] for entry in self.approved)):
            raise ValueError('Destination scheme does not match its approved origin')
        return await super().handle_async_request(request)


def sync_transport():
    transport = httpx.HTTPTransport(retries=0, trust_env=False)
    transport._pool._network_backend = PublicNetworkBackend()
    return transport


def async_transport(approved=(), *, allow_public_ports=False, trusted_hosts=()):
    return ApprovedTransport(approved, allow_public_ports=allow_public_ports, trusted_hosts=trusted_hosts)
