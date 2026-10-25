## Summary

`clear-worker-gate-labels` lists open issues labelled `failed` or `failed-once` and removes those labels when the latest "Automated Processing Failed" comment is fleet-authored and `isWorkerGateCategory` accepts the registry category for its display name. That predicate reads `WORKER_GATE_MARKERS`: summary-incomplete, security-fix-gate, pre-push-gate and criteria-unmet. quality-failure is the display of `quality_check` and is left labelled. Dry-run is the default, so omitting the flag removes nothing. A failed `gh issue list` is an error. The command was not run against live GitHub. Closes #4132.

The three-dot diff also merges `origin/main` into the milestone. A pre-push verdict block still gets one in-run turn. An unwritable mutation temp directory still sets `workerFault`. That block is reported on the advisory completion-gate path, which does not stop the pull request.

## Spec

### Intent and Rationale

- After the worker-gate fixes deploy, issues parked by a worker gate should be queued again. A timeout, a crash, a quality-failure, and a comment a non-fleet account wrote stay labelled.
- The issue's opening list names quality-failure. The task bullet says to use the worker-gate predicate. `isWorkerGateCategory` is that predicate. It does not accept `quality_check`, and it does accept `criteria_unmet`. The command follows the predicate.
- The sweep is a one-off command, run by a person, next to `analyse-failed-once`. It is not part of the worker loop.

### Essential Design Decisions

- Dry-run is the default (`coerceBooleanFlag` fallback `true`), the same choice `pr-manager close-duplicate-prs` makes for a destructive action. A live run is `deno run mod.ts clear-worker-gate-labels --dry-run false`. A value that is not `true` or `false` is refused.
- The category text is `parseCategoryFromComment` from `analyse_failed_once.ts`. The author check is `isFleetAuthor`. A display is cleared when a `WORKER_GATE_MARKERS` entry has that display and `isWorkerGateCategory` accepts the entry's category. The report and the help text name those displays from the registry.
- The latest `## Automated Processing Failed` comment is the one that counts. Its author is checked after that choice, so a newer forged comment does not give way to an older fleet comment, and an older gate comment does not clear a newer timeout.
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
- The cleared set is `isWorkerGateCategory` over `WORKER_GATE_MARKERS` (`worker/deno/lib/failure_diagnosis.ts`). No second list of category names was added. The no-config allow-list in `worker/deno/mod.ts` already exists in two places; both register `clear-worker-gate-labels`.
- Dry-run lists `#3860` as `pre-push-gate` / `would-remove` and `#4046` as `timeout` / `keep`, and the recorded `gh` calls include no `--remove-label`.
- A live run on that pair edits `#3860` and leaves `#4046`. A fleet-authored `quality-failure` stays labelled. A fleet-authored `criteria-unmet` is removed. A non-fleet author is left labelled. A failed list removes nothing.
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
- **clean** — DRY: the cleared set is `isWorkerGateCategory` over `WORKER_GATE_MARKERS`, and the category text is `parseCategoryFromComment`. — evidence: `worker/deno/commands/clear_worker_gate_labels.ts`
- **clean** — Twinned copies: the category set is not copied. Both no-config allow-lists in `mod.ts` register `clear-worker-gate-labels`. — evidence: `worker/deno/mod.ts`

## Milestone merge validation

Reconciled the milestone with current main for PR #4380. Kept the milestone's one-turn pre-push recovery, mutation temp-directory handling, prompt canary and security-sweep cleanups. Kept main's typed disk admissions, nested Deno discovery and later-session infrastructure-fault classification. The conflict resolutions passed 254 focused tests, all 857 manifest checks (one ignored), formatting and lint.
