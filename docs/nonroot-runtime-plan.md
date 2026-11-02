# Runtime privilege review

## Knowledge worker: implemented

Both knowledge Dockerfiles create UID/GID 10001 and run as that identity. The
model and cache directories belong to that user. Compose drops all capabilities
and enables no-new-privileges. The deployed Wolfi image is
`bob-acp-knowledge-worker:nonroot-20261027`; it reuses the previous worker image's
installed dependencies and adds the tested account/cache layer.

The existing `bob-acp-wolfi_bob-docling-models` volume is retained. For this
installation it contained no cached model payloads; only the volume root and the
two newly created cache directories were assigned to UID/GID 10001. No recursive
ownership changes or model-data deletion were performed. The frozen Wolfi Compose
definition now explicitly refers to that existing volume.

Verification: the image runs as 10001, Docling/application imports succeed with
network disabled and capabilities dropped, and cache-file creation/cleanup
succeeds. The deployed worker logs its ready message as UID 10001 with
no-new-privileges enabled and the original model volume mounted.

## Core runtime: migration still required

The two core runtime Dockerfiles still default to root. An actual execution of
`python3 -m app.agent_sandbox` as UID 10001 passes in the existing app container,
so the namespace isolation check itself is not a blocker. However, UID 10001
cannot read the existing `/root/.bob` mount. Other defaults use that root path
for MCP settings, voice configuration and a legacy worker database. A global
USER change alone would break those paths and potentially existing private
workspace files. The warnings are left open; no security suppression was added.

Before deploying a non-root core:

1. Standardize the service home at `/home/buddy` and relocate the private settings
   mount there. Update the explicit settings environment and remaining root-path
   defaults, while preserving saved configuration and credentials.
2. Inventory the owners/modes of the private settings and workspace mounts;
   record restorable metadata, stop writers, and migrate only the required owned
   paths to UID/GID 10001. Do not loosen `/root` permissions.
3. Add the service identity to both runtime images. Keep package installation in
   a root build phase; ensure each derived plugin image returns to its intended
   unprivileged identity after installation.
4. Verify authentication, settings reload, MCP credential resolution, old/new
   workspace restores, broker socket access, the real sandbox check and worker
   persistence against an isolated installation.
5. Roll out the core/worker/plugin changes together and check live health and
   saved-state compatibility. Retain the previous images and ownership metadata
   for rollback.
