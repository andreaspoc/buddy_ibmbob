# KPI impact simulation

The simulator's batch mode now includes **KPI impact simulation**. Supply independent
JSON, CSV or Excel scenarios, configure the report, and optionally select a saved
baseline decision. A current draft can be compared against its own saved version.
Both sides use the same scenario inputs; nested decisions retain the existing
permission checks and version/digest resolution. Reports include graph digests,
versions and dependency manifests for both sides.

Each scenario executes independently. This is an ad hoc impact report, separate
from saved regression-suite passes and release gates. It does not claim measured
production telemetry, deployment validation, or IBM DVS file compatibility.

Example report configuration (replace the example fields with your model's outputs):

```json
{
  "title": "Proposed policy impact",
  "includeCases": true,
  "metrics": [
    {"name": "Approval rate", "expression": "result.approved", "aggregation": "rate"},
    {"name": "Total fees", "expression": "result.fee", "aggregation": "sum"},
    {"name": "Average approved fee", "expression": "result.fee", "aggregation": "avg", "where": "result.approved == true"}
  ]
}
```

Metric expressions use `input` and `result` documents and the engine's bounded
expression interpreter. `count` counts true predicates; `rate` reports the
percentage of true predicates. Both require boolean expressions. `sum`, `avg`,
`min`, and `max` require finite numbers and reject booleans. Optional `where`
predicates must be boolean. Reports accept at most 20 metrics and 100 cases.

Each metric includes its valid sample count, filtered count, expression error
count, and failing scenario names. Failed decision executions are counted in the
report summary and excluded from all metric denominators. Empty metric samples
have a null value, rendered as **Unavailable**. A numeric zero is shown only for
an actual valid aggregate. Partial reports remain visibly partial.

Baseline comparisons show current minus baseline values; rate differences are in
percentage points. Comparisons are marked complete only when both metrics are
complete, values exist, and they use exactly the same scenario indexes. Deltas
from partial or different samples remain marked for review.

Download configuration and impact reports as JSON. Configuration can be restored
by pasting its JSON into the report configuration field. Reports optionally include
individual scenario results (`includeCases`); this setting applies to the current
and baseline runs. Configuration and reports are downloads, not persisted shared
server artifacts.

API: authenticated `POST /api/decisions/simulation/kpis`, with either `decisionId`
(and optional `expectedVersion`) or `graph`, plus `cases` and `report`. Optional
`baselineDecisionId` and `baselineExpectedVersion` request a saved baseline. Each
case uses `{"name":"optional name","input":{...}}`; expected output is optional
and is not used by KPI metrics. Payloads are limited to 1 MB.

Validation: five synthetic Python report tests exercise all aggregations, filters,
input isolation, type/expression failures, execution failures, baseline differences,
sample identity and configuration limits. Frontend input/UI tests pass. No live
business data or external IBM integration was used.
