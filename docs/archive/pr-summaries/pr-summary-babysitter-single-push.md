# Babysitter: one push per repair, with auto-merge armed

## Summary

The fleet PR babysitter merged the base into the repair clone only for a merge
conflict. A CI or review fix on an outdated branch was pushed as-is, so the
branch then needed a second push to bring it up to date, and CI ran twice for
one repair. Every repair now merges the latest base before the agent starts and
pushes the fix and the merge together as one merge commit. The babysitter also
arms auto-merge on repair candidates that are not armed yet, so a PR merges as
soon as CI is green, the branch is current and the review is approved.

## Spec

### Intent and Rationale

- Owner direction (2026-11-03): GitHub Actions spend is high; a fix push
  followed by a branch-update push costs roughly double, so do both in one push.
- Owner direction: a PR merges only when CI is green, the branch is updated and
  the review approved; auto-merge should be armed so it merges as soon as those
  gates pass, which reduces conflicts across the fleet.

### Essential Design Decisions

- The base is merged before the agent runs, not after, so the agent's local
  checks run against the code CI will test.
- A clean merge records the merged tree, and the `git diff --check` gates
  compare against it, so the base's own whitespace (for example Markdown hard
  breaks) never refuses a fix; a conflicted merge keeps the `HEAD` comparison it
  had before.
- Arming reuses the shared `enableAutoMerge` helper with the fleet identities,
  so milestone holds and the gated direct merge for unprotected bases still
  apply. It runs before the strict branch refresh, which only refreshes an armed
  PR. A failure to arm is a WARNING, never a failed repair.

### Undiscoverable Facts

- None.

## Evidence

- Read and updated `docs/workflows/fleet-pr-babysitter.md` (the repair flow,
  auto-merge, and the MVP limits paragraph that said it did not arm auto-merge).
- Babysitter tests: 67 passed with Deno 2.9.6. The one failing test, the
  default-heartbeat test, fails before and after this change only because
  `jsr:@std/crypto` cannot be downloaded in this environment.
- Tests used a temporary import map to a local denoland/std checkout because
  pinned JSR packages cannot be downloaded here. This is supplemental
  validation, not a pinned-dependency CI pass. `deno fmt`, `deno lint` and
  `deno check` of the changed files passed (`deno check` reported errors only
  inside the local std checkout).
- No UI screenshots apply to this worker change.

## Test Plan

- `tests/fleet_pr_babysitter_single_push_test.ts` (new): a current head is left
  untouched; an outdated head is committed with the fix and the base as one
  merge commit, despite whitespace in the base; whitespace the fix adds is still
  refused; a conflicting base is left for the agent; the prompt asks the agent
  to keep the merge only when one was made; auto-merge is armed with the fleet
  identities, not re-armed when already armed, and a failure to arm does not
  throw; an outdated PR is armed before its branch is refreshed.
- `tests/fleet_pr_babysitter_test.ts`: the strict-readiness branch refresh test
  injects a no-op arming step. No assertions were removed.

## Merge verification

- CI: not yet verified.
- Code review: awaiting code review.
