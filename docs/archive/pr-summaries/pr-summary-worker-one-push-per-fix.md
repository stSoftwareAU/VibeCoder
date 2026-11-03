# Worker: one push per fix, with the base merged in

## Summary

The worker's CI-fix, review-feedback and spelling passes pushed their fix onto
the PR branch as it was, even when the branch was behind its base. The PR then
read `BEHIND`, and the update-branch request that followed ran the whole CI a
second time for the same fix. Each of those passes now merges the PR's base in
just before it pushes, so the fix and the branch update go out together and CI
runs once. A new PR is also checked against its base once more right before
`gh pr create`, and brought up to date then, while the push still starts no CI.

## Spec

### Intent and Rationale

- Owner direction (2026-11-03): GitHub Actions spend is high, the feature branch
  must always be current with its target, and fewer pushes also mean faster
  merges and fewer conflicts.
- Required checks run only on `pull_request` events, so a push before the PR
  exists is free, while every push to an open PR is a full CI run.

### Essential Design Decisions

- The merge is a new step inside `commitAndPushPending`, after the formatter,
  pre-flight and verifier gates, so those gates still judge only the pass's own
  commits; CI then runs on the merged head.
- It reuses the PR-raise sync's `ensureBranchCurrent` and `mergeOntoBase`: plain
  merge, never a rebase or force-push, and an aborted merge on conflict, after
  which the fix is pushed as before and the conflict lane takes over.
- It acts only when there is a fix to push to a branch already on origin: a pass
  with no fix still pushes nothing, and a gated head's milestone-fix branch is
  left alone because its PR targets the head, not the head's base.

### Undiscoverable Facts

- The local git here (2.43) rejects `git checkout --end-of-options <branch>`,
  which `mergeOntoBase` uses; the new git-level tests were run with git 2.56.

## Evidence

- Read and updated `docs/INTERNALS.md` (new section "One push per fix: the base
  rides along", next to the PR-raise currency sections) and
  `docs/workflows/ci-fix.md` (Happy path, step 8).
- The new completion-phase test failed before the change (no merge or push
  between the gates and `gh pr create`) and passes after it.
- 873 tests across the completion phase, CI, feedback and spelling processors,
  `git_push`, branch currency and PR-raise sync suites passed with Deno 2.9.6
  and git 2.56, plus the 7 new tests.
- Tests used a temporary import map to a local denoland/std checkout because
  pinned JSR packages cannot be downloaded here. This is supplemental
  validation, not a pinned-dependency CI pass. `deno fmt`, `deno lint` and
  `deno check` of the changed files passed (`deno check` reported errors only
  inside the local std checkout).
- No UI screenshots apply to this worker change.

## Test Plan

- `tests/pr_push_base_sync_test.ts` (new): with a real bare origin, a fix on a
  branch behind its base is pushed with the base merged in, in one push; a pass
  with nothing to push merges nothing; a conflicting base is aborted and the
  branch left as it was; the PR base is the known one, else read from GitHub,
  else unknown; the spelling pass passes its PR's base to the push.
- `tests/completion_phase_last_currency_test.ts` (new): a base that moved during
  the gates is merged in and pushed before `gh pr create`; a branch still
  current is not pushed again.
- No existing test or assertion was changed or removed.

## Merge verification

- CI: not yet verified.
- Code review: awaiting code review.
