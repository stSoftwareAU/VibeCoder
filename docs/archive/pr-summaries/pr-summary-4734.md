## Summary

`run()` in `worker/deno/commands/fleet_pr_babysitter.ts` tested
`command === "git"` twice. The first branch (the #1553 chokepoint) returned or
threw without a `timeoutSeconds`, so the second branch, the only one that passed
the 30-minute bound, never ran. Every `run("git", ...)` in `fix` (the head and
base tracking-ref fetches and the push of the fix) therefore got the 60 s
default from `getTimeoutForOperation`. This change gives the live branch the
30-minute bound and deletes the dead block. Closes #4734.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A push or fetch of a large repository over a slow link can pass 60 s; git was
  killed and the repair lost, with the attempt marker already written.
- The live branch keeps the chokepoint (timeout, audit journal, fault detector),
  so the bound is added there rather than reviving the dead branch.

### Essential Design Decisions

- The 30-minute bound applies to every git command run through `run`, not only
  fetch and push: the dead block applied it to all of them, and the issue allows
  either.
- `run` is exported and takes a `runGit` parameter defaulting to `runGitArgv`,
  following the `defaultGit` seam in the same file, so a test can observe the
  options reaching the chokepoint.
- Durable retry after a transient timeout stays with #4656.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change.

- `deno task test:unit` on
  `worker/deno/tests/fleet_pr_babysitter_git_timeout_test.ts`,
  `worker/deno/tests/fleet_pr_babysitter_single_push_test.ts` and
  `worker/deno/tests/babysitter_fix_orchestration_test.ts`: 59 passed, 0 failed.
- Docs: `docs/workflows/fleet-pr-babysitter.md` (mirror paragraph) states the
  bound; the 60 s default is `DEFAULT_GIT_COMMAND_TIMEOUT` in
  `worker/deno/lib/git_timeout.ts`.
- #1553 is the chokepoint the live branch keeps; #4656 is named above as owning
  durable retry.

## Test Plan

- `worker/deno/tests/fleet_pr_babysitter_git_timeout_test.ts`: a git push and a
  git fetch through `run` reach the chokepoint with the full argv, the cwd and
  `timeoutSeconds` of 1800; a failing git throws with its stderr cause. Red
  check: removing `timeoutSeconds: REPAIR_GIT_TIMEOUT_SECONDS` from the git call
  turned the push and fetch tests red (`undefined` vs `1800`).
- Changed call site: `run`'s git branch, reached from `fix`'s `exec` (fetches
  and the push at `finishBabysitterRepair`); the test drives `run` itself.
- Removed code: the unreachable second git block in `run`. It could not run (the
  earlier branch always returned or threw), so no behaviour or test depended on
  it.
- Full gate `./quality.sh`: `deno tests` failed on two tests in
  `worker/deno/tests/completion_phase_repo_formatters_test.ts` (cargo fmt
  staging), which also failed in earlier runs on other branches and are
  unrelated to this change; the serial pass did not run after that. Every other
  stage passed, including markdownlint, semgrep, lint, type check and fmt.

Not done / risk: the 30-minute bound is observed at the `runGit` seam, not by a
real slow git; the two formatter tests were not run on the base branch here.
