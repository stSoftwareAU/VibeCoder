# Refresh only ready PRs on strict bases without merge queues

## Summary

Strict, non-queue bases refresh only an armed PR with satisfied review,
confirmed mergeability and passing required checks on its current head or
verified test merge. A shared GitHub comment owner serialises refreshes across
hosts and updater lanes until merge, closure, terminal required-check failure or
bounded expiry. Conflict repair remains separate. Closes #4613.

The completion-review fixes align owner writes with the stable read anchor,
retain ownership for pending statuses, combine all effective strict rules, and
support explicitly absent classic checks. Reviewer upkeep runs within its
existing granular permissions and retries a moving test merge at the same head.
Blocking-PR stall repair now uses the same readiness and ownership policy.
Review fixes recognise GitHub’s unprotected branch summary and renew the same
PR’s ownership when it needs another refresh; competing PRs remain excluded.
Verifier fixes release the maintenance lane's own PR lock before the shared
policy takes the per-base lock (the anchor can be the same PR), clear the
branch-update failure streak after a successful shared refresh, and pass the
`pr-maintenance` command's loaded fleet identity to the ownership port so a
`CONFIG_FILE`-only host is not refused.

The latest review fixes require the reviewer login in the shared fleet identity
before it can refresh, arm approved behind Dependabot PRs before selecting them,
and recognise enabled branch protection with an empty, disabled checks contract.
The merge manual table retains both milestone rows.

The current review fix preserves earlier live records when the same PR retries;
a failed duplicate attempt releases only its own record. Base transactions use
a separate lock-comment namespace, so their shorter TTL cannot expire a live
PR repair lock. The babysitter releases its PR lock before refreshing. Reviewer
identity lookup failure now reports a skipped refresh and still writes the
posted review's log and summary; the documented post command supplies both
reviewer and config explicitly.

## Spec

### Intent and Rationale

- Avoid spending CI minutes refreshing branches that still await review or do
  not otherwise qualify to merge.
- Reuse the required-check evaluator from PR #4666 and the existing distributed
  PR-comment lock so one owner is visible across worker hosts and skill lanes.

### Essential Design Decisions

- Ownership is keyed by repository and base branch. Both reads and writes use
  the oldest repository PR as their stable comment anchor, including after it
  closes. The distributed PR lock protects short ownership transactions; the
  refresh owner outlives that lock and expires after six hours.
- The required-check contract combines rulesets and classic protection,
  publisher pins and the verified test merge. Any effective strict ruleset
  requires readiness. An explicitly absent classic required-check contract adds
  no classic restriction, including GitHub’s empty summary with checks enforcement off, whether or not
  other branch protection is enabled. For other
  summaries that omit strictness, the classic endpoint supplies it; recognised
  404 absence is accepted while other read errors remain blocking.
- A ready PR remains the owner while refreshed checks are pending. Only terminal
  required-check failure, merge, closure or expiry releases it. The same PR can
  renew its owner with a new head when it becomes behind again. Optional pending
  or skipped jobs do not block selection.
- An unresolved fleet author set refuses ownership recoverably, including before
  an empty store could be interpreted as available. Loaded fleet identity is
  passed by worker/reviewer callers. Reviewer post resolves its configured
  identity without reading environment variables outside its permission
  contract; refresh IDs use permission-free UUIDs.
- Reviewer request refusals are remembered at the reviewed head. Readiness
  refusals, including a changed test merge, leave failed-head memory untouched.
- Behind-only updates in branch maintenance, the auto-merge sweep, reviewer
  gate/post, babysitter, merge-block handling and blocking-PR stall repair use
  the shared policy. Conflict repair retains its separate path.

### Undiscoverable Facts

- The original two-ready-PR backlog fixture issued two legacy refresh requests
  and one guarded request while the first selected PR owned the base.
- The baseline download failure came from an isolated child with cleared
  environment using `/home/vibe/.cache/deno`, while the test runner used
  `/home/vibe/auto-issue-work/.deno-cache`. Populating the child's existing
  remote-module cache from the runner's cache resolved it without changing
  dependencies, tests, repository configuration or check-skip settings.
- No dependency or lockfile changed. Version bump: none.

## Evidence

Backend-only change; no visual evidence applies.

- `worker/deno/tests/base_refresh_ownership_4613_test.ts::GitHub comment ownership serialises independent host ports`
  uses anchor #1 with selected PRs #10/#11, then attempts a further acquisition
  after the transaction lock has gone. Persisted ownership still excludes it; an
  unresolved fleet identity also refuses acquisition. Release then permits the
  next host, and a different base can progress independently.
- `worker/deno/tests/required_branch_checks_4613_test.ts` tests pending,
  success, failure and error commit statuses; opposing strictness in both
  ruleset orders; explicit classic absence and the classic protection endpoint;
  and isolated review, base/head freshness and test-merge freshness guards.
  These cases use passing CI and no competing owner unless ownership is the
  behaviour tested.
- `worker/deno/tests/reviewer_strict_refresh_permissions_4613_test.ts` invokes
  the real gate, post and compatibility-shim CLIs with
  `--allow-env=HOME,XDG_STATE_HOME`, their documented run/read/write grants, and
  an offline GitHub boundary. Each strict path reaches `update-branch`. Only
  GitHub's consistency delay is accelerated in this in-memory fixture.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` retains the
  unreadable-state cases separately and restores successful requests,
  expected-head SHA, actual HTTP 422/403 refusals, reporting and no retry at the
  same failed head. A moving test merge leaves no failed-head entry and a later
  attempt succeeds at the same reviewed head.
- `worker/deno/tests/auto_merge_sweep_keeps_armed_test.ts` drives production
  sweep wiring to successful eligible refreshes. Its production stall-repair
  callback refuses an unreviewed candidate and a candidate competing with an
  existing owner, while allowing an eligible unowned candidate.
- `worker/deno/tests/pr_branch_update_streak_wiring_test.ts` seeds a real
  escalated streak and shows a shared-policy refresh clears it;
  `worker/deno/tests/pr_branch_update_test.ts` shows the PR lock is released
  before the policy runs; `worker/deno/tests/pr_maintenance_command_test.ts`
  drives the command to an `update-branch` PUT using only its loaded fleet
  authors; `worker/deno/tests/merge_block_escalation_test.ts` shows the default
  merge-time updater refuses an unreviewed behind PR on a strict base. Each was
  red with only its own change reverted.
- `worker/deno/tests/pr_branch_update_test.ts` confirms behind maintenance uses
  the shared guard and conflict repair bypasses that behind-only route. The
  shared owner tests also cover the default merge-block and command callers'
  common store.

## Test Plan

Current review regressions exercise a successful refresh followed by a refused
duplicate PUT and a competing PR, a 90-second-old live PR lock on the base
anchor, the babysitter's real fix path for unreviewed and approved behind PRs,
and a post subprocess without `--reviewer` whose `/user` lookup fails. Existing
assertions remain intact; the post subprocess now uses its isolated temporary
directory for child temporary files. No twinned ownership rule was found:
all callers still use the shared ownership implementation.

Focused validation passed: 149 tests across ownership, required checks, branch
locks, babysitter and post-claim suites (the ownership suite was rerun after
adding the duplicate-PUT integration case). Formatter, lint and type checks
passed for the changed TypeScript; repository formatting passed across 3,658
files. `deno task check:manifests` passed: 847 passed, 0 failed, 1 ignored.

The current full `./quality.sh --sequential < /dev/null` run passed repository
lint, type checking, formatting, markdownlint, Mermaid, completeness and all
other available non-test checks. Its parallel test pass stopped with a Deno
2.9.5 runtime panic: `pledge test permissions called before restoring previous
pledge`; the serial pass consequently did not run. This host runs 2.9.5 while
the repository pins 2.9.8. Config integration was unavailable without a local
`.config.json`; Semgrep and Checkov were unavailable without their executables
or container images. Current PR CI had 22 passed checks, none failed. These
host limitations do not replace the focused passing regressions above.

Latest review validation: the required-check, reviewer-permission, backlog and
Dependabot suites passed (72 tests), including strict ownership, missing reviewer
identity and the arm-before-refresh sequence. `deno fmt --check`, `deno lint`,
and `deno task check` passed. The runner integration suite also passed (70
tests), as did the reviewer App suite (12 tests). The reviewer identity is checked against the
existing fleet-author set in both gate and post; no second ownership rule was
added.

Earlier review-fix validation: the five focused ownership, required-check, backlog,
auto-merge and Dependabot suites passed (75 tests). The local formatter, lint,
type check and markdownlint passed. The full parallel suite could not finish:
this host's Deno 2.9.7 panicked while restoring test permissions. Semgrep and
the pinned Checkov version were unavailable locally; CI runs those checks. The
summary freshness check reads commit history and will see this update after the
babysitter commits it.

Commands below run from `worker/deno` unless another directory is stated.

- Before the fixes, regression tests reproduced persisted-owner overlap,
  pending-status release, first-ruleset bypass, explicit-classic-absence
  rejection and missing classic strictness lookup.
- Eighteen individual mutation probes in a disposable checkout were killed:
  owner written to the selected PR, unresolved fleet allowed, pending status
  released, only the first ruleset read, explicit classic absence rejected,
  classic endpoint lookup omitted, forbidden worker environment read restored,
  moving-merge refusal cached, review guard removed, and each initial,
  post-check and immediate base/head or merge freshness guard removed, plus the
  production stall-repair guard bypassed. Each probe failed its targeted
  behavioural test; no exemption is claimed.
- Per-file results at the head, each run alone with
  `deno task test:unit tests/<file>` (re-run for the #4742 review fix):
  `tests/base_refresh_ownership_4613_test.ts` (5 tests at head),
  `tests/required_branch_checks_4613_test.ts` (34 tests at head),
  `tests/pr_branch_update_test.ts` (66 tests at head),
  `tests/auto_merge_sweep_keeps_armed_test.ts` (6 tests at head),
  `tests/review_fleet_prs_backlog_3225_test.ts` (15 tests at head),
  `tests/review_fleet_prs_dependabot_test.ts` (15 tests at head),
  `tests/merge_block_escalation_test.ts` (24 tests at head),
  `tests/reviewer_strict_refresh_permissions_4613_test.ts` (3 tests at head),
  `tests/pr_branch_update_streak_wiring_test.ts` (7 tests at head) and
  `tests/pr_maintenance_command_test.ts` (28 tests at head, including the three
  added for #4742) all passed, 0 failed.
- **Required item 1 — mutation baseline:** `tests/fleet_babysitter_app_test.ts`
  (18 tests at head) passed, 0 failed. `tests/fleet_pr_babysitter_test.ts` (56
  tests at head) ran 55 passed, 1 failed on this host:
  `babysitter default heartbeat resolves its checkout revision` could not
  download `https://jsr.io/@std/crypto/meta.json` (no network access to JSR from
  the subprocess). It passed once the cache was populated in the earlier run;
  the failure is environmental, not a change in this PR. No mutation-check skip
  was set.
- **Required item 2 — coverage carry-over baseline:** measured at merge base
  `18cbb398e5ac7ca39f4d9b58554c112840eddce0` in a disposable worktree on an
  earlier run; not re-run for the #4742 fix, so no figure is restated here. No
  coverage carry-over skip was set.
- #4742 mutation survivors at `worker/deno/commands/pr_maintenance.ts:488-490`
  (`githubUser`, `fleetPrAuthors`, `serviceAccounts` passed to
  `resolveFleetMaintenanceAuthorSet` for the behind-only refresh): killed by the
  three `update-open-pr-branches honours a base owner from ...` tests in
  `tests/pr_maintenance_command_test.ts`. Each test seeds a base owner authored
  by a login that comes from only that source, and asserts the refresh is
  suppressed (one PUT, the seed's) after an unseeded control refreshes once.
  Deleting each property in turn turned its own test red (run with `--no-check`
  for `githubUser`, whose deletion is otherwise a type error).
- Targeted `deno fmt --check`, `deno lint` and `deno check` passed for all
  changed TypeScript files, including
  `.claude/skills/review-fleet-prs/scripts/branch_update.ts`.
- `deno task check:manifests` — passed: 847 passed, 0 failed, 1 ignored.
- `deno task pr-summary-check --base 18cbb398 --issue-body-file /tmp/issue-4613-body.md --labels enhancement,top-priority,work-on ../../docs/archive/pr-summaries/pr-summary-4613.md`
  — passed; 0 blocked, 0 not checked.
- `./quality.sh < /dev/null` from the repository root — failed with 31,955
  passed, 1 failed, 5 ignored. The sole failure is
  `tests/milestone_resolution_gate_test.ts::verifyResolvedTree - the repository's own task sees only the allowlisted environment (Issue #4659)`:
  the account-access probe is left to CI and returns `passed`, while the test
  expects `failed`. Running that unchanged suite at merge base `18cbb398`
  reproduces the identical failure (33 passed, 1 failed). Its production module
  and test have no diff from that base. The serial test pass was not run after
  the parallel failure. Full lint, type check, formatting, markdownlint, semgrep
  and completeness checks passed; config integration and Checkov were skipped by
  the gate because their runtime/configuration was unavailable.

The earlier unconditional fleet-refresh assertions were incompatible with “One
ready PR at a time per base”; success and API-refusal behaviours remain covered
by the strict-ready cases above. Unreadable readiness cases supplement those
behaviours. No Dependabot refusal, per-PR lock or conflict-repair assertion was
removed by these completion fixes.

## Deno regression avoided

Tooling, tests and dependency management remain Deno-native. No Node tooling,
new dependency or lockfile change was introduced.

## Merge verification

CI awaits the worker-created pull request. This run does not create a PR or
close the issue; the worker reruns the completion checks.
