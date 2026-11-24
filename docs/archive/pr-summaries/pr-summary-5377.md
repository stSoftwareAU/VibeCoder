# PR Summary — Issue #5377

## Summary

Corrected the operator docs and doc comments that still promised a
`needs-human` hand-off on the third failure. The `issue_retry_cooldown` row in
`docs/CONFIGURATION.md` now says that every non-transient failure, timeouts
included, steps the 2 h → 6 h → 24 h cooldown within the 48 h window. It also
says the issue is retried when the cooldown ends and is never handed to a human
(Issue #4158). The same correction is applied to the two doc comments in
`worker/deno/lib/cooldown_state.ts` and to a paragraph in `docs/INTERNALS.md`
that described a "three-strike `needs-human` park". Closes #5377.

## Spec

### Intent and Rationale

- Operators read the configuration reference and waited for a `needs-human`
  label that never comes. The docs now match the code on `main`, where the
  cooldown is the whole response to a repeated failure.

### Essential Design Decisions

- Docs and comments only; no behaviour changes. `RecordCooldownOutcome.consecutiveFailures`
  stays as it is, and its doc now says that no caller escalates on it.
- The row says `issue_retry_cooldown` wins when it is longer than the ladder
  rung, matching the `Math.max` in `isHeldByCooldown`.
- `docs/INTERNALS.md:5924` carried the same false claim, so it is fixed in this
  pass, although the issue named only the row and the two comments.

### Undiscoverable Facts

None.

## Evidence

Backend and docs only, with no UI files. Each new sentence was checked against
the head code:

- `worker/deno/lib/run_core_production_deps.ts:5617-5631`: `recordIssueCooldown`
  discards the returned outcome. Its comment says the issue is "never handed to
  a human".
- `worker/deno/lib/coding_failure_ladder.ts` header: every non-transient failure
  takes the ladder (Issue #1949), and transient failures, including a
  deadline-bound timeout, take the flat cooldown.
- `worker/deno/lib/cooldown_state.ts` `isHeldByCooldown`: the hold lasts
  `max(issueRetryCooldown, escalatingCooldownSeconds(count within 48 h))`.
- `worker/deno/lib/label_failure.ts` never applies `needs-human` or `failed` for
  a repeated failure.
- No production code reads `consecutiveFailures` from `recordIssueCooldown`. The
  only reads are in `worker/deno/tests/cooldown_state_test.ts`
  (`git grep -n consecutiveFailures`).
- Issue cited: #4158: Never park an assigned issue: drop the terminal `failed`
  label and the repeated-failure needs-human hand-off.

## Test Plan

- No test was added or edited, because the change is to prose and doc comments only.
- `deno task test:unit tests/cooldown_state_test.ts tests/config_docs_consistency_test.ts tests/doc_prose_claims_test.ts`
  (from `worker/deno`) passed: 54 passed, 0 failed.
- `deno fmt --check lib/cooldown_state.ts` passed.
- `./quality.sh` result is recorded below once it has run on the head.
- Docs sweep: I grepped the head for `handoff on the third`, `three-strike`,
  `escalate(s) to a human` and `consecutive timeouts` outside `docs/archive/` and
  `docs/audits/`. The four corrected passages were the only hits that make this
  claim. `docs/INTERNALS.md:3593`, a setup-phase hand-off, is unrelated.
