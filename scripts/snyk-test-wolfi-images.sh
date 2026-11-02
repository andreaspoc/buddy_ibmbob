#!/usr/bin/env bash
# Scan ONLY the eight isolated Wolfi images, never production or old images.
set -u -o pipefail

report_dir="${1:-/root/snyk-reports/wolfi-$(date +%Y%m%d-%H%M%S)}"
images=(
  bob-acp-runtime:wolfi-prototype-20261026
  bob-acp-core:wolfi-prototype-20261026
  bob-acp-office:wolfi-prototype-20261026
  bob-acp-people:wolfi-prototype-20261026
  bob-acp-projects:wolfi-prototype-20261026
  bob-acp-learning:wolfi-prototype-20261026
  bob-acp-decisions:wolfi-prototype-20261026
  bob-acp-knowledge-worker:wolfi-prototype-20261026
)
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 2; }
command -v snyk >/dev/null || { echo 'Snyk CLI is required.' >&2; exit 2; }
mkdir -p "$report_dir" || exit 2

# Capture immutable IDs before scanning, and fail early if a prototype is absent.
inventory="$report_dir/images.tsv"
: > "$inventory"
for image in "${images[@]}"; do
  image_id="$(docker image inspect "$image" --format '{{.Id}}')" || exit 2
  printf '%s\t%s\n' "$image_id" "$image" >> "$inventory"
done

findings=0
failures=0
printf 'image_id\timage_tag\texit_code\tjson_report\n' > "$report_dir/results.tsv"
while IFS=$'\t' read -r image_id image; do
  name="${image//:/_}"
  echo "Scanning Wolfi prototype: $image"
  snyk container test "$image_id" \
    --json-file-output="$report_dir/$name.json" \
    > "$report_dir/$name.log" 2>&1
  status=$?
  printf '%s\t%s\t%s\t%s\n' "$image_id" "$image" "$status" "$name.json" >> "$report_dir/results.tsv"
  case "$status" in
    0) echo '  Completed: no known vulnerabilities found.' ;;
    1) findings=$((findings + 1)); echo '  Completed: vulnerabilities found.' ;;
    *) failures=$((failures + 1)); echo "  Scan failed (exit $status). See $report_dir/$name.log" ;;
  esac
done < "$inventory"

echo "Wolfi scans complete: $findings images with vulnerabilities; $failures scan failures."
echo "Reports: $report_dir"
((failures == 0)) || exit 2
((findings == 0)) || exit 1
exit 0
