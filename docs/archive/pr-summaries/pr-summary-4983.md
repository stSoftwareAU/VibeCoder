## Summary

Rewrote the end of the "🚦 The merged tree is type-checked before it is pushed"
section in `docs/INTERNALS.md` so it describes what the sync does today with a
refused merged tree. It does not post a needs-human comment on first occurrence.
The same commit marks the streak file's `gateEscalated` flag as retired in its
doc comment. No code line changed. Closes #4983.

## Spec

### Intent and Rationale

- The section still described the Issue #974 behaviour. Its flowchart ended in a
  comment that needs a human, and the "It escalates on the first occurrence"
  bullet named the `gateEscalated` flag. An operator reading it would wait for a
  comment that never comes.
- In `worker/deno/lib/milestone_branch_sync.ts`, the `isMergeGateFailure` branch
  of `syncMilestoneBranches` posts nothing. `judgeSyncFailure` charges a
  rejected tree (`MERGE_GATE_REFUSED_TREE`) one conflict attempt. It returns a
  not-charged refusal for an unverified tree (`MERGE_GATE_UNVERIFIED_CAUSES`,
  Issue #4847). `escalateRepeatedRefusal` charges the next refusal once
  `MILESTONE_REFUSAL_CEILING` (3) are on the ledger. The docs now say this.

### Essential Design Decisions

- The issue allowed either dropping the `gateEscalated` wording or removing the
  flag. I kept the flag. It is persisted in the streak file, `loadSyncStreaks`
  reads it, `recordSuccess` drops it, and tests pin both. Removing it would
  change code for a docs issue. Its doc comment now says nothing sets it.
- The flowchart keeps its first nodes and replaces only the last one with the
  two paths: charged, or not charged and counted. Both end in the same hand-off:
  a rebuild or roll-back, plus the `merge-fallback` flag.

### Undiscoverable Facts

- None.

## Evidence

Docs and a doc comment only; no UI and no behaviour change. Each claim was
checked against the head code:

- No comment on a gate failure: the `isMergeGateFailure` arm in
  `syncMilestoneBranches` (`worker/deno/lib/milestone_branch_sync.ts`) has an
  empty body. It comes before the `MILESTONE_SYNC_ESCALATION_THRESHOLD` arm, so
  the streak comment is skipped too.
- Charged or not charged: the `isMergeGateFailure` branch of `judgeSyncFailure`.
- Fourth refusal in a row: `escalateRepeatedRefusal` with
  `MILESTONE_REFUSAL_CEILING = 3` (`worker/deno/lib/milestone_sync_streak.ts`).
  This matches the ledger-outcome table later in the same file.
- WARNING log and `sync_failed` self-heal event: the `logAt(log, "warn", …)` and
  `emitSelfHealEvent` calls in the failure arm of `syncMilestoneBranches`.
- `gateEscalated` is never set: `graft_find_all` for `gateEscalated` finds only
  the field, the loader's `=== true` normalisation, and the destructure in
  `recordSuccess` that drops it.
- Provenance numbers I looked up: #974 "Gate the main → milestone sync merge on
  deno check, so it cannot push a tree that does not compile"; #4304 "CI-fix,
  PR-feedback and merge lanes hand PRs back to a human"; #4847 "Merge fallback:
  the merge gate refused the merged tree".
- Docs sweep: I grepped `*.md` outside `docs/archive/` for `gateEscalated`,
  "escalates on the first occurrence" and "oldest open child". At the head the
  two stale phrases no longer appear anywhere. `gateEscalated` appears once, at
  `docs/INTERNALS.md:5120`, in the closing sentence of the rewritten bullet,
  which describes the flag as retired: nothing sets it, and a landed sync drops
  it.

## Test Plan

- No test was added. The change is prose and a doc comment, and a drift test
  would pin wording rather than behaviour. The existing
  `worker/deno/tests/milestone_sync_merge_gate_test.ts` and
  `worker/deno/tests/milestone_branch_sync_test.ts` cover the behaviour the
  prose describes.
- `deno run --allow-read --allow-env mod.ts check-mermaid --script-dir ../..`
  (from `worker/deno`): `mermaid: PASSED (1757 file(s), 1437 block(s) checked)`,
  re-run at the head.
- `deno fmt --check lib/milestone_sync_streak.ts` and
  `deno check lib/milestone_sync_streak.ts` passed.
- `deno task test:unit` over the 33 test files that import
  `milestone_sync_streak` or `milestone_branch_sync` (from `worker/deno`):
  `415 passed | 0 failed`.
- `./quality.sh < /dev/null`, run after merging `origin/main`:
  `Result: PASSED (with skipped checks)`, with `deno tests` PASSED. The gate
  skipped config integration (no `.config.json`) and checkov (not installed).
- `deno task pr-summary-check`: 0 gates blocked, 0 not checked.
