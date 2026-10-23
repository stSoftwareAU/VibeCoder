# PR Summary — Issue #4118

Closes #4118

## Summary

The first-run PR-summary claim check (`runSummaryClaimCheck`) logged every
degradation that lets the run carry on at ERROR, and logged doc-prose cap
overflow as one ERROR per range (20 lines for a 20-file overflow). Every such
case now logs at WARNING, and cap overflow is aggregated into one warning per
claim check carrying the count and the first three names (`; and N more` for
the rest). The `notChecked` list returned to callers is unchanged.

- `worker/deno/lib/summary_claim_check.ts` — `ls-files failed`, Test Plan
  backstop reasons, `base ref could not be resolved`, `changed files could not
  be listed`, a file read error and a prompt-build failure move from `error` to
  `warn`; the per-range loop becomes one aggregated warning with
  `notCheckedCount` in its context.
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

Run from `worker/deno`: `deno test -A tests/summary_claim_check_test.ts` — 75 passed, 0 failed.

- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assert(logger.errors.some((e) => e.includes("well-formed base ref")));`
  Required by: "It no longer logs one ERROR per range"
  Replaced by: `assert(logger.warns.some((e) => e.includes("well-formed base ref")));`
- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assert( logger.errors.some((e) => e.includes("changed files could not be listed")), );`
  Required by: "any that continue the run move to WARNING too"
  Replaced by: `logger.warns.some((e) => e.includes("changed files could not be listed")),`

Both removed assertions pinned the old ERROR level for a degradation that
continues the run; the issue makes that level untrue, and the same fragments
are asserted at WARNING instead.

**Docs sweep** — grep: `error level`, `logs these at error`, `summary_claim_check`; section: `docs/workflows/issue-processing.md` (the claim-check section: base-ref logging and the not-checked paragraph); siblings: the other `error level` hits (pre-PR verifier hold post, standing-violation fail-closed) belong to other features and stay true; updated: `docs/workflows/issue-processing.md`

<!-- vibe-branch-outcomes -->

## Mutation check

The seven surviving mutants (`:764` call and `repo`, `:804` call and `repo`, `:812` `repo`, `:854` ternary, `:877` `repo`) are each killed by the tests above: the log context is now recorded by `makeLogger().warnMeta` and asserted by `assertWarnedWithContext`. Each was re-applied by hand and a test went red.
