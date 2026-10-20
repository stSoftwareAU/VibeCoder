## Summary

The route-closed hold comment and the `milestone-closed` gate `detail` printed a GitHub milestone number as a bare `#N`. GitHub autolinks `#N` only to issues, PRs and discussions, so milestone 7 pointed at the target repo's unrelated issue or PR #7. Both strings now name the milestone by title. The hold comment also links the title to `https://github.com/<repo>/milestone/<number>`. Closes #3673.

## Spec

### Intent and Rationale

- The comment is posted in the target repo. A bare `#N` there sends the reader to the wrong item and adds a cross-reference to that item's timeline. A title plus an explicit milestone URL names and links the right thing.

### Essential Design Decisions

- The title is untrusted, so the hold comment renders it through the existing `inertCodeSpan` helper (`worker/deno/lib/ci_human_gate_comment.ts`). A `#5` inside the title therefore cannot autolink either.
- `renderRouteClosedHoldComment` now takes the target `repo` so it can build the milestone URL. Its only production caller, `holdOrphanBoundPr`, passes its own `repo`.
- The `detail` string also feeds log lines and `verifyMergeLanded`'s detail, so it stays plain text: `milestone "<title>" is closed`, with no number and no URL.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change, with no UI files. Tests in `worker/deno/tests/milestone_children_gate_test.ts` cover it (see Test Plan).

- #3673: Route-closed hold comment and milestone-closed detail print a GitHub milestone number as a bare #N, which autolinks to an unrelated issue or PR
- #3501 (cited in an existing comment; title checked): Security tree sweep issue body cites non-existent VibeCoder Issue #4193, which autolinks to an unrelated issue in the swept repo

**Docs sweep** — grep: `renderRouteClosedHoldComment`, `holdOrphanBoundPr`, "milestone #", "its milestone", "Not merged into", "milestone-closed"; section: `docs/workflows/milestones.md` ("A closed route holds the PR."); siblings: none — no existing set gained a member; updated: the doc comment on `renderRouteClosedHoldComment`; `docs/workflows/milestones.md:662` — still true because it describes the hold (not merged, auto-merge disarmed, one comment) without quoting the wording.

## Test Plan

- `deno test -A worker/deno/tests/milestone_children_gate_test.ts` was run on the final head: 42 passed, 0 failed. `deno fmt`, `deno lint` and `deno check` reported nothing on both changed files.
- Edited `renderRouteClosedHoldComment - carries no bare #N apart from the rollup PR or milestone it names (Issue #3501)`. The call now passes `"o/r"`, and the closed-milestone case's expectation changed from `["#7"]` to `[]`, as the issue asks. No assertion was removed. Red check: against the base production file this test fails, because the base renderer prints `#7`.
- Added `decideMilestoneBaseMerge - a closed milestone's detail names it by title, not as #N (Issue #3673)`. It fails against the base production file, which renders `milestone #7 "Clean up" is closed`.
- Added `renderRouteClosedHoldComment - names a closed milestone by title and links its page, never as #N (Issue #3673)`. It covers four cases: linked, title-only, a hostile `Release #5` title, and no title. It fails against the base production file.
- Added `holdOrphanBoundPr - the posted hold comment links the closed milestone in the PR's own repo (Issue #3673)`. It is the call-site check: changing the caller to `renderRouteClosedHoldComment(gate, "")` turned it red, and it passed again once the caller was restored.
- Callers checked: `renderRouteClosedHoldComment` has one production caller, `holdOrphanBoundPr`. It passes `repo`, and `repo` is required, not defaulted.

<!-- vibe-branch-outcomes -->

**Not done / not checked:** `pr_auto_merge.ts:1361` also writes `milestone #${gate.milestoneNumber}`, but only to a local log line in the summary-PR gate. It is not posted to GitHub and is outside this issue's two named sites.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
