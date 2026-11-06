## Summary

The CI-fix base-branch deferral (#1880) no longer reads "the base branch has no
run of this check" as "the base is green". The worker now reads the failing
check's identity (name, producer app, workflow file) and the base head's SHA,
and sorts the agent's `Depends on` claim into verified red (deferral, as
before), verified green (claim refuted, ordinary charged path), or
**unverified** (no run from the same workflow, a run for another commit, or an
unreadable API). An unverified claim is held: the diagnosis is posted with a
`vibe-ci-fix-attempt` marker whose outcome is `base-unverified`, no fix attempt
is charged, nothing is marked passed, and no `needs-human` is applied. At most
two holds are allowed per failure signature, after which the ordinary charged
path runs so the fleet-wide cap still ends the loop. The CI-fix prompt and
`docs/workflows/ci-fix.md` describe these states and no longer say "nothing on
this branch can fix it".

The worker has no isolated baseline reproduction, so a PR-only check's base
defect stays unverified (held, not deferred) until the base branch itself has a
run of that check. Part of #4680.

Version bump: `VERSION` is not changed by this PR.

```mermaid
flowchart TD
    A[Agent: Depends on N] --> B[Read failing check identity]
    B --> C[Read base head SHA and its check runs]
    C -- same workflow, failure --> D[Red: defer once, no attempt]
    C -- same workflow, success --> E[Green: ordinary path, attempt charged]
    C -- no run / stale / API error --> F{Holds so far < 2?}
    F -- yes --> G[Unverified hold: marker base-unverified, no attempt]
    F -- no --> E
```

## Spec

### Intent and Rationale

- Most fleet checks run only on pull requests, so the base never has a run and
  the old reading made the deferral impossible; the agent then patched base
  defects inside unrelated PRs (VibeCoder#4675, TagsTS#88).
- Unknown evidence is its own state rather than a pass or a charged failure, as
  the issue asks (item 3). A bounded hold keeps it recoverable without a new
  scheduler (#4656 owns retry state).

### Essential Design Decisions

- Identity is name + producer app + workflow file path, so a same-named check
  from another workflow (TagsTS's default CodeQL setup) is not evidence. A
  GitHub Actions check whose workflow path cannot be resolved is `unavailable`,
  never matched by name alone.
- Only `success` is green; cancelled, skipped, neutral, timed-out and
  action-required runs are no evidence.
- Holds are recorded as attempt markers with outcome `base-unverified` but are
  kept out of `countAttempts` (a separate `unverifiedBaseHolds` map), so they do
  not consume the fleet-wide cap. A merge-queue check (non-numeric id) cannot
  have its identity read and is therefore held rather than read by name.
- Assumption: another PR failing the same job is not read at all, since the
  issue says it is only a diagnostic lead.

### Undiscoverable Facts

- `conflict_needs_human_gate.ts` treats any parsed `vibe-ci-fix-attempt` marker
  as "a CI fix was attempted", so a hold counts there too; left unchanged
  because a hold does mean an agent ran.

## Evidence

- `deno task test:unit` on `worker/deno/tests/ci_base_branch_check_test.ts`,
  `worker/deno/tests/ci_fix_attempt_markers_test.ts`,
  `worker/deno/tests/pr_ci_processor_deferral_test.ts` and
  `worker/deno/tests/ci_fix_audit_in_pr_3116_test.ts`: 100 passed, 0 failed.
- Production readers of the new members: `readBaseBranchCheck` and
  `readCheckIdentity` are called in `worker/deno/lib/pr_ci_processor.ts`;
  `countUnverifiedBaseHolds` is called there; `base-unverified` is built in the
  processor and parsed in `worker/deno/lib/ci_fix_attempt_markers.ts`.
- Files read to cite behaviour: `worker/deno/lib/pr_ci_processor.ts`,
  `worker/deno/lib/ci_fix_attempt_markers.ts`,
  `worker/deno/lib/conflict_needs_human_gate.ts`.
- Not observed: a live GitHub response for a PR-only check; fixtures follow the
  documented REST shape of `check-runs` and `actions/runs`.

## Acceptance Criteria

- **partial** — "Establish the same failure signature and its cause in the
  relevant base tree, using an isolated baseline reproduction or equivalent
  commit-bound evidence from the same workflow." — evidence:
  `worker/deno/tests/ci_base_branch_check_test.ts` — reason: commit-bound
  evidence from the same workflow on the base head is read; an isolated
  baseline reproduction for a PR-only check is not implemented, so such a base
  defect stays unverified.
- **missing** — "Once a base defect is verified, use the existing deduplicated
  base-repair/dependency mechanism and automatically resume the PR when that
  repair lands" for a PR-only workflow — reason: a PR-only base defect cannot be
  verified without the baseline reproduction above; for a base that has a run,
  the existing deferral and blocker-landed refresh are unchanged and a later
  red read grants the deferral
  (`worker/deno/tests/pr_ci_processor_deferral_test.ts`).

## Test Plan

- `worker/deno/tests/ci_base_branch_check_test.ts` (25): red, green, no-run,
  other-workflow, other-app, stale, unresolved identity, non-success
  conclusions, errors. Red checks: removing the workflow-path comparison, the
  head-SHA filter, the GitHub Actions no-workflow-path guard and the missing
  app-slug error each turned one test red.
- `worker/deno/tests/pr_ci_processor_deferral_test.ts`: PR-only no-run hold,
  same-named other-workflow check, other PR's red run, stale run, unreadable
  identity, hold bound of two, resumption to deferral once the base is red,
  known-good base. Red checks: forcing no-run to the ordinary path, raising the
  hold cap and counting holds as attempts each turned tests red.
- `worker/deno/tests/ci_fix_attempt_markers_test.ts`: round-trip and unknown
  outcome rejection for `base-unverified`; holds excluded from `countAttempts`.
- Edited expectation in `pr_ci_processor_deferral_test.ts`: a base lookup error
  now holds (one comment, no attempt) instead of charging an attempt; the
  required behaviour is the issue's item 3. It still goes red if the hold is
  forced to the ordinary path (red check above).
- Removed from `worker/deno/tests/ci_base_branch_check_test.ts`: the
  `isCheckRedOnBranch` tests.
  - Replaced by: `readBaseBranchCheck` tests of the same scenarios (latest run
    wins, in-progress re-run, malformed body, API failure).
  - Obsolete: `isCheckRedOnBranch` read a base with no run as `false`.
- Twinned rules: the pinned prompt phrases in
  `worker/deno/tests/ci_fix_audit_in_pr_3116_test.ts` still pass.
