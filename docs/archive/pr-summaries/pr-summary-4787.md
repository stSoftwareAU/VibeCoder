## Summary

The milestone resolution gate refused the same resolution for
`stSoftwareAU/GRQ-AutoTrader` on every cycle because its Issue #974 type check,
`cargo check --workspace --all-targets --locked`, was killed at the 300 s limit
(`exit 124`, `Type check timed out after 300000ms`). A cold build of a large
Cargo workspace needs longer than that. This change gives a Cargo project's type
check its own 900 s limit (`CARGO_MERGE_GATE_TIMEOUT_MS`, chosen by
`typeCheckTimeoutMs`) and keeps 300 s for a Deno project. `verifyResolvedTree`
now starts its 15-minute task budget after the type check has passed, so a long
cargo check no longer spends the budget that `cargo test` needs. `docs/INTERNALS.md`
and `docs/workflows/milestones.md` state the new limits. Closes #4787.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The report's cause is the timeout line itself; the gate cannot verify a tree
  it kills before the build finishes. Raising the limit for the toolchain that
  needs it is the smallest change that lets the gate verify the tree, and it
  leaves a timeout a failure, never a pass.

### Essential Design Decisions

- The budget moved because a 900 s check inside a budget that started before it
  would leave nothing for `cargo test`. The cost is a longer worst case per
  resolution: type check limit plus 15 minutes (Deno: 5 + 15 min; Cargo: 15 + 15
  min), instead of 15 minutes in all.
- The 900 s value is a chosen figure, not a measured one: no cold cargo check
  time for GRQ-AutoTrader was observed here. If it still times out, the next
  attempt reads the new `timed out after 900000ms` line.

### Undiscoverable Facts

- I did not find a caller-level watchdog around the milestone sync that would cut
  a 30-minute cargo resolution short; this was not checked exhaustively.

## Evidence

Backend only; no UI. Cited code was read at the head:
`worker/deno/lib/milestone_merge_gate.ts` (`spawnTypeCheck`, `typeCheckTimeoutMs`,
`checkMergedTree`) and `worker/deno/lib/milestone_resolution_gate.ts`
(`verifyResolvedTree`).

Docs sections read and updated: `docs/INTERNALS.md` (the resolution-gate
paragraph and the "Nothing unverified is published" property) and
`docs/workflows/milestones.md` (the 15-minute budget sentence). Greps for
`MERGE_GATE_TIMEOUT_MS`, `RESOLUTION_GATE_BUDGET_MS` and "verification budget"
outside `docs/archive/` found no other hit.

## Reproduction

- **symptom** — the gate refused the resolution with `cargo check --workspace
  --all-targets --locked ... failed (exit 124)` and `Type check timed out after
  300000ms`, twice for the same Develop tip.
- **status** — `partial` — the real cargo timeout was not reproduced; the
  workspace is another repository and a cold build is not runnable here. The
  tests drive the limit passed to the command runner and the budget ordering.
- **regression test** — `worker/deno/tests/milestone_merge_gate_test.ts::spawnTypeCheck - each toolchain's check gets its own limit, and a timeout names that limit (Issue #4787)`

## Test Plan

- Added to `worker/deno/tests/milestone_merge_gate_test.ts`: the
  `typeCheckTimeoutMs` test and the `spawnTypeCheck` per-toolchain limit, timeout
  message and non-timeout positive-control test, both through an injected command
  runner.
- Added to `worker/deno/tests/milestone_resolution_gate_test.ts`: a type check
  that advances the clock by 800 000 ms still leaves the first task the full
  `RESOLUTION_GATE_BUDGET_MS`.
- No existing test edited, no assertion removed.
- Red-checks: `typeCheckTimeoutMs` returning the Deno limit for cargo → the
  merge-gate tests red; deadline computed before the type check → the
  resolution-gate budget test red. Each break was applied alone and restored.
- `deno task test:unit` over `milestone_merge_gate_test.ts`,
  `milestone_resolution_gate_test.ts`, `milestone_sync_merge_gate_test.ts` and
  `merge_gate_fail_closed_test.ts`: 58 passed, 0 failed.
- `deno task check:manifests`: passed.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`; config integration and checkov were skipped by the gate itself.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
