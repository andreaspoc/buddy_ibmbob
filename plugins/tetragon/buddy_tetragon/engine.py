"""Curated Tetragon compiler and bounded local UNIX-socket CLI transport.

No shell, arbitrary YAML, remote gRPC address, or caller-selected CLI switches.
An enabled/enforce policy means loaded, not an independently verified denial.
"""
from __future__ import annotations

from app.branding import brand_text
import json
import os
from pathlib import PurePosixPath
import re
import selectors
import subprocess
import tempfile
import time
from uuid import UUID


class EngineError(RuntimeError):
    """Safe operational failure; never contains raw CLI output or host secrets."""


def exact_paths(values, label='Paths'):
    if not isinstance(values, list) or not 1 <= len(values) <= 32:
        raise ValueError(f'{label} must contain 1 to 32 exact absolute paths')
    result = []
    for value in values:
        if (not isinstance(value, str) or not 2 <= len(value) <= 512
                or not value.startswith('/') or value.startswith('//')
                or any(ord(c) < 32 or ord(c) == 127 or c in '*?[]{}\\' for c in value)
                or str(PurePosixPath(value)) != value or '..' in PurePosixPath(value).parts):
            raise ValueError(f'{label} must use normalized absolute paths without wildcards or traversal')
        if value not in result:
            result.append(value)
    return result


def policy_name(rule_id):
    try:
        canonical = str(UUID(str(rule_id)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Invalid rule identifier') from None
    if str(rule_id) != canonical:
        raise ValueError('Invalid rule identifier')
    return 'buddy-' + canonical


def managed_name(name):
    if not isinstance(name, str) or not name.startswith('buddy-') or policy_name(name[6:]) != name:
        raise ValueError('Only Buddy-managed policy identifiers are accepted')
    return name


def compile_policy(rule):
    """Exact targets and exact current-process binaries, not container isolation."""
    kind = rule.get('kind')
    if kind not in {'file', 'exec'}:
        raise ValueError('Only file-open and executable blocking rules are supported')
    targets = exact_paths(rule.get('paths'), 'Targets')
    binaries = exact_paths(rule.get('binaries'), 'Process binaries')
    return {
        'apiVersion': 'cilium.io/v1alpha1', 'kind': 'TracingPolicy',
        'metadata': {'name': policy_name(rule.get('id'))},
        'spec': {'lsmhooks': [{
            'hook': 'file_open' if kind == 'file' else 'bprm_check_security',
            'args': [{'index': 0, 'type': 'file' if kind == 'file' else 'linux_binprm'}],
            'selectors': [{
                'matchBinaries': [{'operator': 'In', 'values': binaries}],
                'matchArgs': [{'index': 0, 'operator': 'Equal', 'values': targets}],
                'matchActions': [{'action': 'Override', 'argError': -13}],
            }],
        }]},
    }


def render_policy(rule):
    # JSON is valid YAML, avoiding interpolation or an unsafe YAML loader.
    return json.dumps(compile_policy(rule), indent=2) + '\n'


def run_cli(command, *, timeout=15, max_bytes=1024 * 1024):
    """Read at most max_bytes from both pipes; kill/reap on timeout or overflow."""
    try:
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env={'PATH': os.defpath}, shell=False,
                                start_new_session=True)
    except OSError:
        raise EngineError('Tetragon CLI is unavailable or cannot be started') from None
    output = bytearray()
    size = 0
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, 'out')
            selector.register(proc.stderr, selectors.EVENT_READ, 'err')
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise EngineError('Tetragon request timed out; refresh live status before retrying')
                for key, _ in selector.select(min(remaining, .2)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(chunk)
                    if size > max_bytes:
                        raise EngineError('Tetragon response exceeded the permitted size')
                    if key.data == 'out':
                        output.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EngineError('Tetragon request timed out; refresh live status before retrying')
            try:
                returncode = proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise EngineError('Tetragon request timed out; refresh live status before retrying') from None
            if returncode:
                raise EngineError('Tetragon rejected the request; inspect the host daemon logs')
            try:
                return output.decode('utf-8')
            except UnicodeDecodeError:
                raise EngineError('Tetragon returned an invalid response') from None
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()


_STATES = {
    0: 'unknown', 1: 'enabled', 2: 'disabled', 3: 'load_error', 4: 'error',
    5: 'loading', 6: 'unloading', 7: 'skipped', 8: 'partially_enabled',
}
_MODES = {0: 'unknown', 1: 'enforce', 2: 'monitor', 3: 'monitor_only'}


def _enum(value, prefix, numbers):
    if isinstance(value, int) and not isinstance(value, bool):
        return numbers.get(value, 'unknown')
    if isinstance(value, str) and value.startswith(prefix):
        normalized = value[len(prefix):].lower()
        return normalized if normalized in numbers.values() else 'unknown'
    return 'unknown'


class Engine:
    def __init__(self, *, executable=None, address=None, runner=None):
        self.executable = executable or os.getenv('BUDDY_TETRA_BIN', '/usr/local/bin/tetra')
        self.address = address or os.getenv('BUDDY_TETRAGON_ADDRESS', 'unix:///var/run/tetragon/tetragon.sock')
        self.runner = runner or run_cli
        if (not isinstance(self.executable, str) or not self.executable.startswith('/')
                or any(ord(c) < 32 for c in self.executable)):
            raise EngineError('Tetragon executable must be an absolute administrator-configured path')
        if (not self.address.startswith('unix:///') or self.address.startswith('unix:////')
                or not re.fullmatch(r'unix:///[A-Za-z0-9_./-]+', self.address)
                or str(PurePosixPath(self.address[7:])) != self.address[7:]
                or '..' in PurePosixPath(self.address[7:]).parts):
            raise EngineError('Tetragon requires a local UNIX socket address')

    def _call(self, *arguments):
        return self.runner([self.executable, '--server-address', self.address,
                            'tracingpolicy', *arguments])

    def list_policies(self):
        try:
            data = json.loads(self._call('list', '-o', 'json'))
        except (json.JSONDecodeError, TypeError):
            raise EngineError('Tetragon returned an invalid policy list') from None
        if not isinstance(data, dict) or not isinstance(data.get('policies', []), list):
            raise EngineError('Tetragon returned an invalid policy list')
        result = []
        for entry in data.get('policies', []):
            if not isinstance(entry, dict) or not isinstance(entry.get('name'), str):
                raise EngineError('Tetragon returned an invalid policy record')
            # Ignore externally managed policies. Missing domain supports older
            # releases predating domains; an explicit non-grpc domain never matches.
            if entry.get('namespace') or entry.get('domain', '') not in ('', 'grpc'):
                continue
            try:
                name = managed_name(entry['name'])
            except ValueError:
                continue
            result.append({
                'name': name,
                'state': _enum(entry.get('state'), 'TP_STATE_', _STATES),
                'mode': _enum(entry.get('mode'), 'TP_MODE_', _MODES),
                # Raw kernel/CLI error strings may contain host configuration.
                'error': 'Tetragon reports a policy error; inspect host logs' if entry.get('error') else '',
                'domain': entry.get('domain', ''),
            })
        return result

    def status(self):
        try:
            policies = self.list_policies()
        except EngineError as exc:
            return {'connected': False, 'message': str(exc), 'policies': []}
        return {'connected': True, 'message': 'Connected to the host Tetragon daemon', 'policies': policies}

    def add(self, policy):
        # Recompile from the permitted fields reconstructed out of this exact
        # schema, rejecting arbitrary extra hooks/actions sent by another caller.
        try:
            name = managed_name(policy['metadata']['name'])
            hook = policy['spec']['lsmhooks'][0]
            selector = hook['selectors'][0]
            rule = {'id': name[6:],
                    'kind': {'file_open': 'file', 'bprm_check_security': 'exec'}[hook['hook']],
                    'paths': selector['matchArgs'][0]['values'],
                    'binaries': selector['matchBinaries'][0]['values']}
            if policy != compile_policy(rule):
                raise ValueError()
        except (KeyError, IndexError, TypeError, ValueError):
            raise ValueError(brand_text('Only compiled Buddy blocking policies can be applied')) from None
        if any(item['name'] == name for item in self.list_policies()):
            raise EngineError('Policy already exists; refresh live status before retrying')
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', prefix='buddy-tetragon-', encoding='utf-8') as document:
            json.dump(policy, document)
            document.flush()
            self._call('add', document.name, '--mode', 'enforce')
        observed = next((item for item in self.list_policies() if item['name'] == name), None)
        if not observed or observed['state'] != 'enabled' or observed['mode'] != 'enforce' or observed['error']:
            raise EngineError('Policy submission completed but enabled blocking mode was not confirmed; refresh live status')
        return observed

    def remove(self, name):
        managed_name(name)
        if not any(item['name'] == name for item in self.list_policies()):
            return
        self._call('delete', name)
        if any(item['name'] == name for item in self.list_policies()):
            raise EngineError('Policy removal was not confirmed; refresh live status')
