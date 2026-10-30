## Summary

A run that stopped because its external-orchestration provider was unavailable
(`external orchestration: codex unavailable (observed-authentication-failure)`)
was classed `worker-crash` / `code_fixable` and auto-filed as a worker defect.
`classifyRunFailure` now answers the new class `provider-unavailable`
(`not_code_fixable`) for that phrase, so it is never auto-filed. Closes #4508.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- `preflightRole` (`worker/deno/lib/orchestration/preflight.ts`) throws
  `external orchestration: <provider> unavailable (<reason>)` when a provider's
  subscription is exhausted or its login rejected. That is account state on the
  host. It is recorded as `internal_error`, which the classifier maps wholesale
  to `worker-crash`.
- The fix is a message rule in the classifier rather than a new category, so the
  retry behaviour (flat transient decision) is unchanged.

### Essential Design Decisions

- The phrase is read from the worker's own words only
  (`splitAgentNarration(...).worker`) and only for `internal_error`, so agent
  output quoting it, or another category, cannot trigger it.
- Only the `unavailable (` refusal is covered. The other preflight refusals
  (CLI not runnable, fixed-price subscription, metered credentials) stay
  `worker-crash`.
- `coding_failure_ladder.ts` is untouched: a declared `internal_error` is
  already transient there via `isInfrastructureFailure`.

### Undiscoverable Facts

- The issue body withholds the failure message (private source repo). The
  message was found in a local session log: the GRQ-AutoTrader release comment
  from host `vibe-coder-48129` at 19:06 UTC (phase `execute`, "1 min" for the
  34s in the issue).
- The same host released a second run in the same minute after 49 minutes with
  `host disk below its floor`. It also classifies `worker-crash` today
  (`isDiskFull` in the classifier lacks that phrase, which `host_fault.ts`
  carries). It is not this issue's run and is not changed here.

## Evidence

Backend-only change; no UI files touched.

Observed before the change (probe of `classifyRunFailure("internal_error",
"Claude execution failed: external orchestration: codex unavailable
(observed-authentication-failure)", true)`): `worker-crash` / `code_fixable`.

`deno test --allow-all tests/run_outcome_classifier_test.ts
tests/coding_failure_ladder_test.ts`: 91 passed, 0 failed. `deno lint`,
`deno check` and `deno fmt --check` on the changed TypeScript files: clean.

## Reproduction

- **symptom** — a run released on `codex unavailable (observed-authentication-failure)` was auto-filed as a `worker-crash` worker defect
- **status** — `verified` — the regression test fails with the classifier rule removed (base behaviour) and passes with it
- **regression test** — `worker/deno/tests/run_outcome_classifier_test.ts::provider-unavailable - an unavailable external-orchestration provider is not a worker crash (Issue #4508)`

## Test Plan

- `worker/deno/tests/run_outcome_classifier_test.ts` gains six tests, all named
  `(Issue #4508)`: the real message and a provider/reason table classify
  `provider-unavailable`; the ladder keeps the transient decision; the
  CLI-not-runnable refusal and agent-quoted text stay `worker-crash`; only
  `internal_error` qualifies (`summary_incomplete` stays `agent-outcome`;
  `killed`, `timeout`, `unknown`, `no_changes`, `zero_output` are not the
  class); a 100k-character hostile message completes as `worker-crash`.
- Red checks: removing the rule turned the main test and the ladder test red
  (43 passed, 2 failed); matching the regex on the whole message instead of the
  worker part turned the quoted-narration test red; removing the
  `category === "internal_error"` operand turned the category-scope test red
  (`AssertionError: killed`).
- No existing assertion was removed or edited.
- Docs: `docs/INTERNALS.md` gains a subsection beside the other failure-category
  notes. Greps of `docs/` (outside the archive) for `worker-crash` found only
  the two earlier INTERNALS passages about gate quotes, which stay true.
- `./quality.sh` on the final head: Result: PASSED (with skipped checks);
  checkov and config integration were skipped by the gate.
