# HTTPS proxy

This optional overlay adds HTTPS on port 443 and preserves the existing HTTP
listener on loopback for local development and diagnostics. The app HTTP binding
uses `BOB_HTTP_BIND_IP` (default `127.0.0.1`), independently of the HTTPS binding. It supports streaming, WebSockets, and 50 MB uploads.

Before activation:

1. Choose the canonical hostname and point its DNS to this host. The user's
   browser must be able to reach it.
2. Install its trusted certificate chain at `certs/fullchain.pem` and private key
   at `certs/privkey.pem`. Certificate files are ignored by Git. The existing
   self-signed private-IP certificate does not provide public certificate trust.
3. Set `PUBLIC_BASE_URL=https://YOUR_HOSTNAME`,
   `KEYCLOAK_REDIRECT_URI=https://YOUR_HOSTNAME/auth/keycloak/callback`,
   `AZURE_REDIRECT_URI=https://YOUR_HOSTNAME/auth/microsoft/callback`, and
   `BOB_UI_SECURE_COOKIE=1` in `.env`.
4. Register the HTTPS callback in the Keycloak application client before switching
   the application URL. Register the Microsoft callback in Azure where used.
   Pre-registered MCP OAuth clients need
   `https://YOUR_HOSTNAME/mcp-oauth/callback` as their redirect URI.

Validate and activate from the repository root:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.https.yml run --rm --no-deps https-proxy nginx -t
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d bob-agent bob-worker https-proxy
curl --fail https://YOUR_HOSTNAME/auth/status
```

Use `docker-compose.remote.yml` as the first file for remote-database deployments.
Verify SSO, connector sign-in, chat streaming, and uploads before deployment. Secure session cookies require HTTPS after the switch.

## Current self-signed private-IP deployment

The canonical address is `https://192.0.2.10`. `.env` selects both Compose
files through `COMPOSE_FILE`, so normal `docker compose` and `start.sh` operations
retain the proxy. The current certificate includes the IP address as a SAN and
expires on 2027-10-09. Import only `certs/fullchain.pem` into client trust stores;
never distribute `certs/privkey.pem`.

Verified: HTTPS status endpoint with the certificate explicitly trusted, proxy
configuration, secure SSO state cookies, and HTTPS OAuth callback generation.
Keycloak currently rejects the HTTPS callback until its administrator registers
`https://192.0.2.10/auth/keycloak/callback` in the application client's Valid
redirect URIs. If Web origins are set, include `https://192.0.2.10`.
The application credentials cannot obtain a client-credentials service token to
perform this external registration. New sign-in remains blocked until it is done.

Some external connector providers may reject private-IP or self-signed HTTPS
callbacks. Provider acceptance is separate from the application's HTTPS check.
