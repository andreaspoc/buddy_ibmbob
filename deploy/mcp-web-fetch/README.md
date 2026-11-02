# Public web Fetch MCP

Installed in this assistant host's global Codex MCP configuration as `web-fetch`, using the maintained `mcp-server-fetch` package pinned to `2026.10.19`. This is separate from the Buddy connection catalogue.

Build:

```bash
docker build -t local/mcp-web-fetch:2026.10.19 deploy/mcp-web-fetch
```

Registration:

```bash
codex mcp add web-fetch -- docker run --rm -i --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 --memory=256m --cpus=1 --tmpfs /tmp:rw,noexec,nosuid,size=32m local/mcp-web-fetch:2026.10.19
```

The non-root container has no host data mounts or credentials. Upstream default public-address and robots policies remain enabled. `fetch` returns readable public HTTP(S) content, supports bounded output and continuation, and does not run website JavaScript or authenticate to private sites. Login, paywall, anti-bot or JavaScript-only pages may not be readable.

Smoke check:

```bash
docker run --rm -i --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 --memory=256m --cpus=1 --tmpfs /tmp:rw,noexec,nosuid,size=32m --entrypoint python3 local/mcp-web-fetch:2026.10.19 - < deploy/mcp-web-fetch/smoke_test.py
```

Verified through MCP: OWASP AI Agent Security Cheat Sheet and example.com fetch successfully; loopback and cloud metadata destinations are rejected. Evidence is in `artifacts/mcp-web-fetch-2026-10-24`. Registration was also exercised through the exact configured Docker command using JSON-RPC initialization, tools/list and tools/call. The current conversation's callable tool inventory did not automatically gain the tool; refresh/restart the local client or start a new local Codex session to load the configuration.

Sources: https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md and https://learn.chatgpt.com/docs/extend/mcp .
