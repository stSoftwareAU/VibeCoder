## Summary

Worker paths that reuse an existing issue or PR now adopt only an artefact that
is **owned** (it carries this tool's marker or discriminator), **open** and
**fleet-authored**. A lookup that answers "is there something that makes filing
redundant?" no longer answers "may I write to it?" on its own. A shared helper,
`findOwnedOpenArtefact` in `worker/deno/lib/owned_open_artefact.ts`, now backs
the routed-issue search and recheck, the `--resolve-duplicate` and `--part`
paths, and the milestone fix-PR takeover. A cap test (`owned_reuse_cap_test.ts`)
fails any new module that reports a reuse without that lookup. Closes #3854.

## Spec

### Intent and Rationale

- The issue's recurring pattern is a reuse path that matched on a loose key (a
  title or a branch-name prefix) and then wrote to, closed or skipped work for
  an artefact it did not own or that was already closed. Two independent PRs
  (VibeCoder#3065 and VibeCoder#3853) hit it in three paths.
- The check cannot be a worker runtime gate: the worker cannot tell whether a
  lookup's result feeds a write. A source-text cap test, in the same style as
  `marker_dedup_author_manifest.ts`, is the feasible deterministic check.

### Essential Design Decisions

- The helper fails loud. A `gh` failure, invalid JSON, a row of the wrong shape
  or a page at its limit throws, rather than reading as "nothing to reuse",
  which would file a duplicate.
- An unresolved fleet author set discards every row, so the failure direction is
  toward filing, not reuse.
- `verifyOwnedOpenIssue` decides whether an existing issue may be reused or
  closed as a duplicate, and names the failed check in its verdict (state,
  marker, caller's `accept`, or author). A refusal therefore says which check
  failed.
- The cap test's manifests are shrink-only. `OWNED_REUSE_UNVERIFIED_FILES` is
  now empty, and `OWNED_REUSE_NOT_ARTEFACT_FILES` lists four modules that report
  a reuse outcome for something other than an issue or PR.
- The routed-issue lookup keeps its dedup meaning for `search`, and adds a
  second check for the write that follows it: `recheck` closes the new issue
  only for an owned, open, lower-numbered match.

### Undiscoverable Facts

- `ISSUE_LIST_LIMIT` is 200 and `PR_LIST_LIMIT` is 100. A listing that returns
  exactly its limit is refused, because matches beyond it would be missed.
- A `--part` reuse is checked with `requireReusablePart`, and the check applies
  only when the routed-issue step reports `reused` or `would-reuse`. A freshly
  created part is never re-checked.

## Evidence

This is a code change with its tests in `worker/deno/`. Changed surfaces:

- `worker/deno/lib/owned_open_artefact.ts` (new): the owned, open,
  fleet-authored lookup and the verify verdict.
- `worker/deno/lib/owned_reuse_manifest.ts` (new): the scanner and the
  shrink-only manifests.
- `worker/deno/lib/issue_routing_filing.ts`, `issue_routing_resolve.ts` and
  `issue_routing_split.ts`: the routed-issue search and recheck, the
  `--resolve-duplicate` verify, and the `--part` reuse check.
- `worker/deno/lib/milestone_fix_pr.ts`: `findOpenMilestoneFixPr` delegates to
  the shared lookup.
- `worker/deno/commands/route_issue.ts`: threads the fleet author options
  through.
- `worker/deno/lib/pr_ci_processor.ts` (lines 910-919): the gated-head
  milestone-fix lookup passes `fleetAuthors` from the configured fleet logins
  when they are set.
- `worker/deno/lib/github.ts` (option at 638, forwarding at 708):
  `createGitHubIssuesWithPartialFailures` takes `dedupAuthors` and passes it to
  the alert dedup as `authors`.
- `worker/deno/commands/suggest_improvements.ts` (option at 209, forwarding at
  267): the command takes `dedupAuthors` and passes it on to the github helper.

**Docs sweep** — grep: `--resolve-duplicate`, `--part`, `route-issue`; section:
`docs/ISSUE-ROUTING.md#retiring-a-wrong-repository-duplicate`,
`docs/ISSUE-ROUTING.md#splitting-work-across-codebases`; siblings: none — this
change adds no member to an existing set of documented surfaces; updated:
`docs/ISSUE-ROUTING.md`, `docs/MERGE.md`, `docs/workflows/merge-conflicts.md`.
The test support fake `worker/deno/tests/support/routing_fake_gh.ts` changed
too.

Issue numbers cited as provenance: #3065 (the milestone fix-PR takeover that
reused a PR it did not own) and #3853 (the `--resolve-duplicate` and `--part`
paths). Related rules checked: the `marker_dedup_author_manifest.ts` cap test,
which covers authorship but not ownership or state. It is unchanged and still
applies.

The sentence on this rule was not added to `CODING-STANDARDS.md`. The
shrink-only scanner `worker/deno/lib/owned_reuse_manifest.ts` and the cap test
`worker/deno/tests/owned_reuse_cap_test.ts` enforce the rule, so a prose copy
would only drift.

## Test Plan

- Added `worker/deno/tests/owned_open_artefact_test.ts` (22 tests),
  `worker/deno/tests/owned_reuse_cap_test.ts` (14 tests), and extended
  `issue_routing_filing_test.ts`, `route_issue_resolve_duplicate_test.ts`,
  `route_issue_split_test.ts` and `milestone_fix_pr_owned_test.ts`. All are
  green on the final head.
- Suggest test expectation: `worker/deno/tests/suggest_improvements_test.ts:771`,
  "suggest-improvements - a closed owned match is not reused, whatever the clock
  (Issue #3854)". Its Task 1 red check went red because the fake `gh` threw on
  a non-`open` state argument, not on the closed-match assertion the test name
  describes, so that red is not evidence for the check. It was not re-run for
  this summary.
- Red checks. Each one changes a single line or file, runs `deno task test:unit`
  on the covering test files, and restores with `git checkout`:
  - 2a1: a fake path added to `OWNED_REUSE_UNVERIFIED_FILES` and an entry
    removed from `OWNED_REUSE_NOT_ARTEFACT_FILES` → red
    (`FAILED | 12 passed | 2 failed`). Named: "every manifest entry names a file
    that exists", "the unverified list holds no file that was fixed".
  - 2a2: an entry removed from `OWNED_REUSE_NOT_ARTEFACT_FILES` → red. Named:
    "no new module reports a reuse without an owned lookup".
  - 2b: a temporary module with a bare `"reused"` literal → red
    (`FAILED | 13 passed | 1 failed`).
  - 2c1: the `OPEN` state check removed → red. Named: "a closed owned issue is
    not reused".
  - 2c2: the marker check removed → red. Named: "an issue missing the marker is
    not reused".
  - 2c3: the `selectFleetAuthoredMatches` call replaced by the unfiltered list →
    red (`FAILED | 19 passed | 3 failed`). Named: "a foreign-authored owned
    issue is not reused", "a prefix match by a foreign author is not reused",
    "an unresolved fleet set returns null and logs it".
  - 2c4: the `gh` catch returns `null` → red. Named: "a gh failure throws with
    repo, kind and stderr".
  - 2d: the verify-time refusal in `issue_routing_resolve.ts` disabled → red.
    Named: two `--resolve-duplicate` refusals, one for the author and one for
    the missing marker.
  - 2e: `requireReusablePart` returns early → red (four `--part` tests named).
  - 2f: the `findOwned` marker blanked → red (`FAILED | 20 passed | 1 failed`).
    Named: "an open same-titled issue with no owned marker is not reused, and is
    not closed".
  - 2g: `milestone_fix_pr.ts` reverted to the base commit → red. Named: three
    `findOpenMilestoneFixPr` tests (closed or merged, gh failure, empty fleet
    set).
  - B1: `milestone_fix_pr.ts:167` changed from `? {}` to `? { fleetAuthors: [] }`
    (the omitted-fleetAuthors arm) → red at
    `milestone_fix_pr_owned_test.ts:199:6` ("omitted fleetAuthors reads the
    configured identity, not an empty set"). Run with `deno test -A --no-check`
    on that file, stdin from `/dev/null`. Restored; `git diff` on the file is
    empty afterwards.
  - B2: `pr_ci_processor.ts` wiring reverted from the fleet spread to `{ gh: ghFn }`
    → red at `gated_head_passes_test.ts:168` (1 failing). Restored; `git diff`
    on the file is empty afterwards.
- Flips (one arm of the branch outcomes each; the facts file records the
  testName):
  - X1 (prefix check removed, `owned_open_artefact.ts:157`) → red. Named: "a
    discriminator narrows the match (Issue #3065)".
  - X2 (state check in `verifyOwnedOpenIssue` disabled) → red. Named: "verify
    refuses a closed issue and names the state".
  - X3 (`recheck` lower-number condition disabled) → red (three tests, including
    the concurrent-filer convergence test).
  - X4 (reuse branch in `fileRoutedIssue` disabled) → red
    (`FAILED | 18 passed | 3 failed`).
  - X5 (reuse gate in `requireReusablePart` disabled) → red
    (`FAILED | 14 passed | 4 failed`).
  - X6 (same-repository check replaced by `true`) → red
    (`FAILED | 29 passed | 2 failed`).
  - X7 (limit check disabled) → red (`FAILED | 20 passed | 2 failed`).
  - X10 (verify marker check disabled) → red (`FAILED | 65 passed | 3 failed`).
  - X11 (verify author gate disabled) → red (`FAILED | 65 passed | 3 failed`).
  - X12 (verify `accept` check disabled) → red
    (`FAILED | 66 passed | 2 failed`).
  - X8 (the open-state check at `issue_routing_resolve.ts:292`,
    `if (view.state !== "OPEN")`) → red at
    `route_issue_resolve_duplicate_test.ts:268` (the test declaration), with the
    failing assertion at `:275`. The earlier `view.state !== "OPEN"` arm at former
    line 351 was removed, not flipped, because `verifyOwnedOpenIssue` checks the
    state first, so that arm was unreachable.
  - Production spread at `github.ts:708` replaced by `{}` → red (2 failing) in
    `suggest_improvements_test.ts`, "an existing open issue with the same title
    is reused, not refiled (Issue #3745)".
  - Production spread at `suggest_improvements.ts:267` replaced by `{}` → red
    (1 failing) in `suggest_improvements_test.ts`, "the summary counts created,
    reused and would-be issues with the right plurals (Issue #3745)". The
    `:582` reuse test calls the github helper directly, so only the `:694`
    summary-count test reaches this arm.
  - X9a (`milestone_fix_pr.ts:165`, arm forced to `{}`) → red
    (`FAILED | 7 passed | 3 failed`). Named: "a fleet-authored owned open fix PR
    is returned", "a discriminator narrows the match", and "omitted fleetAuthors
    reads the configured identity, not an empty set".
  - X9b (`milestone_fix_pr.ts:165`, arm forced to `deps.fleetAuthors ?? []`) →
    red (`FAILED | 9 passed | 1 failed`). Named: "omitted fleetAuthors reads the
    configured identity, not an empty set". Both flips were restored, and
    `git diff` on `milestone_fix_pr.ts` is empty afterwards.

Quality gate: `./quality.sh < /dev/null` passed on the final head (every check
passed; `config integration` skipped, as it needs a live worker config).

Not checked: the `config integration` check, which `quality.sh` skips here.

## Follow-ups / out of scope

- `now?: () => Date` on the options at `worker/deno/lib/github.ts:636`,
  `worker/deno/commands/suggest_improvements.ts:207` and
  `worker/deno/lib/issue_routing_github.ts:23` is vestigial, because the
  closed-owner window it served was removed. Removing it is a separate change.
- The test "a same-titled owner issue closed within the window is not reused" in
  `worker/deno/tests/route_issue_resolve_duplicate_test.ts` still names the
  removed window. Renaming it is left for a follow-up.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
