## Summary

The "Held by the fleet" comment (`<!-- vibe-held-issue-gate … -->`) and the self-schedule announcement (`VIBE_SELF_SCHEDULED:<family>`) could each be posted twice in the same second. The cause is a find-then-create with no re-check. Within one pass, `findOldestIssue` reports each blocked issue at most once (the `reported` set in `worker/deno/lib/find_oldest_issue.ts`). But several slots and hosts scan the same repository at once, so two of them could read the thread, find no fleet marker, and both POST. A new shared helper, `pruneDuplicateFleetMarkerComments`, keeps the oldest fleet-authored marker comment and deletes the newer fleet duplicates. Both writers call it before deciding and again after posting, so two racing runs converge on one comment. The held-gate recheck cache key is bumped to `held_issue_gate_v2_<n>`, so an issue that already carries duplicates is re-read and pruned on the next pass instead of being skipped for 24 hours. Closes #3597.

## Spec

### Intent and Rationale

- No lock spans hosts, so the fix makes the race harmless rather than impossible: every writer prunes after its own POST, and the oldest comment always wins, so the runs agree on which one to keep.
- The issue's triage comment reported the same double post for `VIBE_SELF_SCHEDULED:run-failure` on #3694 and asked for the self-scheduling path to be checked too. That path had the same find-then-post race and now uses the same helper.

### Essential Design Decisions

- Only fleet-authored comments (`isFleetAuthor`) are kept or deleted. An empty fleet list reads nothing, keeps nothing and deletes nothing, so an unresolved fleet posts rather than deleting or editing a comment it cannot attribute.
- A DELETE that GitHub answers as not found (`isDefinitiveNotFound`) counts as already deleted, because a racing run may have removed the comment first. Any other failure is thrown after every delete has been attempted. The held-gate upsert then fails loud, and the self-schedule path refuses that scan's schedule as `announce-failed`.
- Persisted data: the recheck cache entry keeps its shape, but a v1 entry was confirmed without a prune. So the key is **bumped** (`held_issue_gate_` → `held_issue_gate_v2_`) rather than read in the old form, and an old entry is ignored once.
- The upsert now edits the **oldest** fleet marker instead of the newest, so the comment it edits is the one the prune keeps.

### Undiscoverable Facts

- `gh` reports an already-removed comment as `gh: Not Found (HTTP 404)`, which `isDefinitiveNotFound` recognises.

## Evidence

Backend-only change; verified by the tests below and the full quality gate.

- Fake/production pairing: the tests' `fakeThread` and `makeThreadGh` stubs stand in for `gh api repos/<repo>/issues/<n>/comments --paginate --jq …` (read by `fetchMarkerComments`) and `gh api -X DELETE repos/<repo>/issues/comments/<id>` (`deleteIssueComment`). The property the change relies on is that a read returns comments oldest first (GitHub's default `created` ascending order for issue comments), so "first fleet row" is the oldest.
- Issue numbers this diff cites as provenance: #3597: Held-gate comment is posted twice in the same second.

**Docs sweep** — grep: `vibe-held-issue-gate`, `held_issue_gate_`, `upsertHeldIssueGateComment`, `pruneDuplicateFleetMarkerComments`, `issueCommentsContainMarker`, `self-schedule-diagnostic`, "edited in place", "newest fleet", "If either fails", "posted once"; section: `docs/INTERNALS.md` (held-issue gate comment bullets "One comment, edited in place" and "Bounded reads"), `docs/workflows/issue-processing.md` ("Visible" row of the self-scheduled diagnostics table); siblings: `fetchMarkerComments`, `deleteIssueComment`, `updateIssueComment` (the exports of `marker_comment_pages.ts` that the new helper joins); updated: `docs/INTERNALS.md`, `docs/workflows/issue-processing.md`, `docs/audits/security-sweep-2496-chain-root-comment.md` ("several fleet markers on one thread" row); `docs/TROUBLESHOOTING.md` "one *Held by the fleet* comment … edited in place when the gate moves" — still true because the thread now converges on one comment; `docs/audits/security-sweep-2758-top-up-delta.md` bullet on `fetchMarkerComments` — still true because the prune reads through `fetchMarkerComments` and filters by `isFleetAuthor`; the other "posted once" hits (`docs/INTERNALS.md:4387`, `docs/workflows/issue-processing.md:1065`, `:1866`, `:1914`) describe unrelated comments.

## Reproduction

- **symptom** — two identical "Held by the fleet" comments posted in the same second on one issue (#3535, #3536, #3538, #3717), and two identical `VIBE_SELF_SCHEDULED:run-failure` comments on #3694
- **status** — `verified` — with the base branch's `held_issue_gate_comment.ts` and `marker_comment_pages.ts` restored, the regression tests failed (6 failed, 24 passed in `held_issue_gate_comment_test.ts`); at the head they pass
- **regression test** — `worker/deno/tests/held_issue_gate_comment_test.ts::upsertHeldIssueGateComment - two concurrent upserts for the same issue and key leave exactly one held-gate comment`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Two upserts for the same issue and key, in one pass or concurrently, leave exactly one held-gate comment. — evidence: `worker/deno/tests/held_issue_gate_comment_test.ts::upsertHeldIssueGateComment - two concurrent upserts for the same issue and key leave exactly one held-gate comment` — reviewer: met
- **met** — An issue that already carries duplicates is reduced to one on the next pass. — evidence: `worker/deno/tests/held_issue_gate_comment_test.ts::upsertHeldIssueGateComment - an issue already carrying duplicate fleet held-gate comments is reduced to the oldest`, `worker/deno/tests/held_issue_gate_comment_test.ts::reportHeldIssueGate - a warm pre-#3597 cache entry does not hide existing duplicates (Issue #3597)` — reviewer: met
- **unrequested** — The self-schedule announcement in `collectSelfDiagnosticCandidates` is pruned to the oldest fleet-authored comment before and after posting, fleet authors are resolved once per scan, and a failed prune refuses the schedule — reviewer: unrequested — reason: the issue's triage comment reports the same double post for `VIBE_SELF_SCHEDULED:run-failure` on #3694 and asks for this path to be checked too; the reviewer judged it traceable on that basis
- **unrequested** — Doc updates in `docs/INTERNALS.md`, `docs/workflows/issue-processing.md` and `docs/audits/security-sweep-2496-chain-root-comment.md` — reviewer: unrequested — reason: they keep the documented behaviour true for the changed code

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — A negative test must be able to fail: the stranger-only self-schedule test stayed green with the fleet filter removed — evidence: `worker/deno/tests/collect_self_diagnostic_candidates_test.ts:629` — reason: fixed in this diff — it now asserts the thread is `[50, 1000]` and no DELETE is issued, and goes red with the filter removed
- **violation** — Removed assertion with no quoted issue requirement: `assertEquals(patch[3], "repos/owner/repo-a/issues/comments/22");` — evidence: `worker/deno/tests/held_issue_gate_comment_test.ts:431` — reason: fixed in this diff — the Test Plan now quotes the issue body sentence that requires keeping the oldest
- **clean** — Australian English; fail loud (every delete attempted before one aggregated throw; not-found classified through `isDefinitiveNotFound`; the self-schedule path refuses on a failed prune); persisted data (key bumped, old-shape seed test); remove only what you can prove you added (deletes limited to fleet-authored comments carrying this path's marker); named tests exist; nothing exists only for a test; concurrency tests use `Promise.all` with no sleep; temp dirs from `Deno.makeTempDir`. Optional notes not chased: the INTERNALS sentence on deleting duplicates applies when the thread is read, which a confirmed gate skips for 24 hours.

## Test Plan

- Added `worker/deno/tests/marker_comment_pages_prune_test.ts`: keeps the oldest fleet comment and deletes later fleet duplicates; never deletes a non-fleet comment; returns null and deletes nothing when no fleet comment carries the marker; an empty fleet list reads, keeps and deletes nothing; a not-found DELETE counts as already deleted; a 403 DELETE throws and names every failed comment; a partial failure names only the failed comment.
- Added to `worker/deno/tests/held_issue_gate_comment_test.ts`: "two concurrent upserts for the same issue and key leave exactly one held-gate comment"; "an issue already carrying duplicate fleet held-gate comments is reduced to the oldest"; "a stranger's held-gate marker is never deleted"; "a failed duplicate delete fails loud"; "an empty fleet-author list deletes nothing"; "reportHeldIssueGate - a warm pre-#3597 cache entry does not hide existing duplicates (Issue #3597)". The last seeds the old `held_issue_gate_7` entry; restoring the v1 key turned it red (outcome `cached`, not `unchanged`).
- Added to `worker/deno/tests/collect_self_diagnostic_candidates_test.ts`: duplicate announcements reduced to the oldest; a racing announcement leaves exactly one (red with the post-post prune removed); a stranger's marker is never deleted (red with the fleet filter removed); a stranger's marker between two fleet comments is never deleted; a 403 on the duplicate delete refuses the schedule; fleet authors are resolved once per scan (red when resolved per issue); an unresolved fleet posts the announcement and deletes nothing; a failed prune after the post refuses the schedule (red with that catch's `continue` removed).
- Edited existing tests in `worker/deno/tests/collect_self_diagnostic_candidates_test.ts`: "the announcement is posted once, not once per scan" and "an announcement marker planted by an outsider does not suppress the announcement (Issue #1216)" now build their thread with `makeThreadGh` instead of `makeGh`, because the read now goes through the `--jq` projection; no assertion was removed. Red check: forcing `announced` to false turned "posted once" red.
- Edited existing test `worker/deno/tests/held_issue_gate_comment_test.ts`: "edits the newest fleet marker when several exist" is now "edits the oldest fleet marker and deletes newer duplicates".
  - Removed: `assertEquals(patch[3], "repos/owner/repo-a/issues/comments/22");` — the issue body says: "Self-heal by deleting any extra held-gate comment with the same `key` that this account authored, keeping the oldest." So the PATCH now targets comment 11 (the oldest), and comment 22 is asserted as the one DELETE target. Red check: with the base production code the edited test fails (it edits 22).
- `deno test -A` on `tests/held_issue_gate_comment_test.ts`, `tests/marker_comment_pages_prune_test.ts`, `tests/collect_self_diagnostic_candidates_test.ts`, `tests/find_oldest_issue_gate_comment_test.ts`, `tests/find_oldest_issue_self_diagnostic_test.ts`, `tests/issue_priority_self_diagnostic_test.ts`, `tests/marker_dedup_author_cap_test.ts`: all passed.
- `./quality.sh < /dev/null`: Result: PASSED (with skipped checks — config integration skipped).

<!-- vibe-branch-outcomes -->
