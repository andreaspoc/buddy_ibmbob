#!/usr/bin/env bash
# Compatibility entry point: release Office without recreating core or people chat.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/deploy_buddy.py --only office --build
