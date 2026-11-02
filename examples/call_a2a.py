import json
import os
import uuid
import urllib.request
from pathlib import Path

session_token = os.getenv("BOB_APP_SESSION_TOKEN")
if not session_token:
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith("BOB_APP_SESSION_TOKEN="):
                session_token = line.partition("=")[2].strip().strip('"').strip("'")
                break

if not session_token:
    raise SystemExit("Set BOB_APP_SESSION_TOKEN to an existing application session token")

headers = {"content-type": "application/json"}
if session_token:
    headers["x-api-key"] = session_token

payload = {
    "jsonrpc": "2.0",
    "id": uuid.uuid4().hex,
    "method": "message/send",
    "params": {
        "message": {
            "role": "user",
            "messageId": uuid.uuid4().hex,
            "parts": [
                {
                    "kind": "text",
                    "text": "Briefly introduce yourself to Alice.",
                }
            ],
        }
    },
}

req = urllib.request.Request(
    "http://localhost:8080/a2a",
    data=json.dumps(payload).encode(),
    headers=headers,
)
with urllib.request.urlopen(req) as response:
    print(json.dumps(json.load(response), indent=2))
