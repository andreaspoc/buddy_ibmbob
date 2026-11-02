# DecisionsBuddy: modern decision capabilities

Scope: rule authoring, decision execution, testing, simulation, and governance.
Mainframe, z/OS, CICS, IMS, and COBOL integration are excluded.

## Implemented capabilities

| Capability | Implementation | Use in the application |
| --- | --- | --- |
| Business action rules | Bounded prose conditions, definitions, set/add actions, then/else, membership; publication-time grammar and safe-expression checks | Visual editor → Business Rule → Edit |
| Business vocabulary | Multiword phrases mapped to JSON paths with declared types and required-input checks; quoted literals are preserved | Business Rule or Fact Inference editor → Business vocabulary |
| Fact inference | Indexed literal-field matching, up to four joined object patterns, insert/update/retract actions, per-fact activation tracking | Visual editor → Fact Inference |
| Conflict resolution | Priority, specificity, and recency strategies; deterministic declaration-order fallbacks | Fact Inference editor → Choose the next matching rule |
| Parallel fork/join | Real concurrent workers, isolated branch inputs, nested-field merging, explicit error/first/last conflict policies | Visual editor → Parallel Fork / Parallel Join |
| KPI impact simulation | Sum, average, minimum, maximum, count and rate; boolean filters, sample/error counts, saved-baseline deltas; configuration/report downloads | Simulator → batch mode → KPI impact simulation |
| Excel scenarios | Authenticated template download and bounded XLSX import into the existing saved regression workflow | Simulator → batch mode → Import JSON / CSV / Excel |
| Regression governance | Existing version-bound saved expected-output suites and release evidence remain separate from ad hoc KPI reports | Save clean decision → save cases → run saved suite |

These extensions execute through the application's Python runtime. Standalone
Node, Go, and Java engines have not been extended or certified for the new node
semantics. Do not export a graph with these extensions to another runtime and
assume equivalent execution. No microsecond latency or cross-runtime parity claim
is made by these changes.

## Fail-closed evaluation

Decision outcomes refuse doubtful data rather than guess:

- A decision-table column whose rules test a value stops evaluation when that value
  is missing. Mark the column `"optional": true`, or name null in a cell (`is null`,
  `< 18 or is null`), when absence is an expected business case. Optional absent values
  never satisfy a test, including exclusions such as `!= "IR"`.
- `true` and `false` cells accept only real booleans; text such as `"false"` stops evaluation.
- A graph with an output node publishes only through that node. If no path reaches it,
  the result is empty and `reachedOutput` is false. A `properties` output schema limits
  fields unless `additionalProperties` is true.
- A field the graph decides is removed from the published result when the caller supplied
  it and no node wrote it. A schema-less output still echoes other input fields, so
  list the published fields for any customer-facing decision.
- Formula names must exist. Bare table-cell labels must be CONSTANT_CASE; quote other text.
- `+ - * /`, `sum`, `avg` and `round` use decimal arithmetic. `round` rounds half up.
- `sortBy(items, field, descending)` and `bucket(value, count)` support ranking and stable splits.
  Pass the evaluation date as input. Budgets and contact frequency caps span customers,
  so the calling system must track them.

## Business vocabulary and authoring

Business terms contain words separated by spaces and map to public dot-separated
JSON field paths. Example:

```json
[
  {"term": "customer credit score", "path": "customer.creditScore", "type": "integer", "required": true},
  {"term": "decision approved", "path": "approved", "type": "boolean"}
]
```

A business rule can then use:

```text
if the customer credit score is at least 700
then set decision approved to true;
else set decision approved to false;
```

This is an illustrative policy; replace the threshold and conditions with actual
business requirements. Vocabulary can be shared in `graph.vocabulary` or replaced
by a node's `content.vocabulary`. The canvas loads shared mappings into the node
editor and saves a reviewed local copy. The supported types are string, number,
integer, boolean, object, array, null, and any. Booleans do not satisfy numeric
types. Required terms are input requirements; output terms can be absent before
a rule runs. Type failures prevent action commits.

Names cannot contain reserved rule-language keywords. Terms are case insensitive;
longer phrases match first. Quoted strings remain literal text. This is a
controlled vocabulary and a documented prose-rule subset, not unrestricted natural
language or IBM BAL project compatibility. Conditions and actions use the bounded
expression interpreter; scripts and arbitrary object methods remain disabled.

Saving a graph validates vocabulary, action-rule grammar, agenda configuration,
and parallel-region structure before accepting the definition. Saved graph
extensions and unknown metadata continue to round-trip through the canvas.

## Fact rules, parallel branches, and simulation

- [Fact inference](decisions-fact-inference.md) describes collection patterns,
  fact lifecycle actions, activation tracking, conflict strategies, and limits.
- [Parallel branches](decisions-parallel-flows.md) describes isolation,
  deterministic merges, and structured fork/join restrictions. Nested parallel
  regions are explicitly rejected. Remote calls are not rolled back on failure.
- [KPI simulation](decisions-kpi-simulation.md) describes metric configuration,
  baseline comparison, report downloads, and handling incomplete samples.

KPI reports use supplied scenarios. They do not present production telemetry or
record a passing saved regression suite. Metrics with no valid samples are
unavailable, not zero. Baseline deltas retain sample identity and completeness
information so partial runs remain visible.

## Excel regression scenarios

The downloadable DecisionsBuddy workbook contains a `Scenarios` sheet with three
columns: `name`, `input`, and `expected`. Input and expected cells contain JSON;
expected is the complete expected decision output. Replace the explicitly marked
example before using the workbook. Import, review, run, then save cases against a
clean saved decision and run that saved suite to record regression evidence.

The importer rejects formulas, invalid headers, missing expectations, non-object
inputs, nonfinite numbers, more than 100 cases, files over 1 MB, and archives
expanding beyond 8 MB or containing over 256 entries. It uses the project's
existing openpyxl dependency. This format is not IBM DVS workbook compatibility.

## Verification and remaining limits

- Python: 67 passing execution, correctness, vocabulary, fact, parallel,
  integrated modern-graph, and KPI tests; 3 spreadsheet checks skipped because
  openpyxl is absent in the local interpreter. Package installation failed because
  the registry could not resolve. Spreadsheet execution remains unverified here.
- Frontend: production build passes under Node 24. Pure authoring roundtrip,
  simulator input, and UI test files pass, including legacy aliases, omitted
  defaults, inherited vocabulary, and structured fact configuration.
- A dedicated rendered modern-editor browser test is provided, but this environment
  blocks Chromium startup. Rendered-browser verification remains outstanding.
- Full HTTP integration tests cannot run locally because FastAPI is absent.
  The lint command cannot start because its oxlint native binding is unavailable.
- Built files are available in `decisions-buddy/dist`; no live deployment or
  backend restart was performed. Docker socket access is denied.

The implementation supplies modern application functionality rather than IBM
binary/project compatibility, a complete RetePlus clone, or a conformance claim.
Remaining compatibility work includes cross-runtime execution of these extensions,
IBM scenario-file conversion, broader language grammar, and nested parallel
regions. These limits are explicit rather than being reported as full parity.

## IBM references

- [Testing and simulation](https://www.ibm.com/docs/en/odm/9.6.0?topic=rulesets-overview-testing-simulation)
- [Ruleflows](https://www.ibm.com/docs/en/odm/9.6.0?topic=ruleflows-overview)
- [Business object model and vocabulary](https://www.ibm.com/docs/en/odm/9.5.0?topic=bom-introducing-business-object-model)
- [ODM terminology](https://www.ibm.com/docs/en/odm/9.5.0?topic=950-glossary)
