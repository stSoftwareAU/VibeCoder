# PR Summary — Issue #5315

## Summary

`retryUnfinishedIssue` in `worker/deno/lib/unfinished_issue_retry.ts` returned a
failure reason ending `retrying the approved issue (Issue #4227)`. That reason
is posted in the target repository's failure comment, where GitHub links `#4227`
to an unrelated issue there. The reason now ends `retrying the approved issue`.
The provenance stays in the code comment beside it. Closes #5315.

## Spec

### Intent and Rationale

- The same defect class as #4585 and #4641: posted text keeps no VibeCoder
  number, and the code comment keeps the provenance.

### Essential Design Decisions

- The `logger.warn` line that also cites Issue #4227 is unchanged, because logs
  stay on the host and are never posted.
- The words `without making any changes` stay, because `detectFailureCategory`
  reads them as `no_changes`. The new test asserts that classification.

### Undiscoverable Facts

- Confirmed on posted comments before the fix: stSoftwareAU/GRQ#5567
  (issuecomment-6868463593 and two later comments) carry
  `retrying the approved issue (Issue #4227)`. Found with
  `gh search issues "\"retrying the approved issue (Issue #4227)\"" --owner stSoftwareAU`
  and read with `gh api repos/stSoftwareAU/GRQ/issues/5567/comments`.

## Evidence

Backend-only change. The regression test below covers it. No README or `docs/`
page quotes the changed wording: a grep for `retrying the approved issue`
outside `docs/archive/` found no hits. The module doc of
`unfinished_issue_retry.ts` makes no claim about the suffix.

## Test Plan

- Added
  `worker/deno/tests/reasons_no_vibecoder_numbers_4641_test.ts::not-finished retry reason - names no VibeCoder number and still reads as no_changes (Issue #5315)`.
  - It drives the real `retryUnfinishedIssue` with a stub `postComment`.
  - It asserts the run fails as `no_changes`, the reason carries no `#<digits>`
    token, the reason still names the `why` and reads as `no_changes` through
    `detectFailureCategory`, and the posted comment carries no `#<digits>`
    token.
  - The file's header doc comment now lists four reason builders.
- Red on base: `5 passed | 1 failed`. The new test failed with `["#4227"]`
  against `[]`. After the fix, the file gave `6 passed | 0 failed`.
- These existing tests still pass after the fix (73 passed, 0 failed):
  - `worker/deno/tests/never_hand_back_4227_test.ts`
  - `worker/deno/tests/handle_no_changes_phase_test.ts`
  - `worker/deno/tests/declared_handoff_phase_3088_test.ts`
  - `worker/deno/tests/handle_no_changes_time_deferral_test.ts`
- No existing assertion was edited or removed.
- `deno fmt --check`, `deno lint` and `deno check` on the two changed files
  passed.
- `./quality.sh < /dev/null` on head `fd6c5ab0c`:
  `Result: PASSED (with skipped checks)`. Skipped: checkov (not on PATH) and
  config integration (no `.config.json`).
- `deno task pr-summary-check`: 0 gates blocked, 0 not checked.
- Not done or not checked: none.
