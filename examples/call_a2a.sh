#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../.env"
fi

APP_SESSION_TOKEN="${BOB_APP_SESSION_TOKEN:?Set BOB_APP_SESSION_TOKEN to an existing application session token}"

curl -sS http://localhost:8080/a2a \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $APP_SESSION_TOKEN" \
  -d '{
    "jsonrpc":"2.0",
    "id":"demo-1",
    "method":"message/send",
    "params":{
      "message":{
        "role":"user",
        "messageId":"laptop-msg-1",
        "parts":[
          {"kind":"text","text":"Briefly introduce yourself to Alice."}
        ]
      }
    }
  }' | python3 -m json.tool
