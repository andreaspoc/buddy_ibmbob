# Measured coverage for SonarQube

The configuration follows [SonarQube's Python coverage documentation](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/test-coverage/python-test-coverage): generate measured coverage before scanning, then import the XML report.

The scanner receipt in `.scannerwork/report-task.txt` identifies project `docker`.
The project previously had no root coverage-report configuration or generated
coverage XML. The initial investigation found no coverage tool; the project `.venv` now has coverage.py and the focused report workflow has been verified.
These observations explain the missing local report workflow; they do not prove
which scanner arguments or server-side settings were used externally.

Use the same Python environment for dependencies, tests and coverage:

```sh
python3 -m pip install -r requirements-test.txt
python3 scripts/sonar_python_coverage.py
```

Then run the usual SonarQube analysis from the project root. The new
`sonar-project.properties` sets the established project key and imports
`reports/sonar-python/coverage.xml`. Keep the existing scanner authentication,
server address and other analysis options. If the invocation overrides
`sonar.python.coverage.reportPaths`, point it at that report explicitly.

The script runs the existing focused regression suites by default. It measures
branches and relative file paths across `app`, `bindings` and `plugins`, including
unexecuted Python modules in those directories. To measure a broader set of tests,
pass unittest module names or discovery arguments; install the runtime dependencies
in `requirements.txt` and any suite-specific dependencies first:

```sh
python3 scripts/sonar_python_coverage.py tests.test_office tests.test_storage_restore_performance
# Or, in an environment prepared for the full test suite:
python3 scripts/sonar_python_coverage.py discover -s tests -p 'test_*.py'
```

The script removes stale XML before checking dependencies and publishes XML only
after tests pass. It does not run the scanner or change a quality gate. Check the
scanner logs for Python coverage import and path-resolution warnings.

This workflow measures Python in the current test process. It does not collect
JavaScript/TypeScript coverage or Python subprocess coverage. Those need their
own instrumentation and imported reports. Passing tests alone does not establish
80% new-code coverage, and importing this report may leave the quality gate failing.
The scanner excludes installed `node_modules` dependencies, including upstream
demo pages. No first-party source, test or coverage exclusions were added to
improve the reported percentage.

## Run the prepared coverage-and-scan command

From the repository root:

```sh
./scripts/run_sonar_scan.sh
```

The executable script reads the SonarQube token from the existing Codex MCP
configuration at runtime, without copying it into the repository. `SONAR_TOKEN`
can override it. The server defaults to `http://127.0.0.1:9000`; set
`SONAR_HOST_URL` if needed. It generates Python XML using `.venv/bin/python`,
then runs the direct-import UI coverage suite in Node 24 Docker to produce
`web/coverage/lcov.info`. Finally it runs the Docker Sonar scanner with the
checkout mounted at the same path, imports both reports and waits for the quality
gate. A failed gate makes the scanner return a nonzero status even when analysis
submission succeeded. Coverage does not depend on redeploying the app.

Prerequisites: Docker access, Python test dependencies in `.venv`, and current
UI dev dependencies (`docker run --rm -v "$PWD:/src" -w /src/web node:24-bookworm npm ci`).
Use `.venv/bin/python -m pip install -r requirements-test.txt` to install the
Python coverage tool, plus any runtime dependencies required by selected tests.
Set `COVERAGE_PYTHON` to use another prepared Python interpreter. Do not run the
script with shell tracing (`bash -x`), which could expose environment secrets.

The UI suite is selected with `web/vitest.config.ts`, measures actual TypeScript
imports, and includes unexecuted production UI source in its denominator.
Broader UI regression scripts and translation audits remain separate and are
not claimed to pass or contribute coverage here. Current reports are an initial
baseline, not 80% new-code coverage. Generate reports before every scan; do not
reuse reports from another source revision. Confirm the scanner logs contain
Python coverage import and JavaScript/TypeScript LCOV import without path errors.

The initial Python unit-test stage runs without a database and may report skips
for database integration cases. The scan script subsequently runs those cases
against a disposable PostgreSQL container and appends their measured coverage.
The Python coverage runner also executes the four visual document export tests
with a local Chromium when available. A missing browser is reported explicitly.
The bubblewrap sandbox integration test requires a host that permits the required
namespaces and remains skipped when that capability is unavailable. Check each
stage's output rather than interpreting the initial skip count as the number of
tests omitted from the complete workflow.
