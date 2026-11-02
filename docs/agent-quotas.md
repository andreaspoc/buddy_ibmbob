# Agent execution quotas

The execution broker uses one server-owned `RunBudget` per job. Reuse that object
across research phases and broker instances; creating a broker must not reset a
job's quota. Internal specialists also consume that budget. Action reservations
are never refunded on failures or cancellation, since a remote side effect may
already have occurred.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `BUDDY_AGENT_MAX_TOOL_CALLS` | 100 | Total execution reservations per job, including remote and specialist calls |
| `BUDDY_AGENT_MAX_INFERENCE_CALLS` | 16 | Coordinator inference entry points per job |
| `BUDDY_AGENT_MAX_REMOTE_CALLS` | 6 | Remote A2A calls per job |
| `BUDDY_AGENT_MAX_SPECIALIST_CALLS` | 6 | Internal specialist inference calls per job |
| `BUDDY_AGENT_MAX_DAILY_ACTIONS` | 1000 | Execution reservations per user and UTC day across workers/jobs |
| `BUDDY_AGENT_MAX_RUN_SECONDS` | 3600 | Maximum age of a job's execution budget |

Values must be positive integers. These limits are deployment configuration,
not model-controlled tool parameters. A specialist delegation consumes a normal
tool reservation and a specialist inference reservation. Discovery requests may
be counted by the broker as well; this conservatively bounds repeated discovery.
Coordinator inference entry points must reserve `inference` before launching the
runtime, so tool-free submissions also consume the shared daily allowance. An
entry point can internally issue multiple provider requests; this count does not
claim to measure those hidden requests.

People away previews and selected-message collaboration charge the authenticated
requester. Scheduled away replies charge the recipient who enabled the feature.
Every generation attempt, including duplicate-reply retries, reserves inference
capacity. The collaboration route reuses one budget across its own retry loop.
These identities are taken from authentication or the persisted job, never from
the text supplied to the model. A generator invoked without an owner budget
denies execution.

Daily accounting uses PostgreSQL's UTC date and an atomic conditional UPSERT in
`bob_agent_daily_quotas`. Database failure denies execution. Back up this table
with the application database; do not delete the current UTC day's rows to
resolve a quota error. Old rows may be removed after the relevant day ends in
accordance with the installation's audit-retention policy.

These are action/time quotas, not a dollar guarantee. Provider-reported specialist
tokens and cost are returned separately when available. Missing or invalid usage
remains unknown and must not be treated as zero. Coordinator totals do not include
specialist totals. A hard monetary cap additionally requires provider-side billing
limits or an inference gateway able to reserve a verified maximum charge before
each request. The current Bob interface does not supply that contract, so no
unverified price or charge estimate is used to claim such a cap.
