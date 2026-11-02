# Agent runtime isolation

All Bob model processes now require Linux bubblewrap. The runtime image installs
it, but existing images must be rebuilt. The service refuses to start an agent
when bubblewrap is absent; a kernel/container policy denying its required
namespaces also stops the launch. There is no unsandboxed fallback.

The policy creates a fresh mount namespace with no host-root mount. Runtime
binaries/libraries, selected non-secret system configuration and the application
package are read-only. Only the current attempt's workspace and home are writable.
The current owner's restored skill settings are read-only. Other users' state,
service secrets and private caches are not mounted. Only the two exact per-run
broker Unix sockets are mounted, rather than their parent temporary directories.
The process uses namespace UID/GID 65534, no capabilities, a private PID namespace,
private IPC/UTS namespaces, a new session, and parent-death cleanup.

Before rollout, run `python3 -m app.agent_sandbox` inside the built runtime. This
deployment gate fails, rather than skips, when isolation is unavailable. Also run
`python3 scripts/verify_agent_security.py --require-sandbox` from a source checkout
in the execution environment to exercise all security regressions. The isolation
test checks a sibling file is hidden, the workspace is writable, and application
source is read-only. The host must permit bubblewrap's user, mount and PID
namespaces. Do not work around failures by enabling privileged containers or
disabling sandboxing; use an execution environment that supports those namespaces.

Network connectivity is retained because the Bob provider and authenticated local
team gateway require it. Apply an infrastructure egress policy for the execution
service and restrict provider credentials/quotas separately. This filesystem and
process boundary is not a network egress filter or a defense against kernel bugs.
The selected workspace and home are deliberately writable and remain lower-trust
state; instruction text stored there is not an authorization decision.

Reference: [bubblewrap security model](https://github.com/containers/bubblewrap/blob/main/README.md).

## Docker host policy

The core API, gateway, worker and Office service use `buddy-sandbox` AppArmor
and `deploy/security/buddy-sandbox-seccomp.json`. Before creating these containers,
run `sudo bash scripts/install_agent_security.sh` on the Linux Docker host. The
profile is saved under `/etc/apparmor.d` so AppArmor reloads it at boot. Rebuild
older runtime/core/plugin images to include bubblewrap; a restart alone cannot
add the missing executable.

Docker's default seccomp/AppArmor policies block nested sandbox namespace mounts.
The custom profiles retain default syscall-denial behavior, add the namespace and
mount operations required by bubblewrap, and grant no outer `SYS_ADMIN` capability.
`systempaths=unconfined` removes Docker's locked proc submounts, which otherwise
prevent creating a private proc filesystem in a child user namespace. The
AppArmor policy explicitly denies access to the normally masked kernel interfaces
and writes to Docker's normally read-only proc paths. The bubblewrap process still
has its own PID/mount/user namespaces, restricted root, and dropped capabilities.
No privileged container or unsandboxed model fallback is used.

The profiles derive from Moby's Apache-2.0 licensed defaults:
https://github.com/moby/profiles/blob/main/seccomp/default.json and
https://github.com/moby/profiles/blob/main/apparmor/template.go (snapshot 2026-10-25).
Validate on the target host using `docker compose exec -T bob-agent python3 -m
app.agent_sandbox` and repeat for `office-plugin` and `bob-worker` after recreating
containers. Health checks alone do not verify model execution.
