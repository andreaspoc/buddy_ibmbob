# Buddy Tetragon plugin app

A separate Docker app for administrators to preview, save, apply and remove
curated Tetragon blocking policies. It uses Buddy's shared session authentication
and Carbon React UI, and appears in Apps. The plugin uses the host daemon's Unix
gRPC socket through a bundled `tetra` client; it does not simulate applied rules.
The API is under `/api/tetragon` and the standalone screen under `/tetragon/`.

## Supported rules and scope

The first release supports exact-path file-open denial and exact-path executable
denial, with mandatory exact process-binary scope. Generated LSM policies use
`Override` with permission denied, rather than relying on killing a process after
an operation. Arbitrary YAML, arbitrary kernel hooks and shell commands are not
accepted. Network/domain blocking, directory-prefix matching, wildcard binary
rules and blanket shell/namespace denial are outside this release.

**Binary scope is not Docker-container scope.** A matching executable path can
exist in several containers and on the host; the rule can affect all of them.
Conversely, a different executable can escape a narrowly scoped binary rule.
This is an additional preventive control, not a complete sandbox or a replacement
for broker authorization. File-open rules do not revoke already open file
descriptors or cover every other means of obtaining data. Test executable rules
against the exact caller and launched binary on the selected kernel/release.

## Docker setup

The overlay `docker-compose.tetragon.yml` adds the plugin and an optional host
daemon. It publishes no plugin, gRPC, health or metrics ports. Only the plugin
receives the shared Unix socket; agent and worker containers do not. The web
plugin has no Docker socket, no host PID namespace, no capabilities and a
read-only root filesystem. Its root UID is retained to access the daemon's
root-owned socket. Possession of that socket is security-administrator authority;
keep this app restricted to trusted Buddy administrators.

The separately profiled `tetragon-host` service is privileged and shares host PID
and cgroup namespaces because the daemon must attach kernel BPF programs. It is a
host security component, not an agent tool. Do not start a second daemon on a host
already managed by Tetragon. The default official image and bundled CLI are pinned
to v1.7.1 and its published image digest. If overriding `TETRAGON_IMAGE`, use the
same reviewed image for the daemon and CLI build. Validate compatibility before
upgrading.

1. Confirm the Docker daemon runs on a Linux host with BTF at
   `/sys/kernel/btf/vmlinux`, BPF LSM support enabled in the running kernel, and
   suitable BPF/LSM permissions. A successful container start does not establish
   compatibility. Docker Desktop on macOS is not supported by Tetragon's Docker
   quickstart. Review the official prerequisites linked below.
2. Build the updated core image so the plugin gateway/Apps integration is present,
   and build the plugin from the repository root. Use the same base/override
   Compose files as the existing installation, adding this overlay last:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.tetragon.yml config --quiet
   docker compose -f docker-compose.yml -f docker-compose.tetragon.yml build bob-agent tetragon-plugin
   ```

3. If there is no existing host daemon, a deployment administrator can explicitly
   start the privileged component and inspect startup diagnostics:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.tetragon.yml --profile tetragon-host up -d tetragon-host
   docker compose -f docker-compose.yml -f docker-compose.tetragon.yml --profile tetragon-host logs --tail=100 tetragon-host
   ```

4. Deploy the plugin and updated core through the normal maintenance process:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.tetragon.yml up -d tetragon-plugin bob-agent bob-gateway
   ```

For the remote-database installation, substitute `docker-compose.remote.yml` for
the local base throughout. Retain every other overlay already used by the
installation; the examples show only the relevant files. `DATABASE_URL` must
point to Buddy's database so the plugin can validate the original session and
current administrator role. `/ready` tests app readiness, not kernel protection;
the screen's connection and per-policy status supply the latter integration view.

For an existing Tetragon daemon, do not enable the `tetragon-host` profile. Override
the plugin's socket-directory volume with the daemon's existing Unix socket
directory, and configure the fixed address server-side. Do not expose unauthenticated
Tetragon TCP gRPC to the Docker network. Compose's default socket volume is for
the included daemon; it is not automatically connected to a separately installed
one.

## Persistence and state

Rule definitions and administrator audit history live in the plugin's persistent
`buddy-tetragon-data` volume. Back it up as administrative configuration. An app
database row saying enabled is a requested state, not proof that a BPF program is
loaded. The screen checks the actual daemon and distinguishes a saved draft,
loaded policy, missing policy, daemon error and disconnection. Loaded does not
mean a synthetic blocking test has been passed.

The pinned daemon is not configured with automatic persistence of dynamically
added gRPC policies. Restarting or replacing it can remove active policies.
The plugin does not automatically apply saved rules during startup. Refresh
status and explicitly reapply missing policies after a daemon restart, then
repeat the blocking checks. Do not use this deployment as an assurance of
continuous protection across restarts without an independently validated host
policy lifecycle. Stopping the web plugin alone need not unload already loaded
daemon policies; removal must be performed through the rule action or host admin.

## Prove blocking before relying on a rule

Use a disposable test container and synthetic fixture paths. Never use real
credentials for validation. Start with an allowed control: the selected process
can read a synthetic file or launch a harmless test executable. Save and preview
the exact rule, apply it, refresh the actual daemon status, then repeat the same
operation. A file read must return permission denied and disclose no contents;
an executable test must fail before the test program produces its expected side
effect. Test an allowed control after application as well.

For example, use an isolated container based on a reviewed Buddy runtime image,
create two synthetic fixture files inside it, and choose its actual resolved
`cat` binary path as process scope. Deny opening just one fixture and verify the
other remains readable. Remove the rule through the screen and confirm access
returns. Do not use a generic host-wide path such as `/etc/passwd` for the first
test. Record the image, kernel, caller binary, target, daemon policy state and
observed result. Repeat after workload and daemon restart. YAML admission, a
policy listed as enabled, a process exit, or an alert is insufficient by itself.

No live host-blocking test is implied by building this plugin. Installation and
kernel validation are separate deployment steps; the screen remains disconnected
until its real daemon is reachable.

References:

- [Official Docker installation and prerequisites](https://tetragon.io/docs/getting-started/install-docker/)
- [Tetragon v1.7.1 release](https://github.com/cilium/tetragon/releases/tag/v1.7.1)
- [LSM hook points](https://tetragon.io/docs/concepts/tracing-policy/hooks/)
- [Override blocking semantics](https://tetragon.io/docs/concepts/enforcement/)
