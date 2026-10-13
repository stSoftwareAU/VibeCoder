# Target-repo GitHub text cites VibeCoder issue numbers

## Summary

Two strings the worker posts into a **target** repository carried a VibeCoder
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

Closes #3501.

## Spec

### Intent and Rationale

Fleet text that lands in another repository must not carry a bare `#N`, because
GitHub resolves it against that repository. The issue asked for the sweep body
to be fixed and for the `(Issue #4396)` strings to be checked the same way.

### Essential Design Decisions

- **Drop the reference rather than qualify it.** `stSoftwareAU/VibeCoder#4193`
  would link correctly, but the target repo's readers gain nothing from it.
  Dropping it matches the issue's stated fix.
- **Local text left alone.** These keep their references because none of them
  reaches GitHub:
  - the module doc in `security_tree_sweep.ts`
  - the local `renderSweepReport` artefact
  - the `logger.warn` in `issue_lifecycle.ts`
  - the `#4396` hits in `pr_auto_merge.ts` (lines 93, 177, 179, 775), which
    are all code comments

### Undiscoverable Facts

The release reason reaches GitHub through this path:

1. `merged_pr_precheck_phase.ts:273` builds `merged_pr_did_not_land: ${reason}`.
2. `issue_worker.ts` passes it to `expectedNoPrOutcome`.
3. `heartbeat_storage.ts` renders the summary in two places: the release comment
   (`… (no PR expected for this phase.)`) and `releaseReasonLine`, which the
   superseded-release pointer uses.

## Evidence

Backend change, so there is no web interface to screenshot.

`./quality.sh < /dev/null` passed. `config integration` was skipped because no
`.config.json` exists in the worktree. The targeted unit run
`deno task test:unit tests/security_tree_sweep_test.ts
tests/issue_lifecycle_test.ts` gave 94 passed, 0 failed.

- **Docs sweep** — grep: "Whole-tree security sweep finding", "issue left open",
  `(Issue #4193)`, `(Issue #4396)`; section: the `buildSweepIssueBody` body
  template and the merged-PR-did-not-land `reason` in `issue_lifecycle.ts`;
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
- **Branch outcomes:** none added
