# Store application data on remote PostgreSQL

Use `docker-compose.remote.yml` as a standalone Compose file. It runs the API,
chat worker and knowledge worker, with no local PostgreSQL service. All three use
`DATABASE_URL`. Accounts, sessions, conversation histories, job events, uploaded
and generated files, repositories, skills, settings and knowledge documents stay
in the existing PostgreSQL schema; changing the database location requires no
application storage rewrite.

Use PostgreSQL 17 or newer and a direct connection endpoint. The application uses
LISTEN/NOTIFY and advisory locks, so a transaction-pooling endpoint is unsuitable.
The database account needs permission to create and alter tables and indexes.
No pgvector extension is currently required. Keep the server available whenever
the application is used. Remote latency affects database-backed operations.

## New installation

Add `DATABASE_URL` to the ignored root `.env`, alongside existing runtime settings.
See `remote-database.env.example`. Percent-encode special characters in URI
credentials. Use the provider's TLS certificate configuration; the example uses
`sslmode=verify-full`. A private certificate authority also requires a certificate
file mounted into all three services and `sslrootcert` in the URI.

From the project root:

```sh
docker compose -f docker-compose.remote.yml config --quiet
docker compose -f docker-compose.remote.yml up -d --build
```

The remote configuration uses application code and compiled assets inside the
images. Rebuild after source changes. Preserve the existing workspace templates
and `.bob-private` configuration when moving the application to another host.

## Move the existing installation

1. Provision an empty remote database. Keep existing `.env` settings and add its
   direct `DATABASE_URL`. Do not switch the application before restoring data.
2. Let active jobs finish, then stop all application services so the dump and
   restored database represent the same state:

   ```sh
   docker compose stop bob-agent bob-worker knowledge-worker
   docker compose exec -T postgres pg_dump -U bob -d bob \
     --format=custom --no-owner --no-acl > bob-before-remote.dump
   ```

3. Restore into the empty destination using the PostgreSQL client container. This
   command reads credentials from `.env` without putting them in shell arguments:

   ```sh
   docker run --rm --env-file .env -v "$PWD:/backup:ro" postgres:17-alpine \
     sh -c 'exec pg_restore --dbname="$DATABASE_URL" --no-owner --no-acl --exit-on-error /backup/bob-before-remote.dump'
   ```

   Use a client version matching the source server (17 for the bundled database).
   If restore fails, fix the cause and recreate the empty destination before
   retrying; a failed restore may leave partial tables. Keep the local database.

4. Compare row counts for every application table on both databases. Check total
   stored file bytes, then start the remote configuration and sign in to verify
   old histories, project files, downloads, knowledge search and a new chat:

   ```sh
   docker compose -f docker-compose.remote.yml up -d --build
   curl -f http://localhost:8080/health
   docker compose -f docker-compose.remote.yml logs --tail=50 bob-agent bob-worker knowledge-worker
   ```

   `/health` is a basic liveness check; it does not prove the migration succeeded.
   Preserve your existing authentication settings so account access is unchanged.

5. Stop the old local PostgreSQL service once the remote installation is verified:

   ```sh
   docker compose stop postgres
   ```

   This preserves its volume as a rollback copy. Local disk space from that volume
   is recovered only after its eventual removal. Retain an independently verified
   backup and confirm remote backups before removing any old data. Do not use
   `docker compose down -v`, because it also removes the model volume.

For rollback before accepting new remote writes, stop the remote application and
start the original `docker-compose.yml`. That file still uses the original local
PostgreSQL database. After new remote writes, returning to the old database loses
those writes unless they are migrated back first.

## What still occupies local storage

- Runtime images and temporary job workspaces (deleted after runs).
- Docling's persistent downloaded models and locally hosted Ollama models.
- Shipped workspace resources, Bob configuration and retained legacy user files.
- A migration dump or old database volume retained for rollback.

Moving the entire Compose application to a server also moves runtime/model disk
usage off your laptop. Set its public URL and authentication callback URLs for
that server. Legacy `workspace/users` files are separate from the current
PostgreSQL store: use the existing verified storage migration before removing
those copies. Merely setting `DATABASE_URL` does not import legacy directories.
