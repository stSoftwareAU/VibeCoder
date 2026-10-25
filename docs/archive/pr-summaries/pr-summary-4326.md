## Summary

When the host is above its disk floor but the ephemeral cargo root is over its
budget (floor + 25 GB headroom) and nothing is prunable, a milestone sync no
longer defers every cycle. `heavyBuildAdmission` (replacing
`heavyBuildDeferral`) now returns `build`, `defer` (host below its floor,
unchanged) or the new `merge-only`. In `merge-only`, a tree that holds a cargo
project is merged **without** the repository's cargo type-check: a conflict-free
merge, and a merge whose conflicts the deterministic rules settle, are pushed
with the existing `UNGATED:` note and the milestone PR's CI builds them. A tree
with no cargo project keeps its own check and the normal agent. A conflict that
needs the resolution agent is not landed that cycle (the agent could run the
very cargo build the host cannot afford); it is charged nothing and lands in the
first cycle whose budget admits a build. Closes #4326.

Version bump: no `VERSION` change was made by hand in this change.

## Spec

Above-floor merge-only admission defers cargo builds to CI. Both gates delegate
to the normal repository gates with cargo skipping forced on; Deno type checks
and unit suites still run in mixed trees. Only cargo-only skipped resolutions
receive `landUnverified`. A failing Deno check refuses a push, and an unlistable
resolution tree fails closed. Cargo trees retain the agent restriction because
an agent can run cargo; Deno-only trees retain the real agent.

The admission reason and both sweep and pre-cut log lines now say cargo builds
wait for CI and Deno projects keep their normal checks. They no longer claim
the whole repository build was skipped before inspecting the tree.

## Evidence

Backend-only change (no UI files). Production-behaviour evidence is the tests
below. Real tool observed: the end-to-end tests run real `git` against a bare
origin in a temporary directory.

Cargo-only clean merges and deterministically resolved conflicts can land
`UNGATED`. Mixed trees must pass their Deno checks before delivery. A conflict
requiring the agent on a cargo tree waits for a cycle with build budget.

## Reproduction

- **symptom** —
  `deferred: milestone behind default branch (30 commits) — ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom 25.0 GB) — pruned 0.0 GB of idle target dirs and 15.8 GB is still short, so the build is refused (Issue #3178)`
- **status** — `partial` — reason: the base-branch behaviour is pinned by the
  old `heavyBuildDeferral - above the floor but over the cargo budget defers`
  test (a deferral at the same figures), but the new tests were not run against
  unfixed base code because they use the new `heavyBuildAdmission` API; each was
  instead seen red by breaking only its production change (below). The GRQ-23
  host was not reproduced.
- **regression test** —
  `worker/deno/tests/heavy_build_gate_3178_test.ts::heavyBuildAdmission - above the floor but over the cargo budget lands merge-only, not deferred (Issue #4326)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Run the sync without the ephemeral cargo build where the sync is
  only a merge, letting the repo's CI build it — evidence:
  `worker/deno/tests/milestone_merge_only_4326_test.ts::merge-only e2e - a conflict-free merge lands unverified: UNGATED, and the milestone carries main's commit (Issue #4326)`
  and
  `worker/deno/tests/milestone_merge_only_4326_test.ts::merge-only e2e - a conflict the worker resolves lands unverified: UNGATED, the milestone carries main's lines (Issue #4326)`
  — reviewer: met
- **partial** — Whatever is chosen, a milestone may not stay behind for more
  than one cycle on disk budget alone — evidence: the two end-to-end tests
  above, and
  `worker/deno/tests/milestone_merge_only_4326_test.ts::merge-only e2e - a conflict the agent would have to resolve is not pushed and not charged (Issue #4326)`
  — reviewer: partial — reason: a conflict that only the resolution agent can
  settle still waits for a cycle with budget, because the agent is free to run
  the cargo build the host cannot afford; the reviewer would close it by capping
  the uncharged merge-only cycles and escalating, by running the agent with
  cargo disabled, or by sizing the headroom from a measured target. Each is a
  larger change than the issue's chosen option and is left for the issue owner's
  agreement
- **partial** — With free space between the floor and floor + headroom, and
  nothing prunable, a milestone sync still lands within one cycle (stubbed disk
  figures) — evidence: `worker/deno/tests/heavy_build_gate_3178_test.ts`
  acceptance tests at 50.9, 55.3 and 55.8 GB free (`merge-only`, nothing
  removed), `worker/deno/tests/milestone_sweep_merge_only_4326_test.ts`,
  `worker/deno/tests/milestone_presync_merge_only_4326_test.ts` and the real-git
  end-to-end tests above — reviewer: partial — reason: the chain from stubbed
  figures to a landed push is pinned in four tests rather than one, and a
  conflict that needs the agent does not land in that cycle
- **partial** — The host's real free space stays above its floor: deferred
  cargo builds cannot consume the protected headroom, and below-floor admission
  still defers. Deno checks remain enabled; live host free-space behaviour was
  not measured during this review fix.
- **unrequested** — `docs/audits/lib-sweep-coverage/top-up-4326.json` claims the
  new module in the sweep ledger — reviewer: unrequested — reason: required by
  the repository's completeness check for a new `lib/` module
- **unrequested** — an unreadable ephemeral root now lands `merge-only` instead
  of refusing — reviewer: unrequested — reason: follows from the chosen option;
  no build runs blind
- **unrequested** — `syncMilestoneBranchForSweep` is exported from
  `run_core_production_deps.ts` and `syncWithMergeOnlyBindings` added to the
  merge-only module — reviewer: unrequested — reason: the one binding path both
  the sweep and the pre-cut sync use, exported so a test can fail without it

## Standards Review

The review corrections preserve Deno verification and replace misleading budget
logs. Tests call the real gates with runner spies; existing cargo-only outcome
assertions remain, including `skipped`, empty output and `landUnverified`.
The agent and first-verdict-only unverified-resolution restrictions remain.
Operator documentation and source comments describe cargo-only deferral.

## Test Plan

- Review-fix push: 60 focused tests passed across merge-only bindings, admission,
  sweep and pre-cut wiring. Root and sibling Cargo/Deno layouts cover success,
  type-check failure and unit-suite failure; a real-git mixed-tree test proves a
  failing Deno check leaves the remote branch unchanged. Sweep and pre-cut log
  regression verifies both Deno checks run and neither log claims a skipped build.
- Reintroducing blanket cargo skipping independently in either gate makes the
  mixed-tree regression fail. Production code restored after each red check.
- Review-fix validation: changed TypeScript type checks, lint and formatting
  pass; Markdown lint passes; manifests: 853 passed, 1 ignored. GitHub CI is
  rerunning after refreshing this summary; no full-CI success is claimed here.
- Earlier implementation validation follows; historical host limitations below
  describe the author's original run, not this review-fix run.

- `worker/deno/tests/heavy_build_gate_3178_test.ts` (migrated to
  `heavyBuildAdmission`; 15 added): acceptance figures 50.9/55.3/55.8 GB with
  nothing prunable, own-and-recent dirs only, prune-then-build, unreadable root,
  an `unknown` level and an `ok` reading with no free figure both build without
  reading the root, sweep and presync hand-off, agent rung not offered.
- `worker/deno/tests/milestone_merge_only_4326_test.ts`: bindings for Deno and
  cargo trees, unlistable tree, real-git end-to-end (clean merge `UNGATED`,
  control with failing gate, Deno-only tree keeps its gate, a conflict the rules
  settle lands `UNGATED` with cargo tasks skipped, control: a plain `skipped`
  resolution is still refused, a conflict the agent would have to settle is not
  pushed and not charged, remote unchanged, no `MERGE_HEAD`); the gate outcomes
  are asserted whole, including `output` and `landUnverified`.
- `worker/deno/tests/milestone_sweep_merge_only_4326_test.ts`: the sweep's own
  `syncMilestoneBranchForSweep` hands the merge-only gates and agent on a cargo
  tree for a merge-only grant, and none (the real agent) without one.
- `worker/deno/tests/milestone_gate_repair_land_unverified_4326_test.ts`:
  `judgeResolutionVerdict` refuses a plain `skipped`, passes a `landUnverified`
  one through, and does not soften a failure; the escalation comment says the
  tree was not checked when `unverified` is set and that it passed otherwise.
- `worker/deno/tests/milestone_gate_repair_test.ts` (one added): a later
  `landUnverified` verdict inside `repairGatedResolution` is still a refusal.
- `worker/deno/tests/milestone_presync_merge_only_4326_test.ts`: the real
  `presyncMilestoneBranchForIssueRun` hands the merge-only gates and agent on a
  cargo tree, and none on `build`.
- Removed from `worker/deno/tests/heavy_build_gate_3178_test.ts`: nothing.
  Changed: `assertEquals(…, null)` became `{ mode: "build" }`, and
  `assert(reason !== null)` became a mode assertion (stricter);
  `heavyBuildDeferral` was replaced by `heavyBuildAdmission` because the issue
  changes the over-budget outcome from a deferral to a merge.
- Red-checks (production change broken, test seen red, restored):
  `heavyBuildAdmission` always `build` → 8 admission tests red; `mergeOnly`
  spread removed at both sweep variants → 2 sweep tests red; presync grant
  forced to plain `grant` → presync hand-off test red; presync
  `undefined, undefined, agentFn` restored →
  `presync - a merge-only admission hands the sync the merge-only gates and agent on a cargo tree (Issue #4326)`
  red; merge gate returning `passed` → `UNGATED` e2e red; early return in
  `landUnverified` ignored in `judgeResolutionVerdict` → the resolved-conflict
  e2e red; the sweep's `mergeOnly` dropped in `syncMilestoneBranchForSweep` →
  the sweep merge-only test red; `free === undefined` operand dropped from
  `heavyBuildAdmission` → the no-free-figure test red; `level !== "ok"` operand
  dropped → the `unknown` level test red; cargo detection always true → 5
  Deno-tree tests red; always false → cargo tests red. The `output: ""` property
  of both cargo-tree gate outcomes is now asserted whole.
- Callers of the changed helper checked: `heavyBuildAdmission` — sweep
  (`run_core_production_deps.ts` via `heavyBuildGateFn`), pre-cut sync
  (`milestone_presync.ts`), and `commands/milestone_branch_sync.ts` (wires no
  gate, unaffected); `judgeResolutionVerdict` — its two callers,
  `runGateWithRepair` (first verdict, may land unverified) and
  `repairGatedResolution` (later verdicts, never); `syncWithMergeOnlyBindings` —
  the sweep (via `syncMilestoneBranchForSweep`) and the pre-cut sync. The
  `MERGE_ONLY_NO_BUILD` marker and the `concludeGateRefusal` guard were removed:
  Deno gate failures still refuse. Twin copies of the rule: none found.
- Results: `deno test -A` on the files above plus
  `milestone_branch_sync_test.ts`, `milestone_presync_test.ts`,
  `milestone_presync_git_test.ts`, `milestone_gate_repair_test.ts`,
  `milestone_sync_conflict*_test.ts`, `milestone_conflict_triage*_test.ts` and
  `git_pull*_test.ts` passed (233 passed, 0 failed);
  `lib_sweep_coverage_test.ts` passed (39); `deno task check:manifests` passed
  (853); `deno lint` clean.
- `./quality.sh`: every stage passed except `deno tests`, which fails the same
  15 `codex`-provider tests it fails on the untouched tree
  (`The running container image did not install the "codex" coding-agent provider`);
  the serial pass did not run because the parallel pass failed. Not checked: a
  live GRQ-23 run.

## Merge with `main` (#4338)

`main` landed a parallel fix for #4326 (`shouldSkipEphemeralCargoBuild`,
`CargoBudgetVerdict.skipCargoBuild`, the gates' cargo skip). Both survive: the
sweep follows `heavyBuildAdmission` (`merge-only` carries the reason as
`mergeOnly`), while `main`'s gate-level cargo skip stays as a second guard in
`milestone_merge_gate.ts` and `milestone_resolution_gate.ts`. The merge-only
sweep log explicitly says cargo builds wait for CI and Deno checks remain.
