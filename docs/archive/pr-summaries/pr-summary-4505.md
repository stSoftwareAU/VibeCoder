## Summary

The milestone rollup fingerprint is now the full 64-hex SHA-256 instead of its first 32 hex characters, so `spawnGh`'s `hex32-credential` redaction no longer masks it as `***REDACTED***`. A second scan now recognises the published body as current, so it neither rewrites it nor erases owner edits. Closes #4505.

## Spec

### Intent and Rationale

- The truncated fingerprint was published as `value="***REDACTED***"`, so `refreshExistingSummaryPr` never saw the current value and rewrote the body on every scan. Using the full digest (as `PR_SUMMARY_DIGEST_PREFIX` does) avoids the rule without weakening it.

### Essential Design Decisions

- The `hex32-credential` rule is left unchanged (it guards a real credential shape).
- Existing open summary PRs carry `***REDACTED***`, so each is rewritten once on the first scan after this change, then left alone. No old-shape reader is needed because a mismatch only triggers that one rebuild.

### Undiscoverable Facts

- None.

## Evidence

- `summaryPrFingerprint` in `worker/deno/lib/milestone_completion.ts` returns the full digest.
- The shared test mock `completedMilestoneWithRollupGhFn` in `worker/deno/tests/milestone_completion_test.ts` now stores `redactGhBodyText(body)`, the mask `spawnGh` applies. Against the unfixed code two tests failed (the second-scan test and the changed-classification test, which expected no further edit); with the fix all 148 tests in the file pass.

## Test Plan

- `deno test -A tests/milestone_completion_test.ts` (from `worker/deno`): 148 passed, 0 failed.
- Edited `worker/deno/tests/milestone_completion_test.ts` mock only; no assertions removed. Red check: the unchanged production code makes the two tests above fail.
- `./quality.sh` on the final head: PASSED for lint, type check, fmt, semgrep and markdownlint. FAILED for the spawn-chokepoint scans (`worker/deno/commands/fleet_pr_babysitter.ts:32`), completeness checks (`lib-sweep-coverage.json`) and a full deno test run (formatter and chokepoint tests). None of these files is in this diff; I did not run the gate on the base branch to confirm they fail there too.
