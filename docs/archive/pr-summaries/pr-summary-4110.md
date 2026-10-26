# Keep good issue rows when one row is malformed

## Summary

`parseIssueListJson` mapped every row with no guard on `author`, `assignees`,
`labels` or `milestone`, so one row with a `null` assignee or a string milestone
threw inside the `.map`, and the whole `gh issue list` result became `[]`. That
empty list was then cached as `issues_all`.

- Each row's `author`, `assignees`, `labels` and `milestone` is now checked. A
  malformed row is skipped and logged by issue number and field; every other row
  is kept.
- `fetchAllIssues` now counts the raw rows before parsing and throws when the
  root is not a JSON array, so a non-array response is a failed call and nothing
  is cached.

Closes #4110

## Spec

### Intent and Rationale

- One bad row must not hide every other issue from the scheduler, milestone and
  label views.
- A non-array root is a broken response, not "no issues", so it fails loud
  instead of caching an empty list.

### Essential Design Decisions

- Skip the row rather than default the bad field: a half-read row could be
  scheduled on wrong labels or milestone.
- Absent or `null` fields still default (`""`, `[]`) as before, so normal rows
  without a milestone are unchanged.
- The `issues_all` cache entry keeps its shape (`{limit, issues, rawCount}`), so
  the key is not bumped; no old-shape read is needed.

### Undiscoverable Facts

None.

## Evidence

Backend-only change; no UI. Tests in `worker/deno/tests/issue_query_test.ts`:

- `parseIssueListJson` keeps the good row beside a row with a `null` assignee,
  non-array labels, a non-string label name, a string milestone, a string
  author, or a milestone with a non-string title.
- `parseIssueListJson` logs each skipped row by number and field, logs nothing
  when every row is valid, and still defaults absent fields.
- `fetchAllIssues` rejects a non-array JSON root without caching, and keeps and
  caches the good row beside a malformed one.
- `fetchOpenIssuesByMilestone` and `fetchIssuesByLabel` keep the good row beside
  a malformed one.

Docs sweep: grep: `parseIssueListJson|GhIssueListItem`, `issues_all`,
`rawCount|countListRows` across README, `docs/`, `DESIGN-PRINCIPLES.md`, prompts
and source doc comments; section: `parseIssueListJson` doc comment updated in
`worker/deno/lib/issue_query.ts`; siblings: `fetchAllClosedIssues`,
`parsePRListJson` — no doc lists the parsed fields. Hits left in place:

- `DESIGN-PRINCIPLES.md:1064`, `DESIGN-PRINCIPLES.md:3174` — still true because
  they describe `issues_all` caching, not parsing.
- `docs/GH-API-OPTIMISATION.md:85`, `:235`, `:358`, `:361`, `:404` — still true
  because they describe cache keys and invalidation.
- `docs/INTERNALS.md:3175` — still true because it describes the cache entry,
  whose shape is unchanged.
- `docs/IDLE-TASK-FRAMEWORK.md:1413` — still true because it describes cache
  reuse.
- `docs/workflows/issue-processing.md:3483`, `:3503` — still true because they
  describe cache invalidation.
- `worker/deno/lib/issue_query.ts` doc comments on `assertListOutput`,
  `AllIssuesCacheEntry.rawCount` and `fetchAllIssues` — still true because the
  counting and empty-output checks they describe are unchanged.

Issues cited:

- #4110: parseIssueListJson returns an empty list when one issue row has a
  malformed assignees, labels, author or milestone
- #4106: milestone-health turns failed gh list calls into an empty successful
  report ('No active milestones', 'Complete — all issues closed')

## Reproduction

- Symptom: a `gh issue list` result where one row has `"assignees": [null]` (or
  a string milestone, or non-array labels) parsed to `[]`, and `fetchAllIssues`
  cached that empty list.
- Status: verified — the new tests failed against base `9046d94c` (9 failed;
  only the defaults and no-log controls passed there).
- Regression test: `worker/deno/tests/issue_query_test.ts` — "issue_query -
  parseIssueListJson keeps the good row when another row has a null assignee
  (Issue #4110)".

## Test Plan

- `deno task test:unit tests/issue_query_test.ts` from `worker/deno`: 110
  passed, 0 failed.
- Red on base: 9 of the 12 new tests failed against the base code; the defaults
  and no-log tests are positive controls and pass on base.
- Red checks, each run with only that change removed:
  - non-array root throw removed → the `fetchAllIssues` non-array test red;
  - assignees guard off → 4 red; labels guard off → 3 red; milestone guard off →
    1 red; author guard off → 1 red;
  - `log` call removed → the log test red;
  - non-string inner fallback changed to `""` → only the non-string milestone
    title test red;
  - absent-value default changed to `null` (both helpers) → the defaults test
    red;
  - unconditional log before the field checks → the no-log test red.
- No assertions removed or edited.
- Quality gate: `./quality.sh` passed (exit 0); config integration skipped.

Not done or not checked: config integration in the quality gate was skipped;
#4106 (milestone-health reporting a failed list as empty) is out of scope; the
pre-existing `catch` in `countListRows` (not changed here) is not exercised by a
test, because `assertListOutput` rejects invalid JSON before it runs.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
