# Fact inference

Inference nodes now support fact lifecycle operations, joined object patterns,
indexed equality matching, and deterministic conflict resolution. These features
extend the bounded DecisionsBuddy agenda; they do not provide IBM RetePlus or IBM
rule-project compatibility.

## Node content

```json
{
  "maxCycles": 50,
  "conflictResolution": "priority",
  "rules": [
    {
      "id": "approve-order",
      "priority": 20,
      "patterns": [
        {
          "collection": "facts.orders",
          "as": "order",
          "equals": {"status": "pending"},
          "where": "order.total >= 100"
        }
      ],
      "condition": "true",
      "actions": [
        {"op": "update", "fact": "order", "values": {"status": "'approved'"}},
        {"op": "insert", "collection": "facts.notifications", "value": "{'orderId': order.id}"},
        {"op": "retract", "fact": "order"}
      ]
    }
  ]
}
```

The example is synthetic rule configuration, not operational data. Input facts
are ordinary arrays of JSON objects at the specified collection paths. Missing
collections produce no matches; an insert creates a missing collection. Existing
collections of scalars are rejected. Fact aliases exist only during pattern and
action evaluation and must not shadow root input fields.

Each pattern binds an object to `as`. `equals` is an optional literal field map;
its equality indexes distinguish JSON booleans, numbers, nulls and missing fields.
`where` is an optional safe expression evaluated after the alias is bound. Later
patterns can reference earlier aliases, enabling joins between collections.
The rule's `condition` runs against the complete tuple of bindings. Reusing one
object across separate pattern aliases is permitted; express inequality in the
condition when distinct objects are required.

`update` changes fields of a bound fact; values are safe expression strings. Every
field expression sees the same state before that update action. Later actions see
its changes. `insert` evaluates an object expression and adds a new fact.
`retract` removes the bound object. Modifying an already retracted fact fails the
run. Existing string `set`/`add` actions remain available for document fields;
use structured actions to change bound facts.

The engine reevaluates the agenda after each firing, so changes can activate other
rules. By default each rule fires once per tuple of fact identities. Two identical
JSON objects remain separate facts, while updating an object retains its identity.
A rule without patterns fires once. `loopable: true` explicitly disables refraction;
a loop that fails to reach equilibrium reports an error at the firing limit.

Higher numeric `priority` wins. The default `priority` strategy then uses rule
order and collection order. `specificity` breaks equal-priority ties by pattern
count plus indexed equality constraints. `recency` favors the most recently
inserted or structurally updated bound fact. Remaining ties preserve declaration
and collection order. These are explicit local strategies, not IBM conflict
resolution semantics.

Working memory commits only when the complete agenda reaches equilibrium. A
condition error, invalid fact mutation, or resource limit leaves the caller's
input unchanged. Traces record rule IDs, stable run-local fact identities, action
snapshots and the selected conflict strategy. Run-local IDs are not persisted
business identifiers.

## Limits and validation

- 500 rules; 1–500 firings (`maxCycles`, default 50).
- Four patterns per rule, 20 equality fields per pattern, 100 actions per rule.
- 1,000 objects across declared fact collections.
- 50,000 matching visits and 2,000 pending activations.
- 50 field updates per structured action and 1 MB working memory.
- Existing safe expression limits remain in effect.

Fact collection and update paths use public dot-separated document field names.
There is no arbitrary object method invocation or executable script support.
Vocabulary mappings may be used in expression conditions and ordinary string
actions; the node/graph vocabulary validates document types before execution and
after firings. Equality maps contain literal JSON values, not expression strings.

Tests: `python3 -m unittest tests.test_decisions_fact_inference`.
