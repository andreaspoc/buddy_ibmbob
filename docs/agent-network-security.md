# Docker agent network and runtime security

Buddy runs in Docker. Tetragon is a host security component, controlled by the
separate [Tetragon plugin app](../plugins/tetragon/README.md). The plugin has an
administrator-only Carbon screen, persistent rule configuration and audit, and
real apply/remove/status operations through the host daemon's private Unix socket.
Agent and worker containers do not receive that socket.

The initial curated rules reject new opens of exact file paths and execution of
exact executable paths, scoped to exact caller executable paths. They use LSM
Override with permission denied. Kernel BPF LSM support is required. Matching
binary paths can occur on the host and in multiple containers; these rules are
not Docker container identity isolation. Existing file descriptors, alternate
paths and different executable paths require additional controls and validation.
An engine reporting enabled/enforce means loaded, not a demonstrated block.

Network blocking is a separate layer. Use a container/host firewall or controlled
egress gateway for default-deny destination IP/port rules. Account for Docker's
forwarding/NAT chains, IPv4 and IPv6, alternate DNS, and access to host services.
For domain restrictions prefer a constrained egress gateway. Blocking an executable
such as curl does not block Python or another program from opening network sockets.
The first plugin release intentionally does not claim to apply network rules.

The current Bubblewrap agent sandbox isolates filesystem/process views but shares
networking. Keep broker-side exact-action approvals and SSRF protections. Model
processes must not receive the plugin's authentication secrets or host-control
socket. Move execution to separate runner containers before assuming network rules
can distinguish model tools from their parent service's database clients.

Validate allowed and forbidden operations with synthetic data on the actual host;
verify the intended side effect did not occur. Test daemon restart and reload as
well as initial application. The pinned daemon does not automatically persist
gRPC policies across restarts; missing policies are shown by live status and must
be explicitly reapplied. See the plugin README for rollout commands and limits.

Sources:

- [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [Tetragon enforcement](https://tetragon.io/docs/concepts/enforcement/)
- [Tetragon Docker setup](https://tetragon.io/docs/getting-started/install-docker/)
