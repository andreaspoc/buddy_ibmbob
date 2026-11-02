#!/usr/bin/env bash
# Generate measured reports, then submit project docker to SonarQube.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
coverage_python="${COVERAGE_PYTHON:-$project_root/.venv/bin/python}"
if [[ ! -x "$coverage_python" ]]; then
  echo 'Set COVERAGE_PYTHON to an interpreter with the project test dependencies.' >&2
  exit 1
fi

# Read credentials privately from the configured MCP server unless already supplied.
if [[ -z "${SONAR_TOKEN:-}" ]]; then
  codex_config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  SONAR_TOKEN="$(python3 - "$codex_config" <<'PY'
import sys
import tomllib
from pathlib import Path
try:
    config = tomllib.loads(Path(sys.argv[1]).read_text())
    token = config['mcp_servers']['sonarqube']['env']['SONARQUBE_TOKEN']
    if not token:
        raise ValueError('empty token')
except (OSError, KeyError, ValueError):
    sys.exit('No SonarQube MCP token found. Set SONAR_TOKEN or configure the MCP server.')
print(token, end='')
PY
)"
fi
export SONAR_TOKEN
export SONAR_HOST_URL="${SONAR_HOST_URL:-http://127.0.0.1:9000}"

printf '%s\n' 'Generating Python coverage...'
"$coverage_python" scripts/sonar_python_coverage.py
printf '%s\n' 'Appending isolated PostgreSQL integration coverage...'
BUDDY_TEST_PYTHON="$coverage_python" BUDDY_DB_COVERAGE=1 bash scripts/test_isolated_postgres.sh
"$coverage_python" -m coverage xml --rcfile=.coveragerc.sonar
printf '%s\n' 'Generating Go binding coverage...'
mkdir -p reports/sonar-go
rm -f reports/sonar-go/coverage.out
docker run --rm --user "$(id -u):$(id -g)" \
  --env GOCACHE=/tmp/go-cache \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --workdir "$project_root/bindings/go" golang:1.24-bookworm \
  go test -coverprofile=../../reports/sonar-go/coverage.out ./...
printf '%s\n' 'Generating Java binding coverage...'
rm -f bindings/java/target/site/jacoco/jacoco.xml bindings/java/target/jacoco.exec
docker run --rm --user "$(id -u):$(id -g)" \
  --env MAVEN_CONFIG=/tmp/maven-config \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --workdir "$project_root/bindings/java" maven:3.9-eclipse-temurin-21 \
  mvn -B -Dmaven.repo.local=/tmp/m2 verify
printf '%s\n' 'Generating UI coverage in Node 24...'
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --workdir "$project_root/web" node:24-bookworm npm run test:coverage

# Refuse to scan without fresh reports from all successful runs above.
test -s reports/sonar-python/coverage.xml
test -s reports/sonar-go/coverage.out
test -s bindings/java/target/site/jacoco/jacoco.xml
test -s web/coverage/lcov.info
printf '%s\n' 'Checking dashboards in Chromium, Firefox and WebKit...'
COVERAGE_PYTHON="$coverage_python" bash scripts/test_dashboard_browsers.sh
printf '%s\n' 'Submitting SonarQube analysis and waiting for the quality gate...'
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --env SONAR_TOKEN --env SONAR_HOST_URL \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --workdir "$project_root" sonarsource/sonar-scanner-cli:latest \
  "-Dsonar.projectBaseDir=$project_root" \
  "-Dsonar.working.directory=$project_root/.scannerwork" \
  -Dsonar.qualitygate.wait=true -Dsonar.qualitygate.timeout=300
