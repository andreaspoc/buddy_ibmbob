# Direct HTTP deployment

The application exposes HTTP directly on port 3000 without Nginx.
Run commands from the existing deployment directory to preserve the Compose
project and its persistent data.

Configure the existing `.env`:

```dotenv
PUBLIC_BASE_URL=http://192.0.2.10:3000
KEYCLOAK_REDIRECT_URI=http://192.0.2.10:3000/auth/keycloak/callback
BOB_UI_SECURE_COOKIE=0
```

Register `http://192.0.2.10:3000/auth/keycloak/callback` as a Valid redirect
URI in the Keycloak client. If Web origins are configured, use
`http://192.0.2.10:3000`. Keep the remote Keycloak issuer URL as configured.

Remove the old HTTPS proxy container and recreate the application:

```bash
docker compose -f docker-compose.yml up -d --remove-orphans --force-recreate bob-agent bob-worker
curl -sS -D - -o /dev/null http://192.0.2.10:3000/auth/keycloak/login
```

The login endpoint should redirect to Keycloak. Open the application at
`http://192.0.2.10:3000`.

For the remote database deployment, use `docker-compose.remote.yml` in place
of `docker-compose.yml`. Add `--build` if application code has changed in a
deployment without source bind mounts.
