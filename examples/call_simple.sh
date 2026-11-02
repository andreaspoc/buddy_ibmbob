#!/usr/bin/env bash
set -euo pipefail

curl -sS http://localhost:8080/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"Briefly introduce yourself to Alice."}' | python3 -m json.tool
