## Summary

Three changes to the milestone sync so it stops stalling the host and stops
duplicating a sibling's work (Issue #2030). Closes #2030.

- **It runs beside issue work.** "Milestone Branch Sync" is flagged
  `maintenanceLane: true`, so its agent rung runs in the maintenance lane
  (Issue #213) alongside the issue pool instead of ahead of it. Both the sync
  and the self-heal that precedes it gain a `leaseRepoFn` hook, wired to
  `acquireMaintenanceRepoLease`, so each repository's shared clone is leased
  for that repository's pass and a slot never resets it mid-merge; a
  repository a slot holds is deferred with a log line.
- **One host per branch.** New `worker/deno/lib/milestone_sync_claim.ts`:
  before a branch is synced the host pushes a claim — a hidden ref
  `refs/vibe/sync-claims/<milestone-branch>` pointing at a fresh `commit-tree`
  object over the milestone tip — with `--force-with-lease` expecting the ref
  absent. A sibling's claim younger than two hours skips the branch this
  cycle without opening an attempt; an older claim is taken over atomically
  against its exact SHA; the claim is released when the sync concludes. A
  claim that cannot be read or written is logged and ignored (`unknown`), so
  a claim outage costs duplicate work, never a stalled sync.
- **A sync a sibling landed mid-rung is adopted, not pushed over.** In
  `syncMilestoneBranchWithDefault`, right before the gate and push on both
  the clean and the resolved path, the milestone branch is re-fetched; if the
  default tip is already an ancestor of the remote branch, the local merge is
  discarded for the remote's and the outcome is `ALREADY SYNCED by another
  host … nothing pushed`.

Docs: `docs/workflows/milestones.md` § "Running beside issue work, one host
per branch"; ledger slice `top-up-2030` with its sweep record.

## Tests

- `milestone_sync_claim_test.ts` (real git, bare remote, two clones): first
  host claims, sibling is told the holder's age, release frees it; a
  three-hour-old claim is taken over and the returning host then finds the
  fresh one; a clone that cannot see the tip reports `unknown`.
- `milestone_sync_already_synced_test.ts` (real git): host B's agent stub
  lets host A land the same sync mid-rung; B adopts A's tip, pushes nothing,
  leaves no merge in progress.
- `milestone_branch_sync_test.ts`: a held repository is deferred and a granted
  lease released; a branch another host claimed is skipped without a sync,
  a claimed one syncs and releases.
