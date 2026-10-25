## Summary

Open issues labelled `failed` or `failed-once` only because a fleet-authored worker gate refused them can be returned to the queue once those gate fixes are deployed. `clear-worker-gate-labels` lists those issues, logs every one with its category and the action taken, and removes the label only for the four categories Issue #4132 names. Dry-run is the default, so omitting the flag removes nothing. Closes #4132.

The branch also merges `origin/main` into the milestone. The milestone's one in-run pre-push recovery turn remains. An unwritable mutation temp directory is still reported as a worker fault, and the pull request is still raised.

## Spec

### Intent and Rationale

- After the worker-gate fixes deploy, issues parked by those gates should be queued again. Timeouts, crashes, and comments a non-fleet account wrote stay labelled.
- The sweep is a one-off command, run by a person, next to `analyse-failed-once`. It is not part of the worker loop.

### Essential Design Decisions

- Dry-run is the default (`coerceBooleanFlag` fallback `true`), the same choice `pr-manager close-duplicate-prs` makes for a destructive action. A live run is `deno run mod.ts clear-worker-gate-labels --dry-run false`. A value that is not `true` or `false` is refused.
- The category text is `parseCategoryFromComment` from `analyse_failed_once.ts`. The author check is `isFleetAuthor`, after `resolveAlertDedupAuthors` / `resolveFleetMaintenanceAuthorSet`. Issue and comment JSON is `parseLabelledIssues` and `parseCommentRows`.
- The latest `## Automated Processing Failed` comment is the one that counts. Its author is checked after that choice, so a newer forged comment does not give way to an older fleet comment, and an older gate comment does not clear a newer timeout.
- `isWorkerGateCategory` reads `WORKER_GATE_MARKERS`: summary-incomplete, security-fix-gate, pre-push-gate, and criteria-unmet. Issue #4132 names summary-incomplete, quality-failure, pre-push-gate, and security-fix-gate. The command clears those four. quality-failure is named by the issue and is not a `WORKER_GATE_MARKERS` category, so the predicate cannot accept it and the command clears it by that name. criteria-unmet is a `WORKER_GATE_MARKERS` category and is not named, so the command leaves it labelled. The report prints this on every run.
- Every `gh issue list` and comment read finishes before any `gh issue edit`. A failed list, an unreadable payload, or a failed comment read is a non-zero result. An empty JSON array is an empty sweep. An unresolved fleet author set removes nothing.
- Both `failed` and `failed-once` are listed separately, because `gh issue list` ANDs repeated `--label` flags. An issue carrying both loses both when it is cleared.

### Undiscoverable Facts

- `analyse-failed-once` has no dry-run flag because it never writes. The destructive default is taken from `pr-manager close-duplicate-prs`.
- `gh issue list --json comments` is not used. The author is read from `gh issue view --json comments`, which is the payload `parseCommentRows` accepts.
- The command was not run against live GitHub. VibeCoder#3860 and VibeCoder#4046 appear only as fixture issue numbers in the unit test.

## Evidence

Backend only; no UI files changed. The run instructions are the command `description`, which is the text the command registry returns for help. `docs/` has no list of `analyse-failed-once`, so no manual section was added.

`deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/clear_worker_gate_labels_test.ts` in `worker/deno`: `13 passed | 0 failed`. The `gh` function is injected. No test calls GitHub.

The merge resolution for the unwritable mutation temp directory was checked with `tests/completion_phase_mutation_gate_test.ts`, `tests/completion_phase_pre_push_gate_3689_test.ts`, and `tests/mutation_gate_test.ts`: `110 passed | 0 failed`.

## Test Plan

- `worker/deno/tests/clear_worker_gate_labels_test.ts` drives `clearWorkerGateLabels` with an injected `gh` seam.
- Reused `parseCategoryFromComment` (`worker/deno/commands/analyse_failed_once.ts`) for the `**Category:**` line.
- Reused `isFleetAuthor` (`worker/deno/lib/fleet_authors.ts`), with the fleet set from `resolveAlertDedupAuthors` and `resolveFleetMaintenanceAuthorSet` (`worker/deno/lib/alert_dedup_authors.ts`, `worker/deno/lib/fleet_authors.ts`).
- Reused `parseLabelledIssues` and `parseCommentRows` (`worker/deno/lib/issue_sweep_parse.ts`).
- Reused `isWorkerGateCategory`, `WORKER_GATE_MARKERS`, and `getFailureCategoryDisplay` (`worker/deno/lib/failure_diagnosis.ts`) for the three named categories the predicate covers. quality-failure is compared as `getFailureCategoryDisplay("quality_check")`.
- Dry-run lists `#3860` as `pre-push-gate` / `would-remove` and `#4046` as `timeout` / `keep`, and the recorded `gh` calls include no `--remove-label`.
- A live run edits `#3860` only. The command was not run against live GitHub.

## Acceptance Criteria

- **met** — In dry run, the command lists every candidate issue with its category and planned action, and changes nothing. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - dry-run lists category and planned action and changes nothing` — reviewer: met
- **met** — A real run removes the label only from issues whose fleet-authored failure comment names a worker-gate category. VibeCoder#3860 (pre-push `deno fmt`) is cleared, VibeCoder#4046 (`timeout`) is not. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - a live run removes the label only for a fleet-authored worker-gate comment` — reviewer: met
- **met** — A failure comment written by a non-fleet account is ignored. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - covers a worker-gate category, a non-gate category, a missing comment and a forged comment` — reviewer: met
- **met** — Tests cover a worker-gate category, a non-gate category, a missing comment, and a forged comment. — evidence: `worker/deno/tests/clear_worker_gate_labels_test.ts` `clear - covers a worker-gate category, a non-gate category, a missing comment and a forged comment` — reviewer: met
