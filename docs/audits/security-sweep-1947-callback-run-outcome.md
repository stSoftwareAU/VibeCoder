# Security sweep — the structured callback run outcome (`callback_run_outcome.ts`)

**Issue:** [#1947](https://github.com/stSoftwareAU/VibeCoder/issues/1947)
(chunk 12ac) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12ab) recorded their coverage:

- `worker/deno/lib/callback_run_outcome.ts` — added by #1947.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12ac**, and this file is the reading of it.

## `worker/deno/lib/callback_run_outcome.ts`

The module narrows the `RunOutcome` a terminal run computed to the small block
published to an operator's post-run callbacks: `kind`, `category`, `phase`,
`failureClass`, `prNumber`. It is the **boundary between worker-internal
prose and an external extension**, so the shapes that matter are 12d's
(environment and secret sinks) and 12c's (untrusted GitHub data), not 12a's
process ones — nothing here spawns, reads or writes anything.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; `summariseRunOutcome` is pure over the record it is given |
| no filesystem, no network, no `gh` | nothing is opened; every input arrives from the caller |
| no environment reads | no `Deno.env`; the module neither reads nor writes a variable, it returns a value the callback layer exports |
| **no untrusted prose crosses the boundary** | this is the sweep's central finding. `RunOutcome` carries free text an agent, an issue body or a `gh` error can steer — `no_pr.message`, `no_pr_expected.summary`, `claim_stale.detail`, `summary_incomplete.problem`, `superseded.wipNote`, `notes[]` — and **none of it is copied into the summary**. Only closed vocabularies and numbers leave: `kind` (six literals), `category` (the `FailureCategory` union), `failureClass` (a `RUN_FAILURE_CLASSES` slug), `phase` (worker-set literals: `setup`, `execute`, `quality_gate`, `completion`, `serial`, `slot`, `claim`), `prNumber` (a number) |
| the raw message is read, never republished | a failure message reaches `detectFailureCategory` and `classifyRunFailure` for matching only; both return a slug from a closed set, so the message itself is a classification input and never a published value |
| no new matching surface on attacker text | the module adds no regex of its own. The two classifiers it calls already run over the same message on the existing release-comment path (chunk 12e), so this adds a second *caller*, not a second *exposure*, and neither classifier recurses or backtracks over unbounded input |
| an unknown outcome is omitted, never guessed | a success with no computed outcome returns `undefined` and the whole block is omitted, matching the rest of the callback context: a consumer's `"outcome" in ctx` stays truthful rather than reading an invented label |
| a failure is never silently unlabelled | a failure with no computed outcome — a claim rejected, a setup step refused — is published as `no_pr` with the message diagnosed and the phase named (`claim` when the loop knows no better), so a fault cannot reach an archive as an unexplained `result: "failure"` |
| every member is exhaustively mapped | the `switch` covers all six `kind`s with no `default`, so a seventh outcome added later fails type-checking here rather than silently publishing a partial block |
| no value is coerced or defaulted | `compact()` drops `undefined` members only; nothing is substituted, so an absent PR number never becomes `0` and an absent category never becomes `unknown` |
| the export path cannot be injected into | `buildCallbackEnv` puts each member in its own `VIBECODER_*` variable of a **cleared** environment, and the hook is spawned directly with no shell and no arguments (`run_callbacks.ts`), so no value here is ever parsed as a command |
| `result` and `exitCode` are untouched | the module returns a new object and mutates nothing; the run's own result is derived where it always was, so a hook cannot be misled about success by this block, and the schema bump to 2 lets a pinned consumer refuse the contract it does not know |

### Findings

None.

### Accepted residuals

- **`phase` is a worker-set string, not a closed type.** `RunOutcome.phase` is
  typed `string`, and every producer in the tree sets a literal. A future call
  site could therefore put arbitrary text in it. The exposure is bounded: the
  value crosses into a cleared environment as its own variable and is never
  interpolated into a command, and the callers are worker code rather than
  attacker input. Narrowing the type is a change to `run_outcome.ts` and is out
  of scope for #1947.
- **A hook author still owns what they do with the block.** Publishing a
  category and a failure class to a chat channel or an archive is the hook's
  decision, exactly as the transcript path already is. The contract's existing
  rule stands: the worker exports facts, the extension owns the destination.
