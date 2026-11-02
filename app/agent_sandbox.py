"""Fail-closed Linux filesystem/process isolation for every model runtime.

Only runtime libraries, read-only application code, this run's writable home and
workspace, and its exact broker sockets are visible. Never bind the host root.
Network connectivity is retained for the provider and local authenticated gateway;
deployments must apply an egress policy independently.
"""
from __future__ import annotations

from pathlib import Path
import shutil


def sandbox_command(command, *, workspace, environment):
    executable = shutil.which('bwrap', path='/usr/bin:/bin')
    if not executable:
        raise RuntimeError('Agent isolation unavailable: install bubblewrap and enable Linux user namespaces. No agent was started.')
    if not environment or not environment.get('HOME') or not workspace:
        raise RuntimeError('An isolated agent home and workspace are required')
    work = Path(workspace).resolve(strict=True)
    home = Path(environment['HOME']).resolve(strict=True)
    code = Path(__file__).resolve().parent
    protected = (Path('/'), Path('/tmp'), Path('/root'), Path('/home'), Path('/workspace'),  # noqa: S5443
                 Path('/opt'), Path('/usr'), code, code.parent)
    privileged = (code, Path('/usr'), Path('/etc'), Path('/proc'), Path('/sys'), Path('/dev'), Path('/run'))
    for folder in (work, home):
        if not folder.is_dir() or folder in protected or any(folder == p or folder in p.parents or p in folder.parents for p in privileged):
            raise RuntimeError('Refusing an agent sandbox with a shared or privileged writable root')
    if work == home or work in home.parents or home in work.parents:
        raise RuntimeError('Agent home and workspace must be separate directories')

    args = [executable, '--die-with-parent', '--new-session', '--unshare-user',
            '--uid', '65534', '--gid', '65534', '--unshare-pid', '--unshare-ipc',
            '--unshare-uts', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp']  # noqa: S5443
    # These contain runtime binaries/libraries, not service/user configuration.
    for name in ('/usr', '/bin', '/sbin', '/lib', '/lib64'):
        source = Path(name)
        if source.is_symlink():
            args.extend(['--symlink', str(source.readlink()), name])
        elif source.exists():
            args.extend(['--ro-bind', name, name])
    for name in ('/etc/ssl/certs', '/etc/ca-certificates.conf', '/etc/resolv.conf',
                 '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/etc/fonts',
                 '/etc/passwd', '/etc/group', '/etc/ld.so.cache'):
        if Path(name).exists():
            args.extend(['--ro-bind', name, name])
    args.extend(['--ro-bind', str(code), str(code)])
    # Bind exact directories, never parent caches or sibling users' homes.
    for folder in (work, home):
        args.extend(['--bind', str(folder), str(folder)])
    # Job workspaces point .bob at the current owner's restored skill/config
    # tree. Expose only that tree read-only, never the containing user directory.
    settings = work / '.bob'
    if settings.is_symlink():
        target = settings.resolve(strict=True)
        expected = home.parent / '.bob'
        if target != expected or not target.is_dir():
            raise RuntimeError('Workspace settings must belong to this agent home')
        args.extend(['--ro-bind', str(target), str(target)])
    for key in ('BOB_MCP_SOCKET', 'BOB_KNOWLEDGE_SOCKET'):
        if environment.get(key):
            socket = Path(environment[key]).resolve(strict=True)
            if not socket.is_socket():
                raise RuntimeError('Agent broker path is not a Unix socket')
            args.extend(['--ro-bind', str(socket), str(socket)])
    args.extend(['--chdir', str(work), '--', *command])
    return args


def main():
    """Deployment gate: exercise the real namespace boundary, never skip it."""
    import os
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory(prefix='buddy-isolation-check-') as directory:
        root = Path(directory)
        work, home = root / 'work', root / 'home'
        work.mkdir(); home.mkdir()
        sibling = root / 'sibling-fixture'
        sibling.write_text('synthetic isolation check')
        environment = {'HOME': str(home), 'PATH': os.defpath}
        script = 'test ! -e "$1" && test ! -e /root/.bob && test ! -w "$2" && touch "$3/allowed"'
        command = sandbox_command(['/bin/sh', '-c', script, 'check', str(sibling),
            str(Path(__file__).parent / '__init__.py'), str(work)], workspace=work, environment=environment)
        subprocess.run(command, env=environment, check=True, timeout=15)
        if not (work / 'allowed').is_file():
            raise RuntimeError('Sandbox workspace is not writable')
    print('Agent filesystem/process isolation check passed')


if __name__ == '__main__':
    main()
