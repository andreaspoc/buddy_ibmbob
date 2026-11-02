# Isolated PostgreSQL integration tests

Run `bash scripts/test_isolated_postgres.sh` from the repository root. Docker,
the `postgres:17-alpine` image and the project's Python test dependencies are
required. The script starts a disposable PostgreSQL container bound to a random
loopback port, creates separate application and Learning fixture databases, and
removes the container on exit. It does not use the application's database URL.

Run `BUDDY_DB_COVERAGE=1 bash scripts/test_isolated_postgres.sh` to append the
integration tests to the coverage data created by
`.venv/bin/python scripts/sonar_python_coverage.py`. Then run
`.venv/bin/python -m coverage xml --rcfile=.coveragerc.sonar` before importing
the report into SonarQube. Re-running the standard coverage script erases the
previous coverage data, so append the database run afterward. The full
`scripts/run_sonar_scan.sh` workflow performs these steps automatically.

The runner covers Learning deletion, People/community and call audio, notes and app-action
tests, plus chat idempotency, knowledge access and audit, document attachments,
presentation deletion, notifications, conversation titles and OAuth integrations.
The note PDF integration test runs when Chromium is available through
`RESEARCH_CHROMIUM_PATH`, `/usr/bin/chromium`, or Playwright. It is reported
as skipped when Chromium is unavailable. Other browser and Bubblewrap tests
have separate environment requirements.

The runner also exercises artifact provenance, expired-job recovery and blob storage in isolated schemas.

The full scan also runs the Go and Java binding tests in their respective
containers and imports their Go coverage and JaCoCo reports. It imports the
Node binding coverage from the UI Vitest report.
