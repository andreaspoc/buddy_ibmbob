#!/usr/bin/env bash
# Check generated dashboards and the preview in Chromium, Firefox and WebKit. Touches no running services.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
python_bin="${COVERAGE_PYTHON:-$project_root/.venv/bin/python}"
image="${DASHBOARD_BROWSER_IMAGE:-mcr.microsoft.com/playwright/python:v1.64.1-noble}"
output="$(mktemp -d)"
trap 'rm -rf "$output"' EXIT
chmod 755 "$output"

"$python_bin" tests/browser/dashboard_fixture.py "$output"
docker run --rm --mount "type=bind,src=$project_root,dst=/work" --mount "type=bind,src=$output,dst=/out" \
  --workdir /work/web node:24-bookworm node tests/e2e/buildArtifactPreview.mjs /out
docker run --rm --mount "type=bind,src=$project_root,dst=/work" --mount "type=bind,src=$output,dst=/out" \
  --workdir /work/web node:24-bookworm node tests/e2e/buildOfficeRuntime.mjs /out
docker run --rm --mount "type=bind,src=$project_root/tests/browser,dst=/checks,readonly" --mount "type=bind,src=$output,dst=/out,readonly" \
  "$image" sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore playwright==1.64.1 && python /checks/check_dashboard_browsers.py /out "$@"' sh "$@"
