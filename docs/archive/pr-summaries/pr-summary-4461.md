## Summary

A repository-admin finding whose setting the repository or the worker's token refuses now steps the normal `failed-once` ladder and its escalating cooldown, as Issue #4298 intended. Before, it was retried on a flat cooldown forever with no label and no written record. Closes #4461.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The `admin_only_repair` failure returned category `internal_error`. `isInfrastructureFailure` counts that as infrastructure, so `classifyCodingFailure` returned `transient` and `planCodingFailure` set `applyLadder: false` with no cooldown kind.
- The refused case now returns category `unknown`, which the ladder records. The `REPO_ADMIN_REFUSED` classification (class `repo-config`) is kept, so the run-failure filer still suppresses it (Issue #4442).

### Essential Design Decisions

- The ladder was chosen over the issue's other suggestion, `repo_config`. That category is record-only (comment once, no label, no cooldown), so the loop would still be flat. The `failed-once` ladder is what #4298 and the comment in `issue_worker.ts` promise.
- Record-only in `classifyCodingFailure` is now gated on `category === "repo_config"`, not on the `repo-config` class alone, because `REPO_ADMIN_REFUSED` carries that class. The milestone-branch refusal (Issue #2220) is unchanged.
- Only a declared refusal (`RepoAdminRefusalError`) changes. An unmapped finding, a hardener fault or a 422/5xx write stays `internal_error`, which is transient and a worker-crash (Issue #4442).
- The ladder is never terminal (Issue #4158): the issue stays claimable and the escalating cooldown paces retries.

### Undiscoverable Facts

- None.

## Evidence

Backend only, no UI. From `worker/deno`:
`deno task test:unit tests/coding_failure_ladder_test.ts tests/issue_worker_test.ts tests/run_failure_issue_test.ts` ran 192 passed, 0 failed. `deno fmt --check`, `deno lint` and `deno check` on the five changed files exit 0.

Docs sweep: `docs/USAGE.md` (the "What is never escalated" paragraph) already says a repository-admin finding is "retried on the `failed-once` ladder when the token cannot", which is now true; no doc change was needed. Doc comments updated: `RECORD_ONLY_FAILURE_CLASSES` in `lib/coding_failure_ladder.ts` and the comment above the `admin_only_repair` block in `lib/issue_worker.ts`.

## Test Plan

- `worker/deno/tests/coding_failure_ladder_test.ts`:
  - Removed from `worker/deno/tests/coding_failure_ladder_test.ts`: `classifyCodingFailure #4442 - a refused repository-admin setting is transient here, never a record-only repo-config` (asserted `transient` for the refusal).
    - Replaced by: `classifyCodingFailure #4461 - a refused repository-admin setting enters the failed-once ladder, not record-only`. The issue says the refusal "never gets `failed-once` or `failed`", so `transient` was the defect.
  - Added `classifyCodingFailure #4442` (`internal_error` with no classification stays `transient`), `planCodingFailure #4461` (phase `admin_only_repair`) and `applyCodingFailureLadder #4461` (handler called once, category `unknown`).
- `worker/deno/tests/issue_worker_test.ts`: the refused-fix test now expects category `unknown`. Removed: `assertEquals(result.category, "internal_error")`. Required by the change: the refused case now returns `unknown`. Every other assertion in it is kept.
- `worker/deno/tests/run_failure_issue_test.ts`: the refused fixture uses category `unknown`, still `suppressed` / `repo-config`. No assertion removed.
- Red checks: with only the category change reverted, the issue_worker refused-fix test went red (`internal_error` against `unknown`). With only the record-only gate change reverted, the three `#4461` tests in `coding_failure_ladder_test.ts` went red.

- `./quality.sh < /dev/null` on the final code: Result PASSED (with skipped checks: config integration, checkov).
