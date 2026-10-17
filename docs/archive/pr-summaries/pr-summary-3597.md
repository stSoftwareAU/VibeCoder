## Summary

The "Held by the fleet" comment (`<!-- vibe-held-issue-gate … -->`) could be posted twice in the same second. Two scanning slots or hosts could each read the thread, find no fleet marker, and each POST one. Nothing ever removed the second comment, and later edits only touched the newest. `upsertHeldIssueGateComment` now goes through a shared `pruneDuplicateFleetMarkerComments` helper. It keeps the oldest fleet-authored marker comment and deletes newer fleet duplicates. It runs before the upsert decides anything and again after a POST, so two racing runs end with one comment and an issue that already has duplicates is reduced to the oldest. The self-schedule-diagnostic announcement has the same find-then-post race and now uses the same helper. Closes #3597.

## Spec

### Intent and Rationale

- Within one pass, `findOldestIssue` already skips an issue it has reported. The duplicates come from several slots or hosts scanning the same issue at once. A lock across hosts is not available, so the fix makes the race harmless: every writer converges on the oldest comment.
- The upsert now edits the **oldest** fleet marker instead of the newest, so the comment it edits is the one the prune keeps.

### Essential Design Decisions

- `pruneDuplicateFleetMarkerComments` (`worker/deno/lib/marker_comment_pages.ts`) deletes only comments written by a fleet account (`isFleetAuthor`). An empty fleet list deletes nothing. A DELETE answered with HTTP 404 counts as already deleted, because a racing run may have removed the comment first. Any other failure is thrown after every delete has been attempted, and the error names each failed comment.
- On the self-schedule path, a failed prune refuses that scan's schedule as `announce-failed`. This matches the existing rule there that an untraceable decision is not scheduled.

### Undiscoverable Facts

- `gh` reports an already-removed comment as `{"message":"Not Found",...,"status":"404"}` followed by `gh: Not Found (HTTP 404)`, which is what the 404 check matches.

## Evidence

Backend-only change; verified by tests (below) and the full quality gate.

- Issue numbers this diff cites as provenance: #3597: Held-gate comment is posted twice in the same second.

**Docs sweep** — grep: `vibe-held-issue-gate`, `upsertHeldIssueGateComment`, `pruneDuplicateFleetMarkerComments`, `fetchMarkerComments`, `deleteIssueComment`, `updateIssueComment`, `marker_comment_pages`, `self-schedule-diagnostic`, "edited in place", "newest fleet", "posted once"; section: `docs/INTERNALS.md` ("One comment, edited in place" bullet of the held-issue gate comment), `docs/workflows/issue-processing.md#-self-scheduled-worker-diagnostics-tier-2b` ("Visible" row), `docs/TROUBLESHOOTING.md` ("Step 2 — read the gate comment on the blocked issue"); siblings: `fetchMarkerComments`, `deleteIssueComment`, `updateIssueComment` (the exports of `marker_comment_pages.ts` that the new helper joins). No doc lists that module's exports as a complete set: `docs/GH-API-OPTIMISATION.md:305` names only `parseMarkerCommentPages`, and the `docs/audits/security-sweep-2755-lib-delta-12a-12c.md:148` row ("all four callers filter by fleet author before any update or delete") is still true because the prune filters by fleet author itself; updated: `docs/INTERNALS.md`, `docs/workflows/issue-processing.md` (the "Visible" row now also says a duplicate announcement that cannot be deleted refuses the schedule), `docs/audits/security-sweep-2496-chain-root-comment.md` ("several fleet markers on one thread" row). Read and left unchanged: `docs/TROUBLESHOOTING.md:705-709` ("one *Held by the fleet* comment … edited in place when the gate moves") is now true, and the `docs/audits/security-sweep-2758-top-up-delta.md:188-191` bullet ("keeps only `isFleetAuthor` comments from `fetchMarkerComments`") is still true because the prune reads through `fetchMarkerComments` and filters by `isFleetAuthor`.

## Test Plan

- Added `worker/deno/tests/marker_comment_pages_prune_test.ts`: keeps the oldest fleet comment and deletes later fleet duplicates; never deletes a non-fleet comment; returns null and deletes nothing when no fleet comment carries the marker or the fleet list is empty; a DELETE answered with HTTP 404 counts as already deleted; a DELETE refused with HTTP 403 throws and names every failed comment.
- Added to `worker/deno/tests/held_issue_gate_comment_test.ts`: "two concurrent upserts for the same issue and key leave exactly one held-gate comment" (acceptance criterion 1); "an issue already carrying duplicate fleet held-gate comments is reduced to the oldest" (acceptance criterion 2); a stranger's held-gate marker is never deleted.
- Added to `worker/deno/tests/collect_self_diagnostic_candidates_test.ts`: duplicate fleet announcements are reduced to the oldest; a racing announcement leaves exactly one; a stranger's marker is never deleted, including one between two fleet comments; a 403 on the duplicate delete refuses the schedule. That last test now also asserts `result.refusals[0]!.issueNumber === 39`. With that assertion, deleting `issueNumber` from the refusal at `worker/deno/lib/collect_self_diagnostic_candidates.ts:571` turns the test red (a TS2345 type error under type check; with `--no-check`, "a 403 on the duplicate delete refuses the schedule (Issue #3597)" FAILED, 22 passed, 1 failed). The source was restored afterwards.
- Edited existing test `worker/deno/tests/held_issue_gate_comment_test.ts`: "edits the newest fleet marker when several exist" is renamed to "edits the oldest fleet marker and deletes newer duplicates".
  - Removed from `worker/deno/tests/held_issue_gate_comment_test.ts`: `assertEquals(patch[3], "repos/owner/repo-a/issues/comments/22");` — #3597 requires keeping the oldest held-gate comment and deleting the extra ones, so the PATCH now targets comment 11 (the oldest), not 22. Comment 22 is now asserted as the one DELETE target (`assertEquals(deletes(calls).map((c) => c[3]), ["repos/owner/repo-a/issues/comments/22"])`).
- `deno test -A tests/held_issue_gate_comment_test.ts tests/marker_comment_pages_prune_test.ts tests/collect_self_diagnostic_candidates_test.ts` → 59 passed, 0 failed; `deno fmt --check` and `deno lint` on the edited test file are clean. The worker re-runs the full quality gate.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Two upserts for the same issue and key, in one pass or concurrently, leave exactly one held-gate comment. — evidence: `worker/deno/tests/held_issue_gate_comment_test.ts::upsertHeldIssueGateComment - two concurrent upserts for the same issue and key leave exactly one held-gate comment` — reviewer: met
- **partial** — An issue that already carries duplicates is reduced to one on the next pass. — evidence: `worker/deno/tests/held_issue_gate_comment_test.ts::upsertHeldIssueGateComment - an issue already carrying duplicate fleet held-gate comments is reduced to the oldest` — reviewer: partial — reason: `reportHeldIssueGate` returns `"cached"` without reading the thread while the 24-hour `held_issue_gate_<n>` cache entry is valid, so an issue that got duplicates before this fix may only be cleaned up when that entry expires, not on the very next pass; no test drives the cached path.
- **partial** — Self-heal by deleting extra held-gate comments "this account authored", keeping the oldest. — evidence: `worker/deno/lib/marker_comment_pages.ts` — reviewer: partial — reason: it deletes duplicates written by any fleet account, which is broader than this account alone. This matches the module's existing fleet-author trust rule, and non-fleet comments are never deleted.
- **partial** — Find why two upserts run for one issue in one pass. — evidence: `worker/deno/lib/find_oldest_issue.ts` — reviewer: partial — reason: within one pass the scan already skips an issue it has reported, so the cause is several slots or hosts racing. That cause is recorded here and in a test comment, not in a code comment or a doc.
- **unrequested** — Pruning duplicate self-schedule-diagnostic announcements in `worker/deno/lib/collect_self_diagnostic_candidates.ts`, its tests, and the `docs/workflows/issue-processing.md` "Visible" row — reviewer: unrequested — reason: the announcement has the same find-then-post race as the held-gate comment, so the same shared helper is applied to it. This adds a new refusal (`announce-failed`) when a duplicate delete fails.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — KISS/DRY: a not-found check is written by hand instead of using the repo's classifier — evidence: `worker/deno/lib/marker_comment_pages.ts:229` — reason: not fixed in this diff (this retry is limited to the summary and the mutation test). The regex duplicates `classifyGitHubError` / `isDefinitiveNotFound`, which is left as a follow-up.
- **violation** — Docs updated for behaviour changes: the "if either fails" refusal wording did not mention a failed duplicate delete — evidence: `docs/workflows/issue-processing.md:324`, `worker/deno/lib/collect_self_diagnostic_candidates.ts:37-41` — reason: the doc row is fixed in this diff. The module doc comment in the `.ts` file still says "either" and is outstanding.
- **violation** — KISS: fewer moving parts — evidence: `worker/deno/lib/collect_self_diagnostic_candidates.ts:556` — reason: not fixed in this diff. `resolveAlertDedupAuthors` runs once per issue inside the loop, and the prune reads the thread a second time after `issueCommentsContainMarker`. Using the prune's kept-comment result for "already announced" would need only one read.
- **clean** — Australian English in added lines; JSDoc on the new export (`@param`/`@returns`/`@throws`) and updated module and upsert docs; errors are not swallowed (every delete is attempted and failures are gathered into one thrown error, which the caller logs and refuses on); only fleet-authored comments are deleted; tests cover the race, existing duplicates, strangers, 403/404, partial failure and an empty fleet list; the edited existing expectation is annotated; lint and fmt are clean.

<!-- vibe-branch-outcomes -->
