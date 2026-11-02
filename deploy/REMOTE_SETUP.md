# Remote server upgrade

The ZIP includes .env.example, never your credentials or user data. Extract into a
staging directory first, then copy application files into the existing deployment.
Keep your existing .env, .bob-private, workspace, database volume, and Compose project
name. Do not run `docker compose down -v`. Running from a new project directory can
create new containers and volumes instead of updating the existing installation.

## Recover settings before changing anything

Your running container already has DATABASE_URL. From the EXISTING app directory:

```bash
umask 077
cp .env .env.backup  # if .env exists
# Only run if DATABASE_URL is missing from .env; never print this value publicly.
docker exec bob-acp-bob-agent-1 sh -c 'printf "DATABASE_URL=%s\n" "$DATABASE_URL"' >> .env
```

Keep the existing Bob API key and Keycloak/Microsoft/S3 credentials in .env. If
missing, recover them from your server's secret store or running container before
recreating it. Quote .env values containing `$` with single quotes to prevent
Compose interpolation. DATABASE_URL must contain a percent-encoded password.

## Configure

Compare .env.example against your existing .env; do not overwrite your credentials.
Set PUBLIC_BASE_URL to the exact public app origin, including HTTPS and any port.
Leave KEYCLOAK_REDIRECT_URI blank to derive it from PUBLIC_BASE_URL, or set it to
PUBLIC_BASE_URL followed by /auth/keycloak/callback. Register that exact callback
in Keycloak's Valid redirect URIs. Clear an old localhost AZURE_REDIRECT_URI too.
KEYCLOAK_HOST_IP is optional; normal DNS is used when it is blank.

`docker-compose.remote.yml` connects to an existing PostgreSQL database using
DATABASE_URL. It does not create PostgreSQL. POSTGRES_PASSWORD alone is insufficient.
`docker-compose.yml` creates PostgreSQL using POSTGRES_USER, POSTGRES_DB and
POSTGRES_PASSWORD; its DATABASE_URL must point to that same database. Existing
PostgreSQL volumes retain their original credentials and database names.

## Validate and deploy

From the existing deployment directory (or supply its original project name with -p):

```bash
docker compose --env-file .env -f docker-compose.remote.yml config --quiet
docker compose --env-file .env -f docker-compose.remote.yml up -d --build
docker compose --env-file .env -f docker-compose.remote.yml ps
docker compose --env-file .env -f docker-compose.remote.yml exec bob-agent printenv PUBLIC_BASE_URL KEYCLOAK_REDIRECT_URI
```

Start a fresh login attempt after deployment. A blank KEYCLOAK_REDIRECT_URI is
expected when the callback is derived from PUBLIC_BASE_URL.

Container paths and standard provider URLs retain portable defaults; deployment
addresses, credentials, database identity, model settings, service endpoints, ports
and resource budgets can be overridden through .env. Kubernetes manifests are a
separate deployment path and are not configured by Docker Compose's .env.
