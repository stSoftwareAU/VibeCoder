# Security sweep — aggregator recognition (`workflow_job_needs.ts`)

**Issue:** [#1878](https://github.com/stSoftwareAU/VibeCoder/issues/1878)
(chunk 12ad) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12z) recorded their coverage:

- `worker/deno/lib/workflow_job_needs.ts` — added by #1878.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12ad**, and this file is the reading of it.

## `worker/deno/lib/workflow_job_needs.ts`

The module answers one question for the CI-fix lane: is a failing check an
**aggregator** — a job whose `needs:` (transitively) reaches another job that
is also red on the same head? Its whole input is a target repository's
`.github/workflows` YAML, which on a PR head is attacker-controllable, so this
is a 12c untrusted-ingestion shape even though the module itself is pure.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; both exported functions are pure over the parsed files they are handed |
| no filesystem, no network, no `gh` | nothing is read or written here. Reading and YAML-parsing stay in the already-swept `workflow_scan_common.ts::readWorkflowFiles`, and the two callers pass it a path they already own — the host's existing clone (scanner) or the checkout (processor). Neither clones |
| no environment or secret sinks | no `Deno.env`; nothing is logged or interpolated from this module |
| untrusted YAML cannot crash the walk | every node is narrowed with `isRecord` before use, a non-string `needs:` entry is filtered out, and a `parsed === null` file contributes nothing — a malformed or hostile workflow yields a smaller graph, never a throw |
| a `needs:` cycle terminates | `isDownstreamOfRedJob` walks breadth-first with a `visited` set seeded with the check itself, so `a → b → a` (which Actions rejects but a PR head can still contain) is bounded by the number of jobs, not by the shape of the graph |
| the graph is bounded by the tree | keys and edges come only from `jobs:` mappings in files already enumerated by `readWorkflowFiles`; there is no include, no remote reference, and no recursion into another repository |
| matching is exact, never a pattern | a check is looked up by whole display name (`name:`, else job id). Nothing is built into a regular expression, so no workflow-supplied string can become a catastrophic-backtracking input |
| the failure mode is fail-safe | the only thing a crafted workflow can buy is a **skip**: a job renamed to match a failing check's name, or an invented `needs:` edge, suppresses one auto-fix attempt on that repo's own PR. It grants no write, no token, no agent run — the skip path runs no agent and posts nothing — and the check stays red and visible on the PR for a human |
| an unmatched check is never an aggregator | a check name matching no job — a matrix leg such as `Build (ubuntu-latest)`, or a check from outside Actions — returns `false`, so the filter can only ever narrow a known-job case, not swallow an unknown one |
| callers fail safe too | both call sites catch a read failure, log it with context, and fall back to "diagnose normally"; the processor also records the check-run retry before skipping, so a filtered check cannot be re-selected forever |

### Findings

None.

### Accepted residuals

- **Display-name collision across workflows.** Two workflows may define jobs
  with the same `name:`; the graph then holds the union of their `needs:`. The
  union can only add edges, so the worst case is the fail-safe skip above.
- **The scanner reads the default branch's topology.** The host's clone is not
  the PR head, so the scan's decision is an approximation. It is re-made in the
  processor against the branch actually checked out, which is the copy that
  decides whether an agent runs.
