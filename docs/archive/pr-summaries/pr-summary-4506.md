## Summary

The CI-fix classifier no longer routes an ordinary failure to `history-rewrite-required` because a job log carries gitleaks' own `leaks found` text. The bare `"leaks found"` entry is removed from `HISTORY_REWRITE_TEXT_PATTERNS` in `worker/deno/lib/ci_failure_classifier.ts`. Closes #4506.

## Spec

### Intent and Rationale

- gitleaks prints `INF no leaks found` on a clean scan and `WRN leaks found: 1` from a passing `--no-git` negative proof; neither concerns the branch's commits, yet the substring matched the whole job log and beat the real failure's code-fix signals, so the branch was squashed and force-pushed.

### Essential Design Decisions

- Range-scoped findings stay recognised by check name (`HISTORY_REWRITE_CHECK_NAMES`) and the commit fingerprint regex; `secrets detected` and `verified secret` are kept. No counted-finding text pattern was added, since nothing in the issue requires one.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change. Tests in `worker/deno/tests/ci_failure_classifier_test.ts`. Not changed here: the missing `ownedAuthorEmails` argument at `pr_ci_processor.ts` that the issue notes in passing; it is outside the stated fix.

## Test Plan

- Added three tests in `worker/deno/tests/ci_failure_classifier_test.ts`: `lint` + AssertionError + `INF no leaks found` → `code-fix-required`; the same + `WRN leaks found: 1` → `code-fix-required`; `security` + bare `WRN leaks found: 1` is not `history-rewrite-required`.
- Red check: with `"leaks found"` restored, all three new tests fail; with it removed, `deno task test:unit tests/ci_failure_classifier_test.ts` passes (53 passed, 0 failed).
- Existing gitleaks, full-history sweep, fingerprint and outranks-code-fix tests are unchanged and pass. No assertions removed.
- Twinned rules: searched for `leaks found` and `HISTORY_REWRITE_TEXT` in code and docs; the only other hit is a historical log row in `docs/pre-pr-ci-audit.md`.
