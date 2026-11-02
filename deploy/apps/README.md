# Installed application launchers

Office and people chat register automatically through their deployment selections. Other installed applications can add a JSON manifest to this directory; the authenticated Apps view and command palette discover it on refresh, browser focus or within 30 seconds. No frontend rebuild is needed for these links.

Example (save with a `.json` extension only after deploying the application):

```json
{
  "id": "team-portal",
  "name": "Team portal",
  "description": "Your installed team portal",
  "url": "https://portal.example.com/",
  "enabled": true,
  "desktop_only": false,
  "groups": ["administrators", "engineering"]
}
```

Use a unique lowercase ID. URLs may be HTTPS or a same-origin absolute path. Registered links open in a new tab; installing a manifest does not deploy a service, create proxy routes, embed its UI or grant access inside that application. Deploy the actual app and its route/SSO first. Missing/invalid manifests are ignored, not executed.

Optional `users` contains exact Buddy usernames; optional `groups` supports `administrators` and the name of any group created under Administration. Either allowlist grants visibility; omitting both makes the launcher visible to all signed-in Buddy users. `desktop_only` hides a launcher on mobile. Disabling/removing a manifest removes its launcher without deleting application data. Reserve the built-in IDs (including `office`, `people`, `docmost`) for Buddy.

This directory is mounted read-only into core at `/opt/bob-a2a/app-manifests`. Only deployment administrators should edit it. Keep credentials, tokens and user data out of manifests and launch URLs. A temporary app outage does not unregister it; Apps is installation discovery, not a health monitor.
