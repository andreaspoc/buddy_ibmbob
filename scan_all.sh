#!/bin/bash

# Save the folder being scanned
APP_DIR="$PWD"
REPORT_DIR="$HOME/snyk-reports/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$REPORT_DIR"

echo "=================================="
echo " SNYK FULL SECURITY SCAN"
echo "=================================="
echo "Folder: $APP_DIR"
echo "Reports: $REPORT_DIR"

cd "$APP_DIR" || exit 1

echo "[1/4] Scanning source code..."
snyk code test . \
  --json-file-output="$REPORT_DIR/source-code.json"

echo "[2/4] Scanning dependencies..."
snyk test --all-projects \
  --json-file-output="$REPORT_DIR/dependencies.json"

echo "[3/4] Scanning infrastructure..."
snyk iac test \
  --json-file-output="$REPORT_DIR/infrastructure.json"

echo "[4/4] Scanning all Docker container images..."

docker ps -a --format '{{.Image}}' | sort -u |
while IFS= read -r image; do
    [ -z "$image" ] && continue

    echo "Scanning image: $image"

    safe_name=$(printf '%s' "$image" |
      tr -c 'A-Za-z0-9._-' '_')

    snyk container test "$image" \
      --json-file-output="$REPORT_DIR/docker-${safe_name}.json"
done

echo "=================================="
echo " SCANS FINISHED"
echo " Reports: $REPORT_DIR"
echo "=================================="
