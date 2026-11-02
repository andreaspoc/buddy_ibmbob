# Parallel decision branches

A fork now executes its branches with isolated copies of the working document and
waits for every branch before committing their combined result at the join.
Independent branches can overlap their work. Traces and merge decisions always
follow the order of the fork's outgoing edges, regardless of completion order.

Configure the fork content with an optional `joinId` and `maxWorkers` (an integer
from 1 through 8, default 4). If `joinId` is omitted, the first common join is
inferred. Configure the join content with `mergePolicy`:

| Policy | Behavior when branches change overlapping fields |
| --- | --- |
| `error` (default) | Fail the evaluation with a merge-conflict error |
| `first` | Keep the earlier declared branch's change |
| `last` | Keep the later declared branch's change |

Changes to different fields of a nested object merge. Equal changes to the same
field merge once. A list is one value; conflicting edits to different list elements
still require an explicit first/last policy. Replacing an object conflicts with
changes under that object. Boolean and numeric values remain distinct during
conflict comparison.

Each branch must lead to the same join without external incoming or outgoing
edges or nodes shared by sibling branches. A direct fork-to-join transition is
an empty branch. Parallel regions cannot contain another fork, intermediate join,
or output node. A subdecision invoked from a branch cannot start another parallel
region. Invalid structures fail validation rather than fall back to shared-memory
sequential execution. Sequential graphs and multiple consecutive fork/join
regions continue to work.

Workers share a lock-protected root node-evaluation budget, including nested
subdecisions. A failed branch or conflict aborts evaluation without updating caller
input. The executor waits for workers to finish before returning an error. This
is not a distributed transaction: remote model calls can still occur before a
sibling fails, and network timeouts remain the responsibility of their connectors.
No speedup is promised for Python CPU-bound expressions; concurrency is useful
when independent branch work releases the interpreter or waits on external I/O.

Validation: `python3 -m unittest tests.test_decisions_parallel` covers concurrent
execution with a two-worker barrier, isolated reads, deterministic nested merges,
conflict policies, failed branches, shared budgets, inferred joins, empty branches,
and unsupported structures.
