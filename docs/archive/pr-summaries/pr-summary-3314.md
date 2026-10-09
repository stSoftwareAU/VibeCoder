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

**Review follow-up (PR #3318):** three gaps in the original fix.

1. The two production lines that carry the fix — `fetchAllIssues`'s `--json`
   field list (the `ALL_ISSUES_FIELDS` constant at
   `worker/deno/lib/issue_query.ts:471`, used by the `fetchAllIssuesJson` call
   at `:553`) and the census input mapping
   `subIssuesSummary: i.subIssuesSummary`
   (`worker/deno/lib/run_core_production_deps.ts:5773`) — had no test that
   goes red if either is reverted. Added
   `worker/deno/tests/idle_census_sub_issues_wiring_3314_test.ts`, driving
   the real `createProductionRunCoreDeps` with a stub `gh` that mirrors the
   real CLI's contract (returns only the fields named in `--json`). Reverting
   either line now fails the test for the right reason: the audit reports
   `claimable=1` and the census shows `inversion_signal=true` for the
   GRQ-AutoTrader#2503-shaped fixture.
2. `classifyIssues`'s third production caller, `repoHasStartableWork` in
   `worker/deno/lib/repo_busy_for_idle_task.ts`, never requested or mapped
   `subIssuesSummary`, so the fleet-global existence gate still counted a
   sub-issue-blocked issue as startable while the audit/census called it
   blocked. Fixed by requesting `subIssuesSummary` in that caller's `--json`
   list (line ~489) and mapping it with `parseSubIssuesSummary` into the rows
   `classifyIssues` reads (line ~519). Test added to
   `worker/deno/tests/repo_busy_for_idle_task_test.ts`.
3. `fetchAllIssues` (`worker/deno/lib/issue_query.ts`) always asks `gh`
   for `subIssuesSummary` in its `--json` field list, but that field is only
   recognised by cli/cli
   v2.94.0+ (confirmed against `cli/cli`'s `api/query_builder.go` at v2.93.0
   vs v2.94.0 — `subIssuesSummary` is absent from `issueOnlyFields` in the
   former). `docs/SETUP.md`'s `sudo apt-get install -y gh` gives operators
   2.4.0 on Ubuntu 22.04, 2.23.0 on Debian 12 or 2.45.0 on Ubuntu 24.04
   (confirmed against `packages.ubuntu.com`/`packages.debian.org`) — all
   below the floor — so the host-run `diagnose-repo` command (documented in
   `docs/TROUBLESHOOTING.md`/`docs/USAGE.md`) crashed outright with
   `Unknown JSON field: "subIssuesSummary"`, and `diagnose-issue`'s
   milestone-occupancy and repo-availability checks silently degraded to
   "assume OK". `fetchAllIssues` now retries once without the field when
   `gh` rejects it with that exact message, restoring pre-#3314 behaviour on
   older `gh`. `repo_busy_for_idle_task.ts` and `idle_detect_diagnostics.ts`
   also request `subIssuesSummary`, but neither backs a documented host-run
   command (both run only inside the container, which pins gh 2.97.0), so
   they are unaffected by this host/apt-gh gap and are left as-is. Tests
   added to `worker/deno/tests/issue_query_test.ts`.
4. The 2.94.0 floor and the error message were confirmed against `cli/cli`
   source, but the field *shape* `parseSubIssuesSummary`/`hasOpenSubIssues`
   depend on (numeric `total`/`completed`) had no observed `gh` output. Run
   on the container's own pinned `gh` (2.97.0):
   `gh issue view 2503 -R stSoftwareAU/GRQ-AutoTrader --json number,state,subIssuesSummary`
   →
   `{"number":2503,"state":"OPEN","subIssuesSummary":{"completed":0,"percentCompleted":0,"total":4}}`.
   Matches what the code assumes.
5. `ALL_ISSUES_FIELDS` adds `subIssuesSummary` to the `FilterableIssue` rows
   cached under the unversioned `issues_all` key
   (`worker/deno/lib/issue_query.ts:471`, `:528`), so a row the previous
   release cached lacks the field for up to the cache's 600 s TTL after a
   deploy. **Choice: keep the key, read the old shape.** The field is
   optional on `FilterableIssue`/`CensusIssue` and both production readers
   (`hasOpenSubIssues`, called from the census and the audit) already treat
   an absent field as "not blocked" — the exact pre-#3314 reading, by
   design (see the `SIMPLE-ON-PURPOSE` comment on `hasOpenSubIssues`).
   Bumping the key (e.g. `issues_all_v2`) would touch every invalidation
   site (`issue_lifecycle.ts:130`, `issue_close_notifier.ts:72`,
   `pr_issue_linking.ts:1118`, `pr_maintenance.ts:2303`,
   `stuck_recovery.ts:829/945/1261`) for no behavioural gain, since the old
   shape is already handled correctly. Added
   `worker/deno/tests/issue_query_test.ts`'s
   `"a pre-#3314 issues_all entry (no subIssuesSummary field) is served, and
   the census/audit treat it as not sub-issue-blocked (Issue #3318)"`: seeds
   an old-shape `issues_all` entry (object with no `subIssuesSummary` key at
   all) via `IssueCache.write`, calls `fetchAllIssues` with a `gh` stub that
   throws if called, and asserts the entry is served unchanged and that both
   `classifyIssues` and `buildIdleDecisionCensus` count the row as claimable
   / not `dependency_blocked`.

**Docs sweep** — review follow-up (item 3): grep: `subIssuesSummary`,
`fetchAllIssues`, "apt-get install -y gh", "gh version", "2.94" over
`docs/SETUP.md`, `docs/DEPLOYMENT.md`, `docs/TROUBLESHOOTING.md`,
`docs/USAGE.md`; section:
`docs/TROUBLESHOOTING.md#-worker-not-picking-up-issues` and
`docs/USAGE.md` (both document the host-run `diagnose-repo` command the
retry keeps working on old `gh`): no hits describe a `gh` version floor or
`fetchAllIssues`'s field list, and neither section's description of
`diagnose-repo`'s behaviour or output changes, so there was no stale
sentence to fix. The retry is an internal fallback that restores pre-#3314
behaviour on old `gh` — it adds no new documented contract, so no doc update
is owed for it.

**Docs sweep** — original: grep: `subIssuesSummary`, `hasOpenSubIssues`,
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
- Review follow-up: added `worker/deno/tests/idle_census_sub_issues_wiring_3314_test.ts`
  (3 tests) driving the real `createProductionRunCoreDeps` — confirms
  `fetchAllIssues` requests `subIssuesSummary`, the audit does not count the
  fixture issue as claimable, and the census counts it `dependency_blocked=1`.
  Reverting either of the two production lines named above was shown to fail
  each test for the right reason (see Branch outcomes below), then the lines
  were restored.
- Review follow-up: added one test to
  `worker/deno/tests/repo_busy_for_idle_task_test.ts`
  (`anyRepoHasUnblockedRealWork - a work-on issue with open native
  sub-issues does not count (Issue #3314)`), asserting both the `false`
  verdict and that the `--json` request includes `subIssuesSummary`. Reverting
  the new mapping line in `repo_busy_for_idle_task.ts` was shown to fail it
  (`startable=1` instead of `0`), then the line was restored.
- `deno test -A --no-check tests/idle_census_sub_issues_wiring_3314_test.ts tests/repo_busy_for_idle_task_test.ts`
  from `worker/deno`: 28 passed, 0 failed.
- Review follow-up (item 3): added three tests to
  `worker/deno/tests/issue_query_test.ts`: a stub that rejects
  `subIssuesSummary` with gh's real `Unknown JSON field: "subIssuesSummary"`
  message (confirmed against cli/cli's `pkg/cmdutil/json_flags.go`) proves
  `fetchAllIssues` retries once without the field and still returns the
  listing; a stub that fails the retry too proves the retry's own error
  surfaces, not the original; a stub that rejects with an unrelated message
  proves a genuine failure is not retried. All three went red with the fix
  reverted (confirmed by disabling the `SUBISSUES_SUMMARY_UNSUPPORTED` branch
  and re-running), then the fix was restored.
- Review follow-up (item 5, persisted shape): added
  `worker/deno/tests/issue_query_test.ts`'s
  `"a pre-#3314 issues_all entry (no subIssuesSummary field) is served, and
  the census/audit treat it as not sub-issue-blocked (Issue #3318)"` — see
  Branch outcomes, `issue_query.ts:265`, for the red run.
- `deno task test:unit tests/issue_query_test.ts` from `worker/deno`:
  83 passed, 0 failed.

**Branch outcomes:**

- `worker/deno/lib/issue_query.ts` (the `SUBISSUES_SUMMARY_UNSUPPORTED.test(message)`
  branch in `fetchAllIssues`) — match, retry succeeds —
  `worker/deno/tests/issue_query_test.ts::issue_query - fetchAllIssues retries without subIssuesSummary when gh rejects it (Issue #3318)`
  — branch disabled, test went red (original "Unknown JSON field" error
  surfaced instead of the retried listing)
- same branch — match, retry also fails —
  `worker/deno/tests/issue_query_test.ts::issue_query - fetchAllIssues surfaces the retry's own error when the fallback also fails (Issue #3318)`
  — branch disabled, test went red (wrong error message surfaced)
- same branch — no match, genuine failure rethrown without a retry —
  `worker/deno/tests/issue_query_test.ts::issue_query - fetchAllIssues does not retry a genuine gh failure (Issue #3318)`
  — covered by the existing `#4257` empty/unparseable-output tests already
  rethrowing on the first call; the new test additionally counts calls to
  pin "no retry" for a non-matching message

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
  and (review follow-up, item 5) `worker/deno/tests/issue_query_test.ts::issue_query - a pre-#3314 issues_all entry (no subIssuesSummary field) is served, and the census/audit treat it as not sub-issue-blocked (Issue #3318)`
  — flipped to `return true`, both tests went red
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
- `worker/deno/lib/issue_query.ts:471` (the `ALL_ISSUES_FIELDS` constant
  `fetchAllIssues` passes to `fetchAllIssuesJson`) — `fetchAllIssues` requests
  `subIssuesSummary` — `worker/deno/tests/idle_census_sub_issues_wiring_3314_test.ts::production deps - fetchAllIssues requests subIssuesSummary in --json (Issue #3314)`
  and the audit/census tests in the same file — field dropped from the
  `--json` list, all three tests went red (`claimable=1`,
  `inversion_signal=true`)
- `worker/deno/lib/run_core_production_deps.ts:5773` — census input mapping
  carries `subIssuesSummary` — `worker/deno/tests/idle_census_sub_issues_wiring_3314_test.ts::production deps - the census counts the open-sub-issue parent as dependency_blocked (Issue #3314)`
  — mapping line removed, test went red (`dependency_blocked=0`,
  `inversion_signal=true`)
- `worker/deno/lib/repo_busy_for_idle_task.ts:519` — `repoHasStartableWork`
  maps `subIssuesSummary` into the rows `classifyIssues` reads —
  `worker/deno/tests/repo_busy_for_idle_task_test.ts::anyRepoHasUnblockedRealWork - a work-on issue with open native sub-issues does not count (Issue #3314)`
  — mapping line removed, test went red (`startable=1`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
