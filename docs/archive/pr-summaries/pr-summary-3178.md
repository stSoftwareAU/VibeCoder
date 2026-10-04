## Summary

The host-disk gate stopped claims but not builds. On GRQ-23 (2026-10-03) a
launch started at 38.8 GB free against a 46.0 GB floor. It claimed nothing,
then ran a milestone sync of `stSoftwareAU/GRQ-AutoTrader`. The sync's
verification and two agent repair rounds wrote 23 GB of cargo output into
`/var/tmp/vibe-cargo-target` in 23 minutes, and the host ran out mid-run.

A maintenance build now asks the host disk first (`worker/deno/lib/heavy_build_gate.ts`):

- **Below the floor, a milestone sync that would merge is deferred** before
  the merge, so neither its verification nor its repair rungs run. This covers
  the periodic sweep (`syncMilestoneBranches`) and the pre-cut and arming syncs
  (`presyncMilestoneBranch`). The deferral charges nothing in the conflict
  ledger and logs `[HOST_DISK_LOW] Milestone sync for '…' in <repo> deferred to a later cycle: host disk below its floor — … floor 46.0 GB …`.
- **The ephemeral cargo root has a budget.** On a trim-refused runtime a build
  starts only when host free space is at least the floor plus 25 GB of headroom.
  When it is short, idle target dirs of other checkouts are pruned, largest
  first. If it is still short after that, the build is refused.
- **A sync pass releases its clone's ephemeral target dirs** when it ends,
  rather than leaving them to the relaunch.
- The "costs nothing" comment in `ephemeral_build_cache.ts` now states the
  within-launch cost.

Closes #3178.

## Spec

### Intent and Rationale

- The claim gate and this gate read one `HostDiskMonitor` (registered through `registerHeavyBuildDiskProbe`), so they share one floor and cannot disagree about it.
- The gate sits before the merge, not inside the merge or resolution gate. A gate that failed after the merge would read as a refused resolution and be charged to the conflict ledger. A deferral before the merge is charged nothing.

### Essential Design Decisions

- A branch measured level (`behindBy === 0`) is not asked: it has nothing to merge and nothing to build. An unmeasured branch is asked.
- An `unknown` reading, or no registered probe (tests, ad hoc callers), never defers. This is the same default as the claim gate (Issue #226).
- Pruning never touches the building checkout's own dirs (its incremental cache) or any dir written to in the last 20 minutes (another slot's build). A root that cannot be read refuses the build rather than letting it build blind.
- `CARGO_INCREMENTAL=0` and reduced debuginfo were considered and not adopted. Both change how the repository's own build behaves for every caller, and the budget already bounds the footprint. They would also change the exact environment the existing #2247 tests pin.

### Undiscoverable Facts

- Pruning inside the guest returns no host blocks where the trim is refused. It still makes room, because the guest filesystem reuses freed blocks that are already allocated to the image.
- CI-fix reruns and lane-worktree target dirs are not gated or released here. Below the floor no new issue is claimed, so the heavy maintenance build that remained was the milestone sync. That is the path this PR covers.

## Evidence

Backend-only change; no UI files touched.

**Docs sweep** — grep: `vibe-cargo-target`, `HOST_DISK_LOW`, `maintenance continues`, `costs nothing`, `2247`, `pausesOnHostDiskLow`; section: `docs/CONTAINER.md#host_disk_low-pauses-the-shared-clone-ref-sweep-issue-2889` and `docs/CONTAINER.md#build-artefacts-ride-the-ephemeral-layer-where-the-trim-is-refused-issue-2247`, `docs/INTERNALS.md#shared-clone-ref-sweep-issue-2889`; updated: `docs/CONTAINER.md` (new "HOST_DISK_LOW defers maintenance builds" section, budget and release bullets in the #2247 section), `docs/INTERNALS.md`

## Test Plan

New: `worker/deno/tests/heavy_build_gate_3178_test.ts` (16 tests). It was red before the change: type check failed because the module did not exist.

- `judgeHostDiskForBuild`: low defers and names the floor; ok and unknown never defer.
- `enforceEphemeralCargoBudget`: under budget, the build runs and nothing is pruned. Over budget, it prunes the largest idle dir and then runs, keeping the building checkout's own dir and a recently written one. Still over after pruning, it refuses. An unreadable root refuses.
- `heavyBuildDeferral`: no probe, no deferral. Below the floor, it defers without reading the root. A trimming runtime skips the budget. Over the cargo budget, it defers.
- `releaseCheckoutTargetDirs`: removes both accounts' dirs for the checkout and nothing else.
- Regression: `syncMilestoneBranches` with host disk below the floor does not call `syncBranchFn`. It counts the branch skipped (not failed) and logs the floor. Above the floor it syncs and releases. A level branch is never asked.
- `presyncMilestoneBranch`: below the floor it returns `deferred` without merging; clear, it merges as before.

Results on the final head:

- The new file plus `milestone_branch_sync_test.ts`, `milestone_presync_test.ts`, `setup_branch_presync_test.ts`, `ephemeral_build_cache_test.ts`, `host_disk_test.ts` and `host_disk_live_reading_test.ts`: 165 passed, 0 failed.
- `deno fmt --check`, `deno lint`, and `deno check` on the touched files: clean.
- Every test file importing a changed module (58 files): 804 passed and 1 failed. The failure is `milestone_presync_git_test.ts` "#1780 - the issue branch starts at the milestone tip…". It fails because the container's git 2.43 refuses `git checkout -B <b> --end-of-options <ref>` ("Cannot update paths and switch to branch"). That is an environment problem: `git_branch.ts` is not touched by this PR.
- `deno task check` (whole tree), `deno lint`, `deno fmt --check` and `deno task check:manifests`: pass. This includes the new `top-up-3178` slice in `docs/audits/lib-sweep-coverage.json`.
- `./quality.sh`: lint, fmt, type check, the chokepoint and hygiene checks, mermaid and the release-tag ruleset pass. Config integration, markdownlint and semgrep were skipped because the tools are missing. The full Deno unit pass was not run locally, because the shared container OOM-kills it and real-git suites fail on git 2.43. CI runs the full suite.
