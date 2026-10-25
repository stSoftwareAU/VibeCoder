## Summary

`ensureDefaultBranchCurrent` reported `Failed to fetch origin/<branch>` and dropped `fetchResult.error`. That error already carries git's stderr, a timeout, or a spawn failure. The returned error now appends it, in the same sentence `git_branch_sync.ts` uses for its own fetch failure. `readLocalDefaultTip` already places that message in the milestone tip warning, so the warning gains the reason without a second wrapper.

The recurring fetch failure on the host was not reproduced. No retry was added. Closes #4358.

## Spec

### Intent and Rationale

- A failed fetch of the default branch must name git's own detail, so the "Could not read the tip" warning can be diagnosed.
- The host log never included that detail, so the cause of the recurring failure cannot be taken from it.
- A retry that also covers auth or a missing ref would hide a real failure. None was added.

### Essential Design Decisions

- Keep `runGitCommandChecked`. Its error message is already the stderr (or stdout when stderr is empty), the timeout line, or the spawn error.
- Use the same sentence as `syncBranchToRemoteHead`: `Failed to fetch origin/<branch>: <detail>`, and `git reported no output` when the detail is empty.
- Leave `readLocalDefaultTip` and the milestone presync log as they are. Both already interpolate this error.

### Undiscoverable Facts

- The production warning was `Failed to fetch origin/Develop` with no stderr. Other code in the same run still merged `Develop`. That rules out treating every failure as a missing ref, and it does not identify the failure.
- Lock contention with an issue slot in the same clone is a candidate in `clone_contention.ts`. It was not shown by a failing test against this function, so it was not changed.
- `docs/INTERNALS.md` (cadence) and `docs/workflows/milestones.md` already say an unreadable tip is logged. They do not quote the dropped sentence, so they were left as they are.

## Evidence

Backend change. No UI.

The regression test was run before the fix and failed: actual error `Failed to fetch origin/main`, which does not contain `missing-origin-4358` (the path git prints on stderr). After the fix, the same test passed.

- `deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/setup_repo_default_branch_cache_test.ts` from `worker/deno`: ok, 9 passed, 0 failed.
- `deno fmt --check` and `deno lint` on `worker/deno/lib/git_push.ts` and `worker/deno/tests/setup_repo_default_branch_cache_test.ts`: clean.
- Manuals read and not edited: `docs/INTERNALS.md` (the milestone cadence), `docs/workflows/milestones.md` (the sync beside issue work).

## Test Plan

- [ ] A fetch that cannot reach origin returns an error containing both `Failed to fetch origin/<branch>` and git's stderr (`ensureDefaultBranchCurrent - a failing fetch keeps git's stderr (Issue #4358)`).
- [ ] A valid default branch is still brought up to date, and a dash-leading name is still refused (the other `ensureDefaultBranchCurrent` cases in the same file).
- [ ] Do not treat a green unit run as proof the host's recurring `Develop` fetch has stopped. That failure was not reproduced here.

## Reproduction

- **symptom** — `ensureDefaultBranchCurrent` returns `Failed to fetch origin/<branch>` and drops git's stderr, so the milestone tip warning has no reason
- **status** — `verified`
- **regression test** — `worker/deno/tests/setup_repo_default_branch_cache_test.ts::ensureDefaultBranchCurrent - a failing fetch keeps git's stderr (Issue #4358)`
- The test was observed failing against the unfixed code, where the error was exactly `Failed to fetch origin/main`, and passing after the fix, where the same error contains the missing-remote path from git's stderr.

The recurring host failure (a fetch of `Develop` that fails every cycle while other merges of that branch succeed) was not reproduced.
