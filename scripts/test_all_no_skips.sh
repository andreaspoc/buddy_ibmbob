#!/usr/bin/env bash
# Run all registered Python tests in one pass against a disposable loopback PostgreSQL.
# Needs Docker, bubblewrap and Playwright Chromium. Any skipped test fails the run.
set -euo pipefail
cd "$(dirname "$0")/.."

python_bin="${BUDDY_TEST_PYTHON:-.venv/bin/python}"
command -v bwrap >/dev/null || { echo 'Install bubblewrap to run the sandbox test.' >&2; exit 2; }
scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/buddy-all-tests.XXXXXXXX")
container_id=$(docker run -d --rm -p 127.0.0.1::5432 \
  -e POSTGRES_USER=buddy_test -e POSTGRES_PASSWORD=disposable-test-only \
  -e POSTGRES_DB=buddy_fixture "${BUDDY_TEST_POSTGRES_IMAGE:-postgres:17-alpine}")
cleanup() { docker rm -f "$container_id" >/dev/null 2>&1 || true; rm -rf -- "$scratch_dir"; }
trap cleanup EXIT INT TERM

for _ in {1..60}; do
  if docker exec "$container_id" createdb -U buddy_test fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
for _ in {1..60}; do
  if docker exec -e PGPASSWORD=disposable-test-only "$container_id" psql -h 127.0.0.1 -U buddy_test -d fixture -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
binding=$(docker port "$container_id" 5432/tcp)
port=${binding##*:}

export DATABASE_URL="postgresql://buddy_test:disposable-test-only@127.0.0.1:${port}/buddy_fixture"
export LEARNING_TEST_DATABASE_URL="host=bob-learning-delete-test-db hostaddr=127.0.0.1 port=${port} dbname=fixture user=buddy_test password=disposable-test-only"
export PYTHONPATH=".:plugins/learning:plugins/office:plugins/people:plugins/projects:plugins/decisions:plugins/tetragon"
export BUDDY_PEOPLE_ENABLED=1 BUDDY_ISOLATED_TEST_DB=1 BOB_BLOB_STORAGE=postgres BOB_AGENT_PREWARM=0
export BOB_WORKSPACE="$scratch_dir/workspace" BOB_RUNTIME_ROOT="$scratch_dir/runtime"
export RUN_VISUAL_EXPORT_BROWSER_TESTS=1
RESEARCH_CHROMIUM_PATH=$("$python_bin" -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')
export RESEARCH_CHROMIUM_PATH
unset BUDDY_PEOPLE_PLUGIN_URL BOB_S3_BUCKET
"$python_bin" -c 'from app.auth import _connect; context = _connect(); context.__enter__(); context.__exit__(None, None, None)'
"$python_bin" -B scripts/test_all_no_skips.py
