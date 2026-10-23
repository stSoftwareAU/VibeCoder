# PR Summary — Issue #4118

Closes #4118

## Summary

The first-run PR-summary claim check (`runSummaryClaimCheck`) logged every
degradation that lets the run carry on at ERROR, and logged doc-prose cap
overflow as one ERROR per range (20 lines for a 20-file overflow). Every such
case now logs at WARNING, and cap overflow (and only cap overflow) is aggregated
into one warning per claim check carrying the count and the first three names
(`; and N more` for the rest); every other doc-prose not-checked reason is
logged as its own warning with `{ repo, issueNumber }`. The `notChecked` list returned to callers is unchanged.

- `worker/deno/lib/summary_claim_check.ts` — `ls-files failed`, Test Plan
  backstop reasons, `base ref could not be resolved`, `changed files could not
  be listed`, a file read error and a prompt-build failure move from `error` to
  `warn`; the per-range loop becomes one aggregated warning over
  `scope.capOverflow` with `notCheckedCount` in its context, and the remaining
  `scope.notChecked` entries each get their own warning.
- `worker/deno/lib/doc_prose_scope.ts` — `DocProseScope` gains `capOverflow`
  (the file-cap and section-cap `notChecked` entries, tagged where they are
  pushed rather than matched by text).
- `docs/workflows/issue-processing.md` — the claim-check section now says all
  of these log at warning level and that cap overflow is one warning.
- `worker/deno/tests/summary_claim_check_test.ts` — see the Test Plan.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Cap overflow logs one WARNING per claim check (count plus first few names), no longer one ERROR per range; `notChecked` unchanged — evidence: `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a 20-file-cap overflow logs one warning, not one error per file (#4118)` — reviewer: met
- **met** — The other `notChecked` reasons (`ls-files failed`, `base ref could not be resolved`, a file read error) are reviewed against the same rule and the ones that continue the run move to WARNING — evidence: `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - an ls-files failure logs one warning with repo and issue, no error (#4118)`, `::an unresolvable base ref logs one warning...`, `::an unreadable changed manual logs one warning...` — reviewer: met
- **met** — Test asserting the level and that a 20-file overflow produces a single log line — evidence: `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a 20-file-cap overflow logs one warning, not one error per file (#4118)` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English spelling, KISS/DRY, log-level promise (no degraded-but-continuing path left at ERROR), fail-loud (every degradation still reaches `notChecked`), docs/code twin agreement, test quality (real function under test, fake deps), formatting and lint — reviewer: clean

## Test Plan

Run from `worker/deno`: `deno test -A tests/summary_claim_check_test.ts` — 77 passed, 0 failed.

- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assert(logger.errors.some((e) => e.includes("well-formed base ref")));`
  Required by: "It no longer logs one ERROR per range"
  Replaced by: `assert(logger.warns.some((e) => e.includes("well-formed base ref")));`
- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assert( logger.errors.some((e) => e.includes("changed files could not be listed")), );`
  Required by: "any that continue the run move to WARNING too"
  Replaced by: `assert( logger.warns.some((e) => e.includes("changed files could not be listed")), );`

Both removed assertions pinned the old ERROR level for a degradation that
continues the run; the issue makes that level untrue, and the same fragments
are asserted at WARNING instead.

**Docs sweep** — grep: `error level`, `logs these at error`, `summary_claim_check`; section: `docs/workflows/issue-processing.md` (the claim-check section: base-ref logging and the not-checked paragraph); siblings: the other `error level` hits (pre-PR verifier hold post, standing-violation fail-closed) belong to other features and stay true; updated: `docs/workflows/issue-processing.md`

<!-- vibe-branch-outcomes -->

**Branch outcomes:**
- `worker/deno/lib/summary_claim_check.ts:861` — present (`scope.capOverflow` non-empty: one aggregated warning with `notCheckedCount`) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a 20-file-cap overflow logs one warning, not one error per file (#4118)` — flipped to never-true, test went red
- `worker/deno/lib/summary_claim_check.ts:861` — absent (`scope.capOverflow` empty: no aggregate warning) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - no overflow logs no cap warning at all (#4118)` — flipped to always-true, test went red
- `worker/deno/lib/summary_claim_check.ts:864` — more than three cap overflows (`; and N more` suffix) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - cap overflow warning carries repo, issue, the count and 'and N more' (#4118)` — flipped to never-more, test went red
- `worker/deno/lib/summary_claim_check.ts:864` — three or fewer cap overflows (no suffix) — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a small overflow warning lists every name with no 'and N more' (#4118)` — flipped to always-more, test went red
- `worker/deno/lib/summary_claim_check.ts:855` — a cap-overflow entry is skipped by the per-reason loop — `worker/deno/tests/summary_claim_check_test.ts::runSummaryClaimCheck - a non-cap reason after >3 cap overflows gets its own warning and is not aggregated (PR #4228 review)` — removed the `continue`, test went red
- `worker/deno/lib/summary_claim_check.ts:855` — a non-cap entry is logged on its own — same test — inverted the condition, test went red; aggregating `scope.notChecked` instead of `scope.capOverflow` also went red

## Mutation check

The earlier surviving mutants (the `repo` log-context properties and the `; and N more` ternary) are each killed by the tests above: the log context is recorded by `makeLogger().warnMeta` and asserted by `assertWarnedWithContext`, and the ternary by the two overflow-size tests. Line numbers shifted in the PR #4228 review fix, so they are not repeated here; the mutation check re-runs on the head.
