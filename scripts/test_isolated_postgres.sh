#!/usr/bin/env bash
# Run database integration tests against a disposable loopback-only PostgreSQL.
set -euo pipefail
cd "$(dirname "$0")/.."

python_bin="${BUDDY_TEST_PYTHON:-.venv/bin/python}"
image="${BUDDY_TEST_POSTGRES_IMAGE:-postgres:17-alpine}"
container_id=""
scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/buddy-db-fixture.XXXXXXXX")
coverage_backup=""
cleanup() {
  status=$?
  if [[ "$status" != 0 && -n "$coverage_backup" ]]; then
    cp -- "$coverage_backup" reports/sonar-python/.coverage
  fi
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  rm -rf -- "$scratch_dir"
}
trap cleanup EXIT INT TERM
if [[ "${BUDDY_DB_COVERAGE:-0}" == 1 && -f reports/sonar-python/.coverage ]]; then
  coverage_backup="$scratch_dir/coverage-before"
  cp -- reports/sonar-python/.coverage "$coverage_backup"
fi

container_id=$(docker run -d --rm -p 127.0.0.1::5432 \
  -e POSTGRES_USER=buddy_test -e POSTGRES_PASSWORD=disposable-test-only \
  -e POSTGRES_DB=buddy_fixture "$image")
for _ in {1..60}; do
  if docker exec "$container_id" createdb -U buddy_test fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
for _ in {1..60}; do
  if docker exec -e PGPASSWORD=disposable-test-only "$container_id" psql -h 127.0.0.1 -U buddy_test -d fixture -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -e PGPASSWORD=disposable-test-only "$container_id" psql -h 127.0.0.1 -U buddy_test -d fixture -c 'SELECT 1' >/dev/null
binding=$(docker port "$container_id" 5432/tcp)
port=${binding##*:}
if [[ ! "$port" =~ ^[0-9]+$ || "$binding" != 127.0.0.1:* ]]; then
  printf 'Unexpected database port binding: %s\n' "$binding" >&2
  exit 1
fi

export DATABASE_URL="postgresql://buddy_test:disposable-test-only@127.0.0.1:${port}/buddy_fixture"
# libpq hostaddr routes to the disposable container while retaining the exact
# fixture hostname required by the Learning test's production database guard.
export LEARNING_TEST_DATABASE_URL="host=bob-learning-delete-test-db hostaddr=127.0.0.1 port=${port} dbname=fixture user=buddy_test password=disposable-test-only"
export PYTHONPATH=".:plugins/learning:plugins/office:plugins/people:plugins/projects:plugins/decisions${PYTHONPATH:+:$PYTHONPATH}"
export BUDDY_PEOPLE_ENABLED=1
export BUDDY_ISOLATED_TEST_DB=1
export BOB_WORKSPACE="$scratch_dir/workspace"
export BOB_RUNTIME_ROOT="$scratch_dir/runtime"
export BOB_BLOB_STORAGE=postgres
export BOB_AGENT_PREWARM=0
unset BUDDY_PEOPLE_PLUGIN_URL BOB_S3_BUCKET
"$python_bin" -c 'from app.auth import _connect; context = _connect(); context.__enter__(); context.__exit__(None, None, None)'
# The migration tests rebuild their schema, so they get their own database.
docker exec "$container_id" createdb -U buddy_test group_migration
export GROUP_MIGRATION_TEST_DATABASE_URL="postgresql://buddy_test:disposable-test-only@127.0.0.1:${port}/group_migration"
runner=("$python_bin" -m unittest)
if [[ "${BUDDY_DB_COVERAGE:-0}" == 1 ]]; then
  runner=("$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar -m unittest)
fi
"${runner[@]}" \
  tests.test_learning_deletion \
  tests.test_community_away.DatabaseTests \
  tests.test_community_bob.DatabaseTests \
  tests.test_community_collaboration \
  tests.test_community_typing.TypingSocketDatabaseTests \
  tests.test_community.CommunityPostgresTests \
  tests.test_people_audio \
  tests.test_people_calls \
  tests.test_notes_integration \
  tests.test_app_actions_integration \
  tests.test_toolbar_reminders_integration \
  tests.test_app_groups_database \
  tests.test_group_access_migration
if [[ "${BUDDY_DB_COVERAGE:-0}" == 1 ]]; then
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/chat_idempotency_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/knowledge_management_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/knowledge_acl_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/access_audit_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/conversation_documents_http_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/test_presentation_delete_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/test_notification_freshness_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/test_knowledge_notifications_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/test_session_titles_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/mcp_oauth_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/feedback_http_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/auth_boundary_integration.py
  "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar tests/project_scope_integration.py
else
  "$python_bin" tests/chat_idempotency_integration.py
  "$python_bin" tests/knowledge_management_integration.py
  "$python_bin" tests/knowledge_acl_integration.py
  "$python_bin" tests/access_audit_integration.py
  "$python_bin" tests/conversation_documents_http_integration.py
  "$python_bin" tests/test_presentation_delete_integration.py
  "$python_bin" tests/test_notification_freshness_integration.py
  "$python_bin" tests/test_knowledge_notifications_integration.py
  "$python_bin" tests/test_session_titles_integration.py
  "$python_bin" tests/mcp_oauth_integration.py
  "$python_bin" tests/feedback_http_integration.py
  "$python_bin" tests/auth_boundary_integration.py
  "$python_bin" tests/project_scope_integration.py
fi

# These integration scripts each create and remove their own disposable schema.
extra_integrations=(
  artifact_provenance_integration
  job_failure_recovery_integration
  research_reports_integration
  wasabi_storage_integration
)
for integration in "${extra_integrations[@]}"; do
  if [[ "${BUDDY_DB_COVERAGE:-0}" == 1 ]]; then
    "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar "tests/$integration.py"
  else
    "$python_bin" "tests/$integration.py"
  fi
done
# Exercise real PDF export when a local Chromium is available.
chromium_path=${RESEARCH_CHROMIUM_PATH:-/usr/bin/chromium}
if [[ ! -x "$chromium_path" && -z "${RESEARCH_CHROMIUM_PATH:-}" ]]; then
  chromium_path=$("$python_bin" -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()' 2>/dev/null || true)
fi
if [[ -n "$chromium_path" && -x "$chromium_path" ]]; then
  export RESEARCH_CHROMIUM_PATH="$chromium_path"
  if [[ "${BUDDY_DB_COVERAGE:-0}" == 1 ]]; then
    "$python_bin" -m coverage run --append --rcfile=.coveragerc.sonar -m unittest tests.test_note_exports.NoteExportTests
  else
    "$python_bin" -m unittest tests.test_note_exports.NoteExportTests
  fi
else
  printf '%s\n' 'Skipping note PDF integration: no Chromium executable found.' >&2
fi
