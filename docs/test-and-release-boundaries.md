# Tests and application releases

Keep tests in their existing repository locations (`tests/`, `web/tests/`, plugin
`tests/`, and binding tests). UI browser fixtures remain available for local Vite
and browser testing. Production UI source, public files and compiled assets stay
in the release.

Docker build contexts exclude test directories, conventionally named test files,
local reports and audit artifacts through `.dockerignore`. The standalone ZIP
packager follows the same separation. Runtime Compose services no longer mount
`/opt/bob-a2a/tests`. Both the standard Compose file and the local Wolfi definition
have been updated.

For development that specifically runs integration tests inside the core
container, opt in to the test mount (Compose resolves paths from the first file):

```sh
docker compose -f docker-compose.yml -f docker-compose-extras/docker-compose.tests.yml up -d bob-agent bob-gateway
```

Use the same project name and base Compose definition as your development
installation; for the existing Wolfi installation substitute
`-p bob-acp-wolfi -f <your rendered Compose file>` for the first `-f` pair. Omit the
test override when deploying releases.

SonarQube scans the checkout independently of Docker. Tests are retained in its
test scope through `sonar.tests` and path inclusions; matching source exclusions
prevent double indexing. This classifies tests without suppressing their analysis.
Coverage import is separate; see [the coverage plan](code-coverage-plan.md).

The converted named Node regression cases run with Node 24:

```sh
cd web
node --test tests/*.test.cjs tests/officeFolders.test.ts tests/welcomeTranslations.test.ts
```

The Java binding regression uses JUnit through `mvn test` in `bindings/java`
with Java 21. Translation audits deliberately fail when required catalog entries
are missing; see the review notes for the last observed failures.
