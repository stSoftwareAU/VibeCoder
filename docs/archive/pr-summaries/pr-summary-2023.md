## Summary

The milestone sync's conflict ladder gains a **ported** rung between the
deterministic rules and the agent (Issue #2023). It asks history instead of
reading hunks: for each conflicted path, if the default branch's history ever
carried the milestone's exact current version of that file (byte-identical
blob), the default branch absorbed that version and moved on, so its version
contains the milestone's and is taken; symmetrically for the milestone. A path
neither history explains goes to the agent, narrowed to exactly those paths.
Closes #2023.

Why this shape: on 2026-09-12 the agent rung spent 44 minutes and 800 tool
calls on a ninety-file conflict (twenty-five add/add pairs across whole
directories) merging the default branch into a milestone whose content had
already reached it through another milestone's squash. Experiments on git 2.54
showed the merge already handles a rebase-style rewrite cleanly, and that
cherry-pick replay conflicts exactly where the merge does on a squash rewrite —
so the discriminating evidence is historical blobs, not patches.

What changed:

- **`worker/deno/lib/milestone_conflict_ported.ts`** (new) — `parseStageBlobs`
  / `readStageBlobs` read the conflicted index; `classifyConflictShape` /
  `isWrongBaseShape` / `describeConflictShape` name the shape (>20 files, or
  add/add pairs in >1 directory) for the log; `decidePorted` runs
  `git log --max-count=1 --find-object=<blob> <ref> -- <path>` for each side;
  `resolvePortedPaths` stages `--theirs` / `--ours` only for a decided path and
  leaves the rest untouched. Branch names are validated before any git runs;
  paths always follow `--`. No worktrees, no temp files.
- **`milestone_conflict_ladder.ts`** — the rung runs after the rules; settled
  paths carry `rung: "ported"` with the commit that carried the version; the
  remainder narrows the agent's request. `ResolutionRung` gains `"ported"` and
  the triage renders it.
- **Docs** — `docs/workflows/milestones.md` (diagram and "The ported rung");
  ledger slice `top-up-2023` with its sweep record.

## Tests

`worker/deno/tests/milestone_conflict_ported_test.ts` (real git): squash
rewrite ⇒ both conflicted paths taken from main, staged, the milestone's own
new file untouched, shape logged; symmetric case ⇒ ours; rival design ⇒
undecided and unmerged; unsafe branch name ⇒ refused before git; in the ladder
⇒ agent never reached, or reached only with the unexplained path. Pure tests for
shape and stage parsing. 160 pass across the ported, ladder, triage, sync and
ledger suites.
