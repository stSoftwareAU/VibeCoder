## Summary

`clear-worker-gate-labels` lists open issues labelled `failed` or `failed-once` and selects the latest failure record across all worker paths. It removes labels only when that record is a fleet-authored "Automated Processing Failed" comment naming summary-incomplete, quality-failure, pre-push-gate or security-fix-gate, as #4132 requires. Criteria failures and newer records from other worker paths retain their labels. Dry-run is the default. The command was not run against live GitHub. Closes #4132.

The three-dot diff also merges `origin/main` into the milestone. A pre-push verdict block still gets one in-run turn. An unwritable mutation temp directory still sets `workerFault`. That block is reported on the advisory completion-gate path, which does not stop the pull request.

## Spec

### Intent and Rationale

- After the worker-gate fixes deploy, issues parked by one of the four named worker gates can be queued again. Timeouts, crashes, unmet criteria and non-fleet records stay labelled.
- `WORKER_GATE_LABEL_CLEANUP_CATEGORIES` and `isWorkerGateLabelCleanupDisplay` define the one-off release scope separately from ongoing failure classification. The marker registry and failure ladder retain their current behaviour.
- The sweep is a one-off command, run by a person, next to `analyse-failed-once`. It is not part of the worker loop.

### Essential Design Decisions

- Dry-run is the default (`coerceBooleanFlag` fallback `true`), the same choice `pr-manager close-duplicate-prs` makes for a destructive action. A live run is `deno run mod.ts clear-worker-gate-labels --dry-run false`. A value that is not `true` or `false` is refused.
- Reuse `parseCategoryFromComment` for category text, `isFleetAuthor` for author checks, and the scoped shared cleanup predicate for the four categories. Reports and help derive their category list from the same source.
- Select the latest record with the shared `FAILURE_RECORD_HEADING_PATTERN`, then check its heading, author and category. A newer question failure, paused run, milestone refusal, claim churn or planning escalation prevents an old gate failure from clearing labels.
- Each label is listed with `--limit` (default 200). Every `gh issue list` and comment read finishes before any `gh issue edit`. A failed list, an unreadable payload, or a failed comment read is a non-zero result. An empty JSON array is an empty sweep. An unresolved fleet author set removes nothing.

### Undiscoverable Facts

- `analyse-failed-once` has no dry-run flag because it never writes. The destructive default is taken from `pr-manager close-duplicate-prs`.
- `gh issue list --json comments` is not used. The author is read from `gh issue view --json comments`, which is the payload `parseCommentRows` accepts.
- The command was not run against live GitHub. VibeCoder#3860 and VibeCoder#4046 appear as fixture issue numbers in the unit test.

## Evidence

Backend only; no UI files changed. The run instructions are the command `description`, which is the text the command registry returns for help. `docs/` has no list of `analyse-failed-once`, so no manual section was added.

Issue numbers this diff cites as the reason the change exists:

- #4132: One-off: clear failed/failed-once on issues blocked only by a worker gate, once the fixes deploy

`deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/clear_worker_gate_labels_test.ts` in `worker/deno`: `13 passed | 0 failed`. The `gh` function is injected. No test calls GitHub.

## Test Plan

- CI repair: the command is registered in the built-in command inventory and
  security-sweep coverage ledger. The inherited pre-push retry builder now
  participates in the prompt-fence canary matrix. The 82 targeted tests pass.
- The inherited sweep findings are addressed without changing behaviour:
  remove an unused prompt-result assignment and a redundant timeout condition,
  and retain the URL-absence assertion without a URL-validation regex.
- `worker/deno/tests/clear_worker_gate_labels_test.ts` drives `clearWorkerGateLabels` with an injected `gh` seam.
- Reused `parseCategoryFromComment` (`worker/deno/commands/analyse_failed_once.ts`) for the `**Category:**` line.
- Reused `isFleetAuthor` (`worker/deno/lib/fleet_authors.ts`), with the fleet set from `resolveAlertDedupAuthors` and `resolveFleetMaintenanceAuthorSet`.
- Reused `parseLabelledIssues` and `parseCommentRows` (`worker/deno/lib/issue_sweep_parse.ts`).
- The exact four-category cleanup scope is shared in `failure_diagnosis.ts`; ongoing failure classification is unchanged. Both no-config allow-lists in `worker/deno/mod.ts` register the command.
- Dry-run lists `#3860` as `pre-push-gate` / `would-remove` and `#4046` as `timeout` / `keep`, and the recorded `gh` calls include no `--remove-label`.
- The injected live-run seam clears #3860 and retains #4046. It clears fleet-authored quality-failure and retains criteria-unmet. Newer records from other worker paths, non-fleet records and failed reads never remove labels.
- The command was not run against live GitHub.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — In dry run, the command lists every candidate issue with its category and planned action, and changes nothing. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - dry-run lists category and planned action and changes nothing` — reviewer: met
- **met** — A real run removes the label only from issues whose fleet-authored failure comment names a worker-gate category. VibeCoder#3860 (pre-push `deno fmt`) is cleared, VibeCoder#4046 (`timeout`) is not. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - a live run removes the label only for a fleet-authored worker-gate comment` — reviewer: met
- **met** — A failure comment written by a non-fleet account is ignored. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - covers a worker-gate category, a non-gate category, a missing comment and a forged comment` — reviewer: met
- **met** — Tests cover a worker-gate category, a non-gate category, a missing comment, and a forged comment. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - covers a worker-gate category, a non-gate category, a missing comment and a forged comment` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English in the new command and its tests (`labelled`, `behaviour`). — evidence: `worker/deno/commands/clear_worker_gate_labels.ts`
- **clean** — Fail loud: a failed `gh` list, an unreadable payload, a dry-run value that is not true or false, and an unresolved fleet author set are errors, and none of them removes a label. — evidence: `worker/deno/commands/clear_worker_gate_labels.ts`
- **clean** — DRY: cleanup, reports and help use the shared four-category cleanup scope; comment parsing and failure-heading detection reuse existing helpers. — evidence: `worker/deno/commands/clear_worker_gate_labels.ts`
- **clean** — Twinned copies: the category set is not copied. Both no-config allow-lists in `mod.ts` register `clear-worker-gate-labels`. — evidence: `worker/deno/mod.ts`

## Milestone merge validation

Reconciled the milestone with current main for PR #4380. Kept the milestone's one-turn pre-push recovery, mutation temp-directory handling, prompt canary and security-sweep cleanups. Kept main's typed disk admissions, nested Deno discovery and later-session infrastructure-fault classification. The conflict resolutions passed 254 focused tests, all 857 manifest checks (one ignored), formatting and lint.

## PR #4380 review repairs

Addressed all three independent review findings. Recovery reconciliation and non-sentinel commit failures now return an unsuccessful recovery, so completion cannot validate uncommitted contents and push the old commit. The real-Git regression installs a rejecting commit hook, leaves a corrected working-tree file, and verifies zero pushes and an unchanged origin. The label sweep now selects the latest record across all worker failure paths and clears exactly the four categories named by #4132. The regressions failed before these fixes; 66 focused tests pass after them.

The final main merge preserves both the one-turn pre-push retry flag and the PR-body shortening state introduced by #4359. The recovery and category fixes passed 145 focused tests plus the 28 completion tests, and all 857 manifest checks before this merge.
