## Summary

The idle-decision census and the idle-detect audit counted
`stSoftwareAU/GRQ-AutoTrader#2503` as claimable. The claim scan kept refusing
it as `dependency-blocked`, because the issue has 4 open native GitHub
sub-issues and `checkParentBlocked` refuses a parent with open children. The
census and the audit read only the body, so they did not see the sub-issues,
and the disagreement filed this idle-inversion issue.

Both readers now model native sub-issues. GitHub's `subIssuesSummary` field is
requested on the same `gh issue list` calls they already make (`fetchAllIssues`
and the audit's own call), so this adds no API call. The new
`parseSubIssuesSummary` validates the field, and the new `hasOpenSubIssues`
treats `total > completed` as `dependency-blocked` in both readers. An absent or
malformed field behaves exactly as before. The body task-list half of the
parent/child gate is still not modelled. Closes #3314.

**Docs sweep** — grep: `subIssuesSummary`, `hasOpenSubIssues`,
`parseSubIssuesSummary`, `normaliseIssue`, `checkParentBlocked`, "parent/child",
"Parent/child", "per-issue API call", "not modelled", "unmodelled",
`dependency_blocked`, `classifyIssues`, "idle-detect"; section:
`docs/IDLE-TASK-FRAMEWORK.md` (the census gate flowchart and "The **dependency**
gate" paragraphs); updated: `docs/IDLE-TASK-FRAMEWORK.md`. The paragraph that
called the parent/child gate "the one unmodelled rule" now says only its body
task-list half is unmodelled. The flowchart's `dependency_blocked` decision now
also lists "has open native sub-issues". Remaining hits are still true:
`docs/workflows/issue-processing.md:375` and `:673` and `docs/INTERNALS.md:3044`
describe the claim scan's `checkParentBlocked`, which this diff does not change.
`docs/workflows/projects-and-dependencies.md:63` describes the user-facing
parent/child rule, which is also unchanged. `docs/CUSTOM-PROMPTS.md:374` already
says an open sub-issue counts as a dependency.
`docs/audits/security-sweep-1218-commands-cli.md:112` is an audit record about
`checkParentBlocked`'s cross-reference handling, which this diff does not touch.

## Test Plan

- No assertion was removed from an existing test. The three test files only
  gain new tests: `worker/deno/tests/issue_query_test.ts`,
  `worker/deno/tests/idle_decision_census_test.ts` and
  `worker/deno/tests/idle_detect_diagnostics_test.ts`. Their diff has no
  removed lines.
- Added to `worker/deno/tests/issue_query_test.ts`: `parseIssueListJson` keeps a
  valid `subIssuesSummary` and drops `percentCompleted`. It drops a non-numeric,
  a `null` and a negative summary, and leaves the field absent when the raw
  field is absent.
- Added to `worker/deno/tests/idle_decision_census_test.ts`: open sub-issues
  mean `dependency-blocked`, not claimable. All sub-issues completed means
  claimable. An absent summary is claimable, as before. A time-deferred issue
  with open sub-issues counts as time-deferred. A `work-on` issue blocked only
  by sub-issues does not suppress the `low-priority` backlog.
- Added to `worker/deno/tests/idle_detect_diagnostics_test.ts`: `classifyIssues`
  excludes an issue with open sub-issues as `dependency_blocked`, without
  `openIssueNumbers` or `openMilestones`, and does not exclude one whose
  sub-issues are all completed. `normaliseIssue` keeps a valid summary and drops
  a malformed one.
- `deno test -A --no-check tests/issue_query_test.ts tests/idle_decision_census_test.ts tests/idle_detect_diagnostics_test.ts --filter "/3314|subIssuesSummary/"`
  from `worker/deno`: 14 passed, 0 failed.

**Branch outcomes:**

- `worker/deno/lib/issue_query.ts:241` — absent (raw field is not an object,
  e.g. `null` or missing) — `worker/deno/tests/issue_query_test.ts::issue_query - parseIssueListJson drops a null subIssuesSummary`
  — flipped to return `{ total: 1, completed: 0 }`, test went red (as did
  "leaves subIssuesSummary absent when the raw field is absent")
- `worker/deno/lib/issue_query.ts:243` — fail-closed default (non-numeric or
  negative counts) — `worker/deno/tests/issue_query_test.ts::issue_query - parseIssueListJson drops a non-numeric subIssuesSummary`
  and `worker/deno/tests/issue_query_test.ts::issue_query - parseIssueListJson drops a negative subIssuesSummary`
  — flipped to return a summary, both went red (as did
  `worker/deno/tests/idle_detect_diagnostics_test.ts::normaliseIssue - drops a malformed subIssuesSummary (Issue #3314)`)
- `worker/deno/lib/issue_query.ts:250` — success (valid counts kept) —
  `worker/deno/tests/issue_query_test.ts::issue_query - parseIssueListJson keeps a valid subIssuesSummary, dropping percentCompleted`
  — flipped to return `undefined`, test went red
- `worker/deno/lib/issue_query.ts:265` — absent summary means not blocked —
  `worker/deno/tests/idle_decision_census_test.ts::#3314 - an absent subIssuesSummary is claimable, as before`
  — flipped to `return true`, test went red
- `worker/deno/lib/issue_query.ts:266` — blocked (`total > completed`) —
  `worker/deno/tests/idle_decision_census_test.ts::#3314 - an issue with open native sub-issues is dependency-blocked, not claimable`
  — flipped to `return false`, test went red (as did the matching
  `classifyIssues` test)
- `worker/deno/lib/issue_query.ts:266` — not blocked (all sub-issues
  completed) — `worker/deno/tests/idle_decision_census_test.ts::#3314 - an issue whose sub-issues are all completed is claimable`
  — flipped to `>=`, test went red (as did
  `worker/deno/tests/idle_detect_diagnostics_test.ts::classifyIssues - an issue whose sub-issues are all completed is not excluded (Issue #3314)`)
- `worker/deno/lib/issue_query.ts:335` — success (parsed summary copied onto
  the issue) — `worker/deno/tests/issue_query_test.ts::issue_query - parseIssueListJson keeps a valid subIssuesSummary, dropping percentCompleted`
  — flipped to `if (false)`, test went red
- `worker/deno/lib/idle_detect_diagnostics.ts:311` — success (summary kept on
  the normalised issue) — `worker/deno/tests/idle_detect_diagnostics_test.ts::normaliseIssue - keeps a valid subIssuesSummary (Issue #3314)`
  — flipped to always spread `{}`, test went red
- `worker/deno/lib/idle_detect_diagnostics.ts:791` — blocked (audit excludes as
  `dependency_blocked`) — `worker/deno/tests/idle_detect_diagnostics_test.ts::classifyIssues - an issue with open native sub-issues is dependency_blocked, independent of openIssueNumbers/openMilestones (Issue #3314)`
  — flipped to `if (false)`, test went red
- `worker/deno/lib/idle_decision_census.ts:1099` — blocked (tier-3
  `censusVisibleRefusal` returns `dependency-blocked`, so the `work-on` issue
  does not suppress lower tiers) — `worker/deno/tests/idle_decision_census_test.ts::census - a work-on issue blocked only by open sub-issues does not suppress the backlog (Issue #3314)`
  — flipped to `if (false)`, test went red
- `worker/deno/lib/idle_decision_census.ts:1278` — blocked (claimable count
  records `dependency_blocked`) — `worker/deno/tests/idle_decision_census_test.ts::#3314 - an issue with open native sub-issues is dependency-blocked, not claimable`
  — flipped to `false ||`, test went red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
