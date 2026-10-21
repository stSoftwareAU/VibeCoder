## Summary

Worker paths that reuse an existing issue or PR, or write to one, now adopt only
an artefact that is **owned** (it carries this tool's marker or discriminator),
**open** and **fleet-authored**. The dedup that decides whether to file at all
is unchanged. A shared helper, `findOwnedOpenArtefact` in
`worker/deno/lib/owned_open_artefact.ts`, now picks the artefact for the
routed-issue reuse and recheck, the `--resolve-duplicate` and `--part` paths,
and the milestone fix-PR takeover. A cap test (`owned_reuse_cap_test.ts`) fails
a module that holds a quoted `"reused"` or `"*-reused"` literal that is not a
comparison operand, or a `reused: true` field, when the module calls none of
`findOwnedOpenArtefact`, `findOpenMilestoneFixPr` or `findOpenIssueByFindingId`
and is not in the manifest. Closes #3854.

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
- An unresolved fleet author set discards every row, so nothing is reused or
  written to. After a routing dedup hit the result is `suppressed`, and nothing
  is filed. The fix-PR lookup returns no PR, so the caller raises its own.
- `verifyOwnedOpenIssue` decides whether an existing issue may be reused or
  closed as a duplicate, and names the failed check in its verdict (state,
  marker, caller's `accept`, or author). A refusal therefore says which check
  failed.
- The cap test's manifests are shrink-only. `OWNED_REUSE_UNVERIFIED_FILES` is
  now empty, and `OWNED_REUSE_NOT_ARTEFACT_FILES` lists four exempt modules,
  each with the reason its `reused` string is not an artefact reuse.
- The routed-issue `search` step keeps its dedup meaning. `findRoutingDuplicates`
  (open, or closed in the last 30 days, issues and PRs, any author) still
  decides whether to file at all. It is restored unchanged from `main`, with
  its tests. Only after a dedup hit does `findOwnedOpenArtefact` look for an
  owned, open, fleet-authored issue with that title. When it finds one,
  `fileRoutedIssue` returns `reused` or `would-reuse`. Otherwise it returns a
  new action, `suppressed`, with the lowest-numbered dedup match and no write.
  On `main` such a match (closed, a PR, unmarked or foreign) was reported as
  `reused`. It is still not refiled, but it is no longer called a reuse.
- Each caller handles `suppressed` with no write. `--resolve-duplicate` refuses
  and leaves X open (`issue_routing_resolve.ts`). `--part` fails that part and
  leaves the match unedited (`issue_routing_split.ts`). `route-issue` create
  mode prints `route-issue suppressed: <repo>#<n>` and succeeds.
  `suggest-improvements` lists the action in `routed` and adds, for example,
  `; 1 improvement not filed, because a same-titled issue or PR exists that is
  not reused` to its summary.
- `recheck` closes the new issue only for an owned, open, fleet-authored,
  lower-numbered match. A racing copy that fails those checks does not close
  this one, so the new issue stays open beside it.

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
- `worker/deno/lib/issue_routing_filing.ts`: the `search` step runs the dedup,
  then the owned lookup after a hit, and returns `reused` or `suppressed`. The
  `recheck` step uses the owned lookup.
- `worker/deno/lib/issue_routing_resolve.ts` and `issue_routing_split.ts`:
  refuse a `suppressed` match, verify a reused one with `verifyOwnedOpenIssue`,
  and check a reused `--part` with `requireReusablePart`.
- `worker/deno/lib/issue_routing_github.ts`: no diff against `main`.
  `findRoutingDuplicates` is kept.
- `worker/deno/lib/milestone_fix_pr.ts`: `findOpenMilestoneFixPr` delegates to
  the shared lookup.
- `worker/deno/commands/route_issue.ts`: threads the fleet author options
  through.
- `worker/deno/lib/pr_ci_processor.ts` (lines 910-919): the gated-head
  milestone-fix lookup passes `fleetAuthors` from the configured fleet logins
  when they are set.
- `worker/deno/lib/github.ts` (option at 638, forwarding at 708):
  `createGitHubIssuesWithPartialFailures` takes `dedupAuthors` and passes it to
  `fileRoutedIssue` as `authors`.
- `worker/deno/commands/suggest_improvements.ts` (option at 209, forwarding at
  267, suppressed count at 285-291): the command takes `dedupAuthors`, passes
  it on to the github helper, and counts `suppressed` results in its summary.

**Docs sweep** — grep: `--resolve-duplicate`, `--part`, `route-issue`,
`findOpenMilestoneFixPr`, `stands down`; section:
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

- Removed from `worker/deno/tests/suggest_improvements_test.ts`: `assertEquals(routed?.action, "reused");`
  Required by: "a dedup hit may suppress a filing; only an owned, open match may be reused or written to"
  Replaced by: `assertEquals(routed?.action, "suppressed");`
- Restored from `main` with no diff: `worker/deno/lib/issue_routing_github.ts`
  and `worker/deno/tests/issue_routing_github_test.ts` (every
  `findRoutingDuplicates` assertion). These base expectations are restored
  verbatim:
  - the `dry-run` filing test's
    `assert(gh.calls.some((c) => c[0] === "search"));`;
  - the `--resolve-duplicate` test "with no --correct, a same-titled owner
    issue closed within the window is refused and X stays open";
  - the `--part` tests "an unrelated same-titled issue (…) is neither reused
    nor edited" and "a dry run flags an unrelated same-titled issue instead of
    planning to reuse it";
  - the exact WARNING count in `github_test.ts` "warns once per stripped
    reserved label". That test now passes
    `dedupAuthors: { fleetAuthors: [FLEET_LOGIN] }`, so it is hermetic.
- `suggest_improvements_test.ts` "the command's injected clock sets the
  duplicate-search window (Issue #3745)" keeps its number and store
  assertions. The action assertion is replaced (above), and two assertions are
  added: no comment on the match, and the summary's suppressed sentence.
- New tests:
  - `issue_routing_filing_test.ts`: "a same-titled match {closed within the
    window, by another author, with no owned marker, a pull request}
    suppresses the filing, is not reused and is not written to", each with
    dry-run false and true. "a suppressed filing logs the match it did not
    reuse, and the author check logs the foreign row" pins the log context
    `{ repo, duplicate }`.
  - `route_issue_resolve_duplicate_test.ts`: "an open same-titled owner issue
    {by another author, with no owned marker} is refused, not reused, and no
    fresh Y is filed".
  - `route_issue_split_test.ts`: the unrelated-issue loop also covers "open,
    carrying this tool's marker, by another author" and "a pull request
    carrying this tool's marker".
  - `route_issue_test.ts`: "under the injected clock a same-titled owned issue
    {that is open is reused, closed inside the window suppresses the filing},
    with no write (Issue #3854)".
  - `owned_open_artefact_test.ts` (23 tests): "verify with an unresolved fleet
    set refuses and logs the consequence". `owned_reuse_cap_test.ts` has 14
    tests.
- Mutation check. Each listed mutant was applied by deleting the line, and the
  named file went red (`deno test -A --no-check`, stdin from `/dev/null`). Each
  was restored with `cp`.
  - `route_issue.ts` `now: deps.now` → `FAILED | 56 passed | 1 failed`, in
    `route_issue_test.ts` "…closed inside the window suppresses the filing…".
  - `issue_routing_filing.ts` `search:` → `FAILED | 25 passed | 1 failed`. The
    reuse test asserts the lookup's `--search` value is
    `"<title>" in:title`.
  - `issue_routing_filing.ts` `log:` → `FAILED | 25 passed | 1 failed`, in "a
    suppressed filing logs the match it did not reuse…".
  - `issue_routing_resolve.ts` `log:` → `FAILED | 21 passed | 1 failed`. The
    verify-time probe asserts the foreign author is logged.
  - `milestone_fix_pr.ts` `kind: "pr"` → `FAILED | 44 passed | 1 failed`. The
    gh-failure test asserts `Owned pr lookup in <repo>`.
- Coverage carry-over: `milestone_sync_pr_budget_test.ts`'s fake again returns
  `prListRaw` for the sync-PR listing, which names `--head`. Only the fix-PR
  lookup, a `--base` listing with no `--head`, gets `[]`. So
  `milestone_sync_landing.ts:224-229` is reached again: lcov reports `DA:224,1`
  through `DA:229,1`. The `routing_fake_gh.ts` lines 152-154, 202-230 and
  331-332 (the `search` command) are reached again by the restored dedup.
- Flips. Each changes one line and goes red, and the file is restored with
  `cp`. The facts file records the testName for each.
  - `issue_routing_filing.ts:279` `duplicates.length > 0` → `false`:
    `FAILED | 15 passed | 11 failed`.
  - `issue_routing_filing.ts:286` `owned !== null` → `false`:
    `FAILED | 16 passed | 10 failed`.
  - `issue_routing_filing.ts:233` marker → `""`: `FAILED | 24 passed |
    2 failed` (the two "with no owned marker" cases).
  - `issue_routing_filing.ts:345` lower-number condition → `false`:
    `FAILED | 23 passed | 3 failed`.
  - `issue_routing_resolve.ts:328` suppressed refusal → `false`:
    `FAILED | 18 passed | 4 failed`. `:351` verify refusal → `false`:
    `FAILED | 19 passed | 3 failed`.
  - `issue_routing_split.ts:275` suppressed failure → `false`:
    `FAILED | 15 passed | 6 failed`. `:284` reuse gate → `false`:
    `FAILED | 15 passed | 6 failed`.
  - `suggest_improvements.ts:286` `suppressed > 0` → `false`:
    `FAILED | 34 passed | 1 failed`.
  - The previous round ran the flips on lines this round did not change, and
    their facts entries are unchanged: the cap manifest (2a1, 2a2, 2b), the
    owned lookup (2c1-2c4, X1, X6, X7), verify (X2, X10-X12),
    `milestone_fix_pr.ts` (2g, X9a, X9b, B1), `pr_ci_processor.ts` (B2), and
    the `github.ts:708` and `suggest_improvements.ts:267` spreads.
- Targeted run with type checking: `deno test -A` over the routing, suggest,
  github, owned, milestone fix-PR, sync budget, gated-head, takeover and cap
  test files → `ok | 398 passed | 0 failed | 1 ignored`. `deno lint` and
  `deno fmt --check` on `lib`, `commands` and `tests` are clean.

Quality gate: `./quality.sh < /dev/null` passed on code head `eb64ebf9`
(`Result: PASSED (with skipped checks)`, exit 0). The parallel and serial Deno
test runs, type check, lint and fmt all passed. `config integration` was
skipped because it needs a live worker config.

Not checked: the `config integration` check, which `quality.sh` skips here.

## Follow-ups / out of scope

- None. The `now` option is live again, because the restored dedup window uses
  it.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
