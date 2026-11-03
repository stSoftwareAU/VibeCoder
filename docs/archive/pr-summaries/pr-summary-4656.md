## Summary

Added versioned retry state, bounded backoff and legacy migration to the PR
babysitter. Substantive attempts are tallied through fleet-authored PR markers,
read-token sessions restart before expiry, and pushed PRs stay tracked until
GitHub reports a merge. Failures are classified from where they are raised
(agent killed, lock lost, head moved) with the error text only as a fallback,
and the retry record is saved before any best-effort marker write. At the
configured no-progress limit the record keeps redacted evidence and the
babysitter files one deduplicated `idle-task` issue (never `needs-human`).
Tracked PRs are observed each scan without a lock: CI, independent review,
drafts, cross-repository PRs, `skip_auto_merge` and `needs-human` holds are
recorded, and a green approved PR is recorded as handed to the worker's
auto-merge sweep. Closes #4656.

Version bump: none in this change; no release version was changed.

## Spec

### Intent and Rationale

- Temporary provider, capability and lock failures should retry without manual
  deletion of an attempt file.
- Keep recovery in the existing babysitter scan and branch-lock flow.

### Essential Design Decisions

- Host-local JSON stores cooldown and reconciliation state; configured fleet
  authors' existing PR attempt markers share the substantive retry tally.
- The agent receives a repository-scoped read token and the runner restarts its
  session before token expiry. Runner write authority stays outside that
  session.
- State is cleared only after GitHub reports the PR merged.

### Undiscoverable Facts

- The task's listed related issues were checked with `gh issue view`; their
  separate outcomes were not duplicated here.
- `gh api repos/stSoftwareAU/VibeCoder/issues/4656/comments --paginate --slurp`
  returned an array of page arrays with `id`, `user.login`, `created_at` and
  `body`, which the shared-marker reader validates.

### Deno regression avoided

- Used Deno tasks and Deno checks; no Node tooling or lockfile dependency was
  added.

## Evidence

Backend/CLI change. `worker/deno/tests/babysitter_fix_orchestration_test.ts`
drives the real `fix()` with in-memory GitHub, git and agent boundaries
(`FixDeps`), and the real `observeTrackedPr` / `reconcileTrackedPr`:

- Transient failure (SIGKILL) -> unchanged-head cooldown (no session) -> retry
  after the cooldown -> checked repair pushed -> CI pending -> independent
  review pending -> approved and clean, recorded as handed to the auto-merge
  owner -> merged observed, which alone clears the record.
- An old attempt file migrates to a five-minute cooldown; a restarted process
  reads the saved v2 record and retries without deleting any file.
- Two hosts contending: the later lock loses, starts no session and leaves no
  lock; head movement before and during a repair; ENOSPC, a missing tool, a
  timed-out fetch/push and `agent exited unsuccessfully with code 137` all spend
  no substantive budget and post no marker.
- Credential expiry restarts the session with a continue prompt.
- Repeated no-progress persists evidence, changes the prompt at the cap and
  escalates exactly once across three passes; a failed escalation is retried;
  the real `escalateStuckRepair` reuses a fleet-authored issue, ignores a
  planted marker and files one `idle-task` issue with no `needs-human` label.
- Waits hold no repair lock (the lock list is empty after a failed repair and
  after the push, and the observation takes no GitHub client); a `needs-human`
  PR starts no session and stays `owner-hold` with no next eligible time.

The related deliverables stay separate: the babysitter continues to use the
existing branch updater and branch lock and never merges, arms or bypasses
anything; the worker's auto-merge sweep owns the merge.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Tests drive transient failure -> unchanged-head cooldown -> retry ->
  checked repair -> CI -> independent review -> merge observed. — evidence:
  `worker/deno/tests/babysitter_fix_orchestration_test.ts::transient failure, cooldown, retry, checked repair, CI, review and merge observed`
  — reviewer: met
- **met** — Include process restart and migration of an old attempt file, two
  hosts contending, head movement, missing tools/disk recovery, credential
  expiry and repeated no-progress. — evidence:
  `worker/deno/tests/babysitter_fix_orchestration_test.ts::an old attempt file migrates to a bounded retry across a restart`,
  `::two hosts contending: the loser starts no session and leaves no lock`,
  `::head movement defers, and a head that moves mid-repair spends no substantive budget`,
  `::missing tools, a full disk, a timed-out fetch and a killed agent spend no substantive budget`,
  `::an expired read token restarts the session and the repair continues`,
  `::repeated no-progress persists evidence and escalates exactly once` —
  reviewer: met
- **met** — Show that waits hold no repair lock, one incident produces one
  deduplicated escalation and real human gates remain paused. — evidence:
  `worker/deno/tests/babysitter_fix_orchestration_test.ts::transient failure, cooldown, retry, checked repair, CI, review and merge observed`
  (empty lock list),
  `::repeated no-progress persists evidence and escalates exactly once`,
  `::escalation reuses a fleet-authored issue, ignores a planted one and files an idle-task once`,
  `::real human gates stay paused` — reviewer: met
- **met** — On repeated substantive no-progress, persist the evidence and use
  the existing automated escalation/repair mechanism from #569/#4158. —
  evidence: `worker/deno/commands/fleet_pr_babysitter.ts::escalateStuckRepair`
  (files one `idle-task` issue as shift-left detection does, never
  `needs-human`),
  `::repeated no-progress persists evidence and escalates exactly once` —
  reviewer: met

## Test Plan

- `worker/deno/tests/babysitter_fix_orchestration_test.ts` — 16 tests passed
  (scenarios above, plus the hand-off matrix, closed/merged observation, the
  shared-tally parser and the legacy attempt name).
- `babysitter_retry_state_test.ts`, `fleet_pr_babysitter_test.ts`,
  `fleet_babysitter_app_test.ts`, `fleet_pr_babysitter_setup_test.ts`,
  `fleet_pr_babysitter_supervisor_test.ts` and `audit_hook_test.ts` — passed
  together (129 tests).
- `deno task check:manifests` — passed: 847 passed, 0 failed, 1 ignored.
- Targeted `deno fmt --check`, `deno lint` and `deno check` — passed.
- All commands were run with stdin redirected from `/dev/null`.

### Mutation check

The eight surviving mutants are pinned by
`babysitter_fix_orchestration_test.ts`: `attemptKey` with and without reviews
(negated `if`), and `the shared attempt tally rejects malformed comment pages`
(non-array pages, a page that is not an array, a null or non-object comment, a
non-integer id and a null user). The `typeof user !== "object"` operand was
redundant with the `typeof user.login` check, so it was removed instead of
tested.

### Pre-PR verifier findings

- Escalation at the cap: evidence is persisted and one deduplicated `idle-task`
  issue is filed (`escalateStuckRepair`), tested through `fix()`.
- Merge hand-off: `reconcileTrackedPr` records the hand-off to the existing
  auto-merge sweep and honours holds, drafts, cross-repository PRs and
  `skip_auto_merge`; the babysitter does not merge itself.
- Classification: failures raised by the agent, lock and head checks carry a
  structured class; the record is saved before the guarded marker write.
- Orchestration tests and `docs/workflows/fleet-pr-babysitter.md` now match the
  behaviour.
- Not re-run in this turn: the full `./quality.sh` (it previously reported 7
  failures in files this change does not touch) and the coverage carry-over
  check, whose failure was the merge-base run of the two babysitter test files,
  not these tests, which pass at the head.
