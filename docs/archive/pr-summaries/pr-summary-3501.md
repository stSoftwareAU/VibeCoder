# Target-repo GitHub text cites VibeCoder issue numbers

## Summary

Four strings the worker posts into a **target** repository carried a VibeCoder
issue number that GitHub autolinks to an unrelated issue there:

- **Security-sweep finding body.** `buildSweepIssueBody` ended its first line
  with `(Issue #4193)`. The body is filed with `gh issue create --repo <swept
  slug>`, so `#4193` pointed at whatever issue that number is in the swept repo.
  The reference is removed.
- **Merged-PR-did-not-land release reason.** The `reason` returned from
  `issue_lifecycle.ts` ended with `(Issue #4396)`. That reason becomes the
  `no_pr_expected` summary rendered into the claim-release comment on the worked
  issue, which can be in any target repo. The reference is removed from the
  reason. The adjacent `logger.warn` keeps it, because it is a local log line.
- **Milestone route-closed hold comment.** `renderRouteClosedHoldComment` in
  `milestone_children_gate.ts` built the comment `holdOrphanBoundPr` posts on a
  target-repo PR with `gh pr comment`. Its text cited `(Issue #4396)` and
  `(Issue #3433)`. Both are removed from the comment. The function's doc
  comment and the local `log` line keep them.
- **Orphaned-rollup PR body.** `buildOrphanedRollupBody` in
  `orphaned_rollup.ts` is raised with `gh pr create --repo <target>`. Its body
  cited `(Issue #4396)` and `(Issue #175)`. Both are removed. The body still
  cites the orphaned PR's own number, which belongs to that repo.

Closes #3501.

## Spec

### Intent and Rationale

Fleet text that lands in another repository must not carry a bare `#N`, because
GitHub resolves it against that repository. The issue asked for the sweep body
to be fixed and for the `(Issue #4396)` strings to be checked the same way.
Every `(Issue #4396)` runtime string was checked. The hold comment and the
rollup body also cited a second VibeCoder issue (`#3433`, `#175`) in the same
text, so those references are removed in the same edit.

### Essential Design Decisions

- **Drop the reference rather than qualify it.** `stSoftwareAU/VibeCoder#4193`
  would link correctly, but the target repo's readers gain nothing from it.
  Dropping it matches the issue's stated fix.
- **Local text left alone.** These keep their references because none of them
  reaches GitHub:
  - the module doc in `security_tree_sweep.ts`
  - the local `renderSweepReport` artefact
  - the `logger.warn` lines in `issue_lifecycle.ts` and `pr_maintenance.ts`
    ("Not closing issue …")
  - the `console.warn` in `stuck_recovery.ts` ("Self-healing: merged PR …")
  - the `log` line in `holdOrphanBoundPr`, which cites `(Issue #3433)`
  - every other `#4396` hit under `worker/deno/lib/`, for example in
    `pr_auto_merge.ts`, `direct_merge.ts` and `milestone_children_gate.ts`.
    These are all code comments.
- **Out of scope.** Other target-repo comments cite `(Issue #3433)`, for
  example in `pr_base_integrity.ts`. The issue covers the `#4193` sweep body
  and the `(Issue #4396)` strings, so those are not changed here.

### Undiscoverable Facts

The release reason reaches GitHub through this path:

1. `merged_pr_precheck_phase.ts:273` builds `merged_pr_did_not_land: ${reason}`.
2. `issue_worker.ts` passes it to `expectedNoPrOutcome`.
3. `heartbeat_storage.ts` renders the summary in two places: the release comment
   (`… (no PR expected for this phase.)`) and `releaseReasonLine`, which the
   superseded-release pointer uses.

## Evidence

Backend change, so there is no web interface to screenshot.

`./quality.sh < /dev/null` passed at head. `config integration` was skipped
because no `.config.json` exists in the worktree. Targeted runs:

- `deno task test:unit tests/security_tree_sweep_test.ts
  tests/issue_lifecycle_test.ts`: 94 passed, 0 failed.
- `deno test -A tests/milestone_children_gate_test.ts
  tests/pr_auto_merge_test.ts`: 103 passed, 0 failed.
- `deno test -A tests/orphaned_rollup_test.ts`: 11 passed, 0 failed.

- **Docs sweep** — grep: "Whole-tree security sweep finding", "issue left open",
  `(Issue #4193)`, `(Issue #4396)`, "closed as completed (Issue #4396)",
"Raised automatically by the Vibe Coder (Issue #175)"; section: the `buildSweepIssueBody` body
  template, the merged-PR-did-not-land `reason` in `issue_lifecycle.ts`, the
`renderRouteClosedHoldComment` text and the `buildOrphanedRollupBody` text;
  siblings: none — no set gained a member; updated: none; advisory hits re-read:
  `worker/deno/setup/content_label_definitions.ts:98` — still true, it is a
  label description with no issue reference.

## Test Plan

- `worker/deno/tests/security_tree_sweep_test.ts`, test
  `buildSweepIssueBody - carries no bare #N issue reference (Issue #3501)`:
  - It builds a body from a fixture cluster that holds no `#digits`, and asserts
    that no bare `#<digits>` appears.
  - Red-check: restoring `(Issue #4193)` made it fail (93 passed, 1 failed).
    Removing it again made it pass.
- `worker/deno/tests/issue_lifecycle_test.ts`, the existing test
  "…did not land leaves the issue OPEN with the reason (Issue #4396)":
  - It now also asserts that the reason carries no `(Issue #N)`.
  - Red-check: restoring ` (Issue #4396)` made it fail (93 passed, 1 failed).
    Removing it again made it pass.
- `worker/deno/tests/milestone_children_gate_test.ts`, test
  `renderRouteClosedHoldComment - carries no bare #N apart from the rollup PR
  or milestone it names (Issue #3501)`:
  - It renders the comment for a merged rollup (`#41`), a closed milestone
    with a number (`#7`) and one without a number. It asserts that the only
    `#<digits>` in each comment is the expected one, or that there are none.
  - Red-check: restoring `(Issue #4396)` made it fail (38 passed, 1 failed).
    Removing it again made it pass.
- `worker/deno/tests/orphaned_rollup_test.ts`, test
  `orphaned-rollup - body cites no bare #N apart from the orphaned PR
  (Issue #3501)`:
  - It asserts that `#4211`, the orphaned PR, is the only `#<digits>` in the
    body.
  - Red-check: restoring `(Issue #4396)` made it fail (10 passed, 1 failed).
    Removing it again made it pass.
- **Branch outcomes:** none added
