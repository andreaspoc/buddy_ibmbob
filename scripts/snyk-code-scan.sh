#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
snyk ignore --file-path=.venv --file-path-group=code
snyk code test .
