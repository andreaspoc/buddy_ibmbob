#!/usr/bin/env bash
# Scan every local Docker image once, including stopped-service and prototype
# images. Snyk scans OS and supported application dependencies by default.
set -u -o pipefail

report_dir="${1:-/root/snyk-reports/$(date +%Y%m%d-%H%M%S)}"
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 2; }
command -v snyk >/dev/null || { echo 'Snyk CLI is required.' >&2; exit 2; }
docker image ls >/dev/null || exit 2
mkdir -p "$report_dir" || exit 2

# Snapshot first so image builds finishing during the scan do not change its scope.
inventory="$report_dir/images.tsv"
docker image ls --no-trunc --format '{{.ID}}\t{{.Repository}}:{{.Tag}}' > "$inventory" || exit 2
declare -A scanned=()
findings=0
failures=0
total=0
printf 'image_id\timage_tag\texit_code\tjson_report\n' > "$report_dir/results.tsv"

while IFS=$'\t' read -r image_id image_tag; do
  [[ -n "$image_id" ]] || continue
  [[ -z "${scanned[$image_id]+present}" ]] || continue
  scanned[$image_id]=1
  total=$((total + 1))
  digest="${image_id#sha256:}"
  filename="docker-${digest}"
  echo "Scanning $image_tag ($image_id)"
  # Use the immutable local ID, so a tag being rebuilt cannot change this scan.
  snyk container test "$image_id" \
    --json-file-output="$report_dir/$filename.json" \
    > "$report_dir/$filename.log" 2>&1
  status=$?
  printf '%s\t%s\t%s\t%s\n' "$image_id" "$image_tag" "$status" "$filename.json" >> "$report_dir/results.tsv"
  case "$status" in
    0) echo '  Completed: no known vulnerabilities found.' ;;
    1) findings=$((findings + 1)); echo '  Completed: vulnerabilities found.' ;;
    *) failures=$((failures + 1)); echo "  Scan failed (exit $status). See $report_dir/$filename.log" ;;
  esac
done < "$inventory"

echo "Scanned $total images; $findings with vulnerabilities; $failures scan failures."
echo "Reports: $report_dir"
echo "Image names and results: $report_dir/results.tsv"
((failures == 0)) || exit 2
((findings == 0)) || exit 1
exit 0
