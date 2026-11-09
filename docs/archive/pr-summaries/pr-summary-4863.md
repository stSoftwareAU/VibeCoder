## Summary

Corrected the test comment to state that a cargo-budget withhold is not a
refusal, does not increment `refusedCycles` and never climbs the recovery
ladder. Closes #4863.

Version bump: no version files changed for this comment-only correction.

## Spec

### Intent and Rationale

- The test's opening comment contradicted its assertions and the current
  withhold behaviour; it now describes the contract those assertions cover.

### Essential Design Decisions

- Preserved all existing assertions and production code; no new test was needed
  for this comment-only correction.

### Undiscoverable Facts

- `gh issue view 4588` confirmed Issue #4588 is closed and documents the
  cargo-budget withhold correction.

## Evidence

- `judgeSyncFailure` returns the cargo-budget withhold as `not-charged` without
  a refusal flag in `worker/deno/lib/milestone_branch_sync.ts`.
- `escalateRepeatedRefusal` returns that withhold unchanged. The existing test
  asserts both properties and that the conflict is not pushed.
- Nearby comments and current documentation in `docs/INTERNALS.md`,
  `docs/CONTAINER.md` and `docs/workflows/milestones.md` describe the same
  contract; no other contradictory wording was found.

## Test Plan

- Modified existing test comment only; no assertions were removed or changed.
- `deno fmt --check tests/milestone_merge_only_4326_test.ts` — passed.
- `deno lint tests/milestone_merge_only_4326_test.ts` — passed.
- `deno check --frozen --lock=deno.lock tests/milestone_merge_only_4326_test.ts`
  — passed.
- `deno task test:unit tests/milestone_merge_only_4326_test.ts` — passed (20
  tests).
- `timeout 900 ./quality.sh < /dev/null` — passed. Config integration and
  Checkov were skipped because `.config.json` and Checkov were unavailable.
- `deno task pr-summary-check --base main --issue-body-file
  /tmp/issue-4863-body.md --labels work-on
  ../../docs/archive/pr-summaries/pr-summary-4863.md`
  — passed (0 blocked, 0 not checked).
