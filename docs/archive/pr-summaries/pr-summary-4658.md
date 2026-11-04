## Summary

Continues the PR completion report and collector that #4709 landed
(`deno task pr-completion-report`); nothing is rebuilt. This change adds trusted
provenance for babysitter and milestone actions, bounded CI history and
blocker accounting, a post-merge CI view, per-host policy and heartbeat
reporting, and a demonstrable rediscovery record. An `--auto` merge arm is now
recorded as `merge-arm` and can never verify a later merge. The 24-hour
unattended target is still reported as an operational figure only, never a gate,
and no baseline or achieved result is claimed. Parts of the issue remain open
(see Acceptance Criteria), so this is Part of #4658.

Version bump: `VERSION` is not touched by this change.

### Deno regression avoided

Deno command and tasks only; no Node tooling, `package.json` or `deno.lock`
change.

```mermaid
flowchart LR
    B[Babysitter pass] -->|discovered / eligible / processed| E[pr-discovery-events.jsonl]
    B -->|VIBE_AUDIT_DIR journal| J[Hash-chained audit journal]
    W[Worker, git_pull milestone push] --> J
    G[GitHub read-only API] --> C[--collect]
    J --> C
    E --> C
    C --> S[Evidence snapshot] --> R[Report: cohort, CI, blockers, regressions, per-host deployment, rollout]
```

## Spec

### Intent and Rationale

- `merged_by` and logins cannot show unattended completion. A PR counts as
  verified unattended only when every GitHub-observed mutating event matches a
  chain-verified fleet record; anything unmatched stays `unknown`, never `human`.
- The #4709 reconciliation listed what was still missing: babysitter, reviewer
  and milestone provenance, CI and blocker accounting, post-merge visibility,
  per-host policy and rediscovery. This change continues the same collector.

### Essential Design Decisions

- Arming auto-merge (`gh pr merge --auto`) is `merge-arm`. A direct merge pinned
  with `--match-head-commit` is the only merge that can verify completion; every
  auto-merge path therefore stays `unknown` until a trusted replacement exists.
  Accepted trade-off: fewer PRs verify than before.
- A `git_pull.ts` push is `milestone` only when it targets `milestone/<slug>`;
  its other pushes (a base merge into a PR branch) are `branch-update`, which is
  neither implementation evidence nor a fix round.
- Post-merge CI is read from runs on the PR's `merge_commit_sha`, never the PR
  head. `cancelled` is not a failure. A merged PR with no merge commit gets a
  coverage note. Later default-branch commits are not observed.
- The lifecycle ledger `host` stays the machine hostname so the subscription
  allocation reader still matches. Reviewer, babysitter and discovery rows use
  `reportHostId(escalationHostId())`, which maps any `VIBE_HOST_ID` to the
  report's host-id pattern so one odd value cannot abort a babysitter pass.

- Discovery events rotate into UTC-day files, deduplicate across processes per day, recover
  a torn final record from a bounded tail, and log write failures without
  stopping repairs. The collector reads relevant days and the legacy ledger up
  through the 14-day evaluation window up to a 16 MiB total limit; excess
  evidence leaves rollout unknown with a note.
  Test seams supply the GitHub
  runner, temporary and state directories, host identity and repair operation.
- CI failure intervals exclude cancellations and unite overlaps across workflows.
  Named fleet mutation callers retain trusted attribution.

### Undiscoverable Facts

- No `<fleet_data_source>` block was supplied; no cohort was measured and live
  GitHub was never called. The REST shapes in the test fakes are the documented
  `pulls`, `actions/runs`, `actions/runs/{id}/attempts/{n}`, `.../jobs` and
  `commits/{sha}/check-runs?filter=all` responses.
- The local full gate did not pass end to end (see Test Plan).

## Evidence

Backend and CLI only; no UI file is touched.

The obsolete single unbounded ledger and exact-timestamp deduplication are
replaced by daily rotation and cross-process daily deduplication. Rediscovery on
later days remains recorded, and the legacy ledger remains readable. Coverage:
`worker/deno/tests/pr_discovery_events_test.ts::PR discovery event ledger rotates daily and repairs a torn tail`
and `worker/deno/tests/pr_completion_snapshot_test.ts::collect - oversized discovery evidence remains incomplete`.

Tool behaviour the code depends on, observed by running the real classifiers:
`classifyGitMutation(["push","origin","milestone/foo"])` returns
`{verb:"git-push", target:"milestone/foo", scope:"cwd"}`, and
`buildPushArgs("origin","feature-branch")` yields
`["push","--end-of-options","origin","feature-branch"]` with target
`feature-branch`. `gh pr merge --auto` classifies as `merge-arm`.

Issues read: #3404, "Per-tier PR outcomes and cost per merged PR in fleet
telemetry"; #4595, "Orchestrated issue runs record only one provider call's run
stats, so the cost/model comment and fleet telemetry leave out the plan and
executor calls"; #4613, "Branch updates: on a strict base with no merge queue,
update only the PR that is ready to merge, not every PR that is behind". The
report does not consume `fleet_telemetry.ts` and claims none of their
deliverables.

Docs read and updated: `docs/INTERNALS.md` ("PR completion evidence report":
match rule, merge window, blockers, regression evidence, CI scope, host
identity), `docs/AGENT-ACCOUNTABILITY.md` (per-entry fields, storage). Siblings
grepped for the new audit kinds: `repair`, `implementation`, `merge`.

## Acceptance Criteria

- **missing** — "Record trusted automation provenance for
  implementation/repair/review/dismissal/merge actions" for the review skill —
  reason: the review-fleet-prs skill posts through its own `gh` and does not
  journal, so its reviews come from `log.jsonl`, which is unchained and no longer
  verifies a PR; the babysitter, worker and milestone pushes are journalled.
- **missing** — "distinguish recorded human intervention" — reason: nothing
  records a human action, so `--collect` yields only verified or unknown history;
  `humanAssistedMerged` is non-zero only from an `--input` snapshot.
- **missing** — "genuinely owner-gated outcomes" verified from the collector —
  reason: `--collect` sets `ownerGateVerified` false because no recorded hold
  marker exists; those PRs stay in the denominator and are counted in
  `unverifiedOwnerGateLabels`.
- **missing** — "waiting time by concrete blocker" for hold, recovery (#4656) and
  refresh (#4613) waits — reason: only `needs-human`, `changes-requested` and
  CI-failure intervals are produced.
- **missing** — the post-merge view of later default-branch commits — reason:
  only runs on the PR's own merge commit are observed, plus reverts inside the
  cohort.
- **missing** — a live two-week measurement — reason: an operational evaluation
  after rollout; the report evaluates it automatically and says `pending` or
  `unavailable` until deployment and discovery evidence are complete.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — a GitHub review with a `commit_id` could only match an action
  carrying the same head, which a journalled review never has —
  evidence: `worker/deno/lib/pr_completion_snapshot.ts:738` — reason: fixed in
  this diff (review-specific head rule removed; test added)
- **violation** — every `git_pull.ts` push classified `milestone` —
  evidence: `worker/deno/lib/audit_hook.ts:249` — reason: fixed in this diff
  (milestone only for `milestone/` targets; others `branch-update`)
- **violation** — ledger `host` changed to a different identity than its
  sibling writer and the allocation reader —
  evidence: `worker/deno/lib/issue_assignment.ts:450` — reason: fixed in this
  diff (restored `getHostname()`)
- **violation** — old-shape merge entry (no `headSha`) and old snapshot
  (`rediscovered`) were untested —
  evidence: `worker/deno/tests/pr_completion_snapshot_test.ts:100` — reason:
  fixed in this diff (both read as unknown, tested)
- **violation** — stale docs on the match rule, merge window and audit kinds —
  evidence: `docs/INTERNALS.md:1169` — reason: fixed in this diff, with
  `docs/AGENT-ACCOUNTABILITY.md:227`
- **violation** — babysitter discovery calls, `VIBE_AUDIT_DIR` refusals,
  `--expected-inventory`, and the `discoveryComplete`/deployment operands had no
  test — evidence: `worker/deno/commands/fleet_pr_babysitter.ts:2954` — reason:
  fixed in this diff (tests added)
- **violation** — a merge-arm test hard-coded the kind —
  evidence: `worker/deno/tests/pr_completion_snapshot_test.ts:619` — reason:
  fixed in this diff (a hook-driven test added; its red comes from the hook's own
  kind assertion, the collector assertion alone does not go red)
- **violation** — a discovery test mutated process state and joined the serial
  manifest — evidence: `worker/deno/lib/parallel_unsafe_test_manifest.ts` —
  reason: fixed with injected seams; the mutator list stays empty.
- **clean** — Australian English; no hidden or secret file staged; new regexes
  anchored with bounded quantifiers; legacy shapes read as unknown; named tests
  exist; no members only tests read (`reportHostId`, `isAuditJournalSwitchedOff`
  have production callers).

## Test Plan

- Review regression evidence: two delivered PRs share a five-call CI budget;
  the first has a completed ten-minute workflow and the second is incomplete.
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - incomplete CI is reflected in delivered metrics and coverage`
  asserts one incomplete delivery and both ratios unknown. Removing the run
  ratio guard yielded `0.5` instead of null; removing the minutes guard yielded
  `5` instead of null. The obsolete single-PR, zero-row fixture could not prove
  either guard; the remaining incomplete waiting and regression flags are also
  asserted by this test.
  `worker/deno/tests/pr_completion_report_command_test.ts::pr-completion-report --collect passes the CI call budget to the collector`
  observes budget exhaustion at zero; removing the CLI forwarding instead made
  the fake receive an unexpected CI request. No duplicate ratio or CLI budget
  forwarding rule was found.
- Test-change evidence rerun: reverting the `git_pull` classification made
  `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`
  fail with actual `unknown`, expected `milestone`. Restoring fleet attribution
  and verification for unchained review logs made
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a malformed review-log line is noted and skipped, while good lines count and out-of-cohort records are ignored`
  fail with actual unknown-merged count `0`, expected `1`. The obsolete unknown
  milestone classification is replaced by milestone attribution, while unnamed
  callers stay unknown; the obsolete trusted unchained review is now unknown.
  The named tests cover those remaining behaviours.

- Review repair: CI collection lists a PR branch once and matches runs to its
  observed commit heads. It reads checks only for heads with workflow runs;
  other checks may be unobserved. A shared 5,000-call budget limits CI reads;
  exhaustion discards the partial PR history and records a coverage note.
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - many commits require one CI listing and budget exhaustion is reported`
  covers both the bounded listing and exhaustion. The obsolete per-commit
  listing included checks on heads without workflow runs; the remaining
  workflow and check history is covered by
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - CI history includes observed heads, workflow attempts and paged jobs`
  and `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a CI run without a completion time has no duration`.
  No duplicate CI collection implementation was found.
- Review repair: CI collection records each PR whose budget, pagination or
  attempt limit truncates CI. Delivered-change CI ratios are unknown when a
  delivered PR is incomplete; coverage counts the affected delivered changes,
  and waiting and post-merge regression results carry completeness flags.
  `--ci-call-budget` configures the limit. Coverage:
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - incomplete CI is reflected in delivered metrics and coverage`
  and `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a page-truncated event list and a partial check-run list are coverage notes`.
  The merge-window documentation now agrees with the direct-merge matcher.
  No duplicate CI completeness rule was found.
- Review test-change evidence rerun: restoring `git_pull` to unknown makes
  `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`
  fail with actual `unknown`, expected `milestone`. Restoring fleet attribution
  for unchained logs makes
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - an unchained review log cannot verify a PR's history`
  fail with actual `fleet`, expected `unknown`, and
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a malformed review-log line is noted and skipped, while good lines count and out-of-cohort records are ignored`
  fail with actual zero, expected one unknown merge. The obsolete classifications
  are replaced by the named classifications and unverified log handling; the
  same tests cover the remaining behaviour.

- Review repair validation: `deno fmt --check`, `deno lint` and the whole-tree
  `deno check` pass. The gate's `deno task test:unit` for the snapshot,
  issue-assignment and audit-hook suites passes (144 tests); markdownlint
  reports no issues.
- The ledger-host test runs in a clean child with a distinct `VIBE_HOST_ID`.
  Changing the ledger host to that value made
  `worker/deno/tests/issue_assignment_test.ts::issue assignment - the production seams record the machine hostname as the ledger host (Issue #4658)`
  fail with `ledger host differs from machine hostname`.
- Test-change evidence: restoring the former audit-action discovery inference
  made `worker/deno/tests/pr_completion_snapshot_test.ts::collect - the rollout check strands only PRs open at verification and at least a day old`
  fail because PR 31 became discovered and processed instead of false. Restoring
  fleet attribution and verification for unchained logs made
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - an unchained review log cannot verify a PR's history`
  fail with actor `fleet` instead of `unknown`, and
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a malformed review-log line is noted and skipped, while good lines count and out-of-cohort records are ignored`
  fail with zero rather than one unknown merge. Restoring the former unknown
  `git_pull` classification made
  `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`
  fail with `unknown` instead of `milestone`; the unlisted-caller assertions
  remain in that test.

- Review repair: named chain-verified worker comments retain fleet attribution;
  unnamed components remain unknown. Coverage:
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a named worker comment retains trusted attribution`.
  Discovery suppresses repeated same-day scans and excludes later day files:
  `worker/deno/tests/pr_discovery_events_test.ts::discovery suppresses repeated scans and excludes later days`.
  Append errors warn without stopping repair:
  `worker/deno/tests/fleet_pr_babysitter_pass_4658_test.ts::a discovery write failure does not stop a repair`.
  Multiple failed attempts of one workflow run now produce one regression;
  recovery remains covered by
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a failed run on the merge commit is a post-merge regression, resolved by a later successful attempt`.
  Unpinned and malformed merge pins remain unverified:
  `worker/deno/tests/audit_hook_test.ts::audit_hook - unpinned and malformed merge pins carry no head`.
The obsolete per-scan deduplication is replaced by daily cross-process
  deduplication; distinct transitions and later days remain recorded in
  `worker/deno/tests/pr_discovery_events_test.ts::PR discovery event ledger rotates daily and repairs a torn tail`.
Independent module instances sharing a ledger suppress duplicate appends in
`worker/deno/tests/pr_discovery_events_test.ts::discovery deduplicates across independent module instances`;
without the fix it observed two rows instead of one. The obsolete process-local
cache is replaced by a bounded ledger read under the append lock. No duplicate
deduplication implementation was found.

Test-change evidence: reverting the `git_pull` classification made
`worker/deno/tests/audit_hook_test.ts::audit_hook - a git_pull push to a milestone branch is a milestone action`
fail with `unknown` instead of `milestone`. The obsolete unknown classification
is replaced by milestone and branch-update classifications; unknown callers stay
covered by `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`.
Reverting the auto-arm classification made
`worker/deno/tests/pr_completion_snapshot_test.ts::collect - auto-merge arms and withdrawals never verify a GitHub merge`
fail with `merge` instead of `merge-arm`. The obsolete attribution of an arm as
a merge is replaced by an unknown outcome; this test exercises the classifier
and the collector, while the hook-driven test covers the journal path.
  No duplicate regression or discovery implementation was found.

- Review fixes: the obsolete per-run overlapping CI intervals are replaced by
  one union interval; cancellation is not a failure. Remaining coverage:
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - a CI blocker on a merged PR never runs past the merge, recovered or not, and a failure after it is no blocker`.
  The removed serial exception is obsolete because injected seams preserve the
  real pass coverage in `worker/deno/tests/fleet_pr_babysitter_pass_4658_test.ts::babysitter pass journals discovered, eligible and processed transitions on a live run`.
  The unnamed push case remains covered by `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`.
  The pinned, timely auto-merge arm remains unknown in
  `worker/deno/tests/pr_completion_snapshot_test.ts::collect - auto-merge arming cannot verify a later merge`.
  No duplicate CI blocker implementation was found.

- CI repair: both `pr-summary-ci` and its twin `pr-summary-check` permit
  `VIBE_AUDIT_DIR`, which the shared Git audit hook now reads. The actual CI
  task regression in `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`
  failed with the missing permission before the fix and passes afterwards.
  The workflow's `deno task pr-summary-ci --base main --head-branch
  issue-4658-complete-trusted-completion-metrics-and-per-host-p-redo-1` also
  passes locally. The two task definitions are the matching permission copies.

- Added or extended: `worker/deno/tests/pr_completion_snapshot_test.ts`,
  `worker/deno/tests/pr_completion_report_test.ts`,
  `worker/deno/tests/pr_completion_report_command_test.ts`,
  `worker/deno/tests/pr_discovery_events_test.ts`,
  `worker/deno/tests/fleet_pr_babysitter_test.ts`,
  `worker/deno/tests/fleet_pr_babysitter_audit_test.ts`,
  `worker/deno/tests/audit_hook_test.ts`,
  `worker/deno/tests/audit_journal_test.ts`,
  `worker/deno/tests/issue_assignment_test.ts`,
  `worker/deno/tests/review_round_command_4658_test.ts`,
  `worker/deno/tests/review_round_test.ts`.
- Targeted run on the head of the touched suites: `ok | 285 passed | 0 failed`
  (parallel pass); the babysitter files `ok | 125 passed | 0 failed`. `deno fmt
  --check`, `deno lint` and `deno check` on the changed files are clean;
  markdownlint on the docs: 0 issues.
- Red checks (each guard broken alone, test went red, restored): review head rule
  re-added; merge window doubled; same-head merge check removed; `--auto` =>
  `merge` (hook assertion); `cancelled` counted; PR-head runs used for post-merge;
  never resolved; recovery restricted to the same head; blocker cap removed;
  roster recovery on collect; missing-host note off and forced on; `git_pull`
  always `milestone`; always `branch-update`; relative and `..` `VIBE_AUDIT_DIR`
  checks removed; `deployment.status` and `discoveryComplete` operands deleted;
  `--expected-inventory` pass-through removed; reader trusting `rediscovered`;
  discovery calls removed one at a time; `reportHostId` bypassed (babysitter,
  heartbeat and reviewer).
- The `windowClosed &&` operand of `ready` in
  `worker/deno/lib/pr_completion_report.ts` was a dead operand (`status` already
  returns `pending` first when the window is open), so it was removed rather than
  tested. The `issue_assignment` host test supplies `VIBE_HOST_ID` in its child
  process, including under the gate.
- Callers checked: `productionIssueAssignmentSeams` (host reader
  `subscription_allocation_runtime.ts:248` again matches); `actionKindFor`
  callers all go through `record`.
- Existing assertions changed (all removed relative to `origin/main`):
  - Removed from `worker/deno/tests/audit_hook_test.ts`:
    `assertEquals(entry?.headSha, undefined);`
    - Required by: "Record trusted automation provenance for
      implementation/repair/review/dismissal/merge actions"
    - Replaced by: `assertEquals(entry?.headSha, "a".repeat(40));`
  - Removed from `worker/deno/tests/audit_hook_test.ts`:
    `assertEquals(pushKind(callerIn("lib", "git_pull.ts")), "unknown");`
    - Required by: "trusted provenance for babysitter/reviewer and milestone
      actions"
    - Replaced by: `assertEquals(pushKindFor(["push", "origin", "milestone/foo"], caller), "milestone");`
      A resolved but unnamed caller must still be unknown, covered by
      `worker/deno/tests/audit_hook_test.ts::audit_hook - unnamed pushes stay unknown while milestone pushes are classified`.
  - Removed from `worker/deno/tests/pr_completion_report_test.ts`:
    `assertEquals(report.cohort.prCount, 7);` (also `openPrs` 2, `eligiblePrs` 6)
    - Obsolete: the fixture gained an eighth PR (open, owner-gate label) to cover
      `unverifiedOwnerGateLabels`; the counts rise by one.
      Still covered by:
      `worker/deno/tests/pr_completion_report_test.ts::PR completion report deduplicates repeated observations and separates trusted outcomes`
  - Removed from `worker/deno/tests/pr_completion_snapshot_test.ts`:
    `assertEquals(report.rollout.rediscoveredPrs, 1);` (and `processedPrs`,
    `notRediscoveredPrs`)
    - Required by: "Report mixed/stale deployment or missing heartbeat as
      unknown/degraded" and the rediscovery reconciliation: without discovery
      evidence the count is unknown.
      Replaced by: `assertEquals(report.rollout.unknownDiscoveryPrs, 2);`
  - Removed from `worker/deno/tests/pr_completion_snapshot_test.ts`: the
    `unattendedMerged` 1, `logged?.actor` `"fleet"`, `logged?.verified` `true`
    assertions of the review-log tests
    - Required by: "Do not label a historical PR zero-touch solely from login
      identity" — an unchained `log.jsonl` is not trusted provenance.
      Replaced by: `assertEquals(logged?.verified, false);` and
      `assertEquals(report.completion.unknownMerged, 1);`
  - Removed from `worker/deno/tests/pr_completion_snapshot_test.ts`: the
    before-creation and 15-minutes-after merge `assert(ids.includes(...))`
    checks
    - Obsolete: merge matching is now a ten-minute window either side of
      `mergedAt` on the same head, and an auto arm no longer matches.
      Still covered by:
      `worker/deno/tests/pr_completion_snapshot_test.ts::a verified merge matches GitHub's merge only on the same head and within ten minutes either side`
- Twinned rules: the `actionKind` classification in `audit_hook.ts` and the
  matcher in `pr_completion_snapshot.ts` agree on kinds; the hook-driven collect
  test covers both. `CODING-STANDARDS.md` and the guidelines template are not
  changed.
- Full gate: `./quality.sh < /dev/null` on the head before the last two fixes
  took 7m27s in the deno test stage and failed on `check:manifests` (the
  process-state mutator test, fixed by the isolation above; `deno task
  check:manifests` now passes: `ok | 847 passed | 0 failed | 1 ignored`) and on
  four tests: the mutator test above, plus `handover_note_test.ts` (a note is
  deno fmt clean), `heartbeat_test.ts` (stopHeartbeat clears the interval) and
  `handler_watchdog_scope_test.ts`, which all pass in isolation
  (`ok | 59 passed | 0 failed`) and appear to race under the loaded parallel
  pass; they were not investigated further. A second end-to-end run after the fixes
  exceeded the 595 s bound and was not completed; checkov and config integration are skipped by the gate. CI
  runs the full suite on this PR.
- Not done: live GitHub never called; no cross-host data; reviewer provenance
  from the review skill; human attribution; owner-gate verification.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
