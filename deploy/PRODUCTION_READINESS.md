# Production readiness acceptance record

This record tracks implementation and evidence, not certification. Production
release remains gated on the outstanding checks below.

| Acceptance criterion | Implemented / local evidence | Outstanding release gate |
| --- | --- | --- |
| Account isolation | Provider key no longer authenticates application accounts. The inbound SMTP service and API have been removed. Real-session, two-account API regression covers conversation/files/jobs/Microsoft token boundaries. | Review all API routes, generated HTML preview origins, account lifecycle and SSO roles. |
| Agent cannot read control-service secrets | Allowlisted subprocess environment on CLI and ACP; per-run shared knowledge query broker replaces direct child database access. | **Not achieved as a security boundary:** same UID, filesystem and process visibility remain; deploy separately isolated runners, no service secrets mounted, restricted network and credential broker. |
| Clean deployment runs every worker and a real job | Kubernetes now includes API/chat/indexing containers; manifests render. | Build immutable images and start a clean staging deployment; authenticate and complete a real Bob job, file download and knowledge indexing. Current-container mocked tests are insufficient. |
| Worker interruption avoids duplicate actions | New jobs allow one execution attempt; expired leases fail for human review, stale worker writes rejected. | Drain existing jobs with old retry budgets before rollout. Add external-action idempotency and reconciliation before enabling automatic replay. An interrupted external action can still have succeeded. |
| Backup restore and rollback | Compose database dump/restore drill script; disposable database restore verified locally. | Secure off-host scheduling/retention, object-store versioning/retention and restored object checksum checks. Restore full application in staging. Demonstrate image rollback with schema compatibility. |
| Alerts detect unavailable workers and stuck jobs | Read-only operational checker reports overdue queued jobs/expired leases with failing exit code. | Connect to actual monitoring/notification system; monitor idle worker availability/container restarts and run staging synthetic jobs. Test alert delivery and recovery. |
| Concurrent usage meets latency/cost limits | Existing queue serializes per-user execution; no capacity claim. | Agree user concurrency, latency/error targets and budget. Load-test realistic authenticated jobs, streaming, storage and provider quotas in staging; record measured results. |

## Repeatable local checks

Run from the repository root against Compose:

```sh
python3 scripts/verify_readiness.py
docker compose exec -T bob-agent python3 -m app.ops_check
python3 scripts/verify_database_backup.py /SECURE/NEW/PATH/bob.dump
kubectl kustomize deploy/k8s
```

The backup script assumes the bundled Compose PostgreSQL service/user/database;
it does not cover a remote database deployment. It creates a mode-0600 archive,
restores into a unique disposable database and drops that database afterward.
Keep backups encrypted and off-host. Database archives contain private records
and integration tokens. S3 file bytes are outside the database archive.

The operational check exits 0 for the checks passing, 1 for queue attention,
and 2 when the check itself fails. A healthy idle queue does not prove a worker
is available. Threshold is configurable with BOB_OPS_QUEUE_AGE_SECONDS.

## Release sequence

1. Review changes and run readiness regressions; callers must use application sessions.
2. Back up PostgreSQL and object storage, drain old jobs and scheduled writes.
3. Build versioned images; deploy a separate staging environment with SSO/TLS.
4. Complete the outstanding functional/security, restore, rollback and alert drills.
5. Measure agreed concurrency and cost targets; retain results with image digests.
6. Promote the reviewed release and verify the same smoke checks after rollout.

The baseline Kubernetes pod is for a trusted internal team. Do not treat child
environment filtering or a Unix query socket as protection from malicious code
running under the same OS identity.
