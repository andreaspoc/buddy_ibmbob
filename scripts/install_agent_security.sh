#!/usr/bin/env bash
# Load the nested-agent AppArmor policy on the Linux Docker host.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v apparmor_parser >/dev/null
install -m 0644 "$repo_root/deploy/security/buddy-sandbox.apparmor" /etc/apparmor.d/buddy-sandbox
apparmor_parser -r /etc/apparmor.d/buddy-sandbox
