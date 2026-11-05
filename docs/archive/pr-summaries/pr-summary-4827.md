## Summary

The babysitter's repair clone now appends `*.profraw`, `*.profdata`, `lcov.info`, `/mutants.out/` and `/mutants.out.old/` to its `info/exclude` right after cloning, so `git status --porcelain` and `git add -A` ignore those untracked byproducts. A session that leaves only byproducts reports "agent made no changes"; a real fix is committed without them. Closes #4827.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The runner stages with `git add -A`, so it cannot tell a fix from a local coverage or mutation run's output. `info/exclude` fixes that at the source without refusing or failing anything.

### Essential Design Decisions

- `info/exclude` rather than `.gitignore` or a staging filter: it is local to the clone, touches no tracked file, and applies to untracked paths only, so a repo that tracks `lcov.info` still commits edits to it.
- The exclude path is resolved with `git rev-parse --git-path info/exclude` (same approach as `codegraph_context.ts`); errors throw rather than continue with an unprotected clone.
- The file is read with a plain read, not the no-follow read: the clone is fresh and the agent has not run yet.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI change; no UI. Tests in `worker/deno/tests/fleet_pr_babysitter_test.ts` (all named "Issue #4827"): the commit holds only the tracked edit and the byproducts stay on disk; a byproducts-only session logs "agent made no changes" and never calls `validateAndCommit`; a tracked `lcov.info` edit is still committed; the helper is idempotent and handles a missing trailing newline.

## Test Plan

- `deno task test:unit tests/fleet_pr_babysitter_test.ts tests/fleet_pr_babysitter_single_push_test.ts`: 127 passed, 0 failed.
- Red check: removing the `excludeRepairByproducts` call from `cloneForRepair` turned the commit test and the byproducts-only test red (`validateAndCommit must not run`); the tracked-file and idempotence tests are positive controls and stay green by design.
- Callers of `cloneForRepair` checked: the production caller (`deps.clone ?? cloneForRepair`) and existing clone tests, which use real git or reject before the new step.
- Docs: `docs/workflows/fleet-pr-babysitter.md` repair-clone paragraph updated.
