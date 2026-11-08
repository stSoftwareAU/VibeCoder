## Summary

The Deno mutation gate now leaves the issue clone's working tree as it found it.
Before its first child process `runDeno` snapshots the untracked and
modified-tracked paths (`git ls-files --others --exclude-standard -z`,
`git diff --name-only -z --relative`). In its outer `finally` it deletes
untracked paths that are new since the snapshot and runs
`git checkout -- :(literal)<path>` for tracked paths newly modified. A listing,
delete or checkout failure is a `[mutation] could not …` warning and never
changes the verdict. Closes #4905.

## Spec

### Intent and Rationale

- A mutant's test run can write anywhere (e.g. a file named `undefined`), and
  the worker's recovery commit runs `git add -A`, so the stray file reached the
  PR. The cargo path avoids this by writing outside the repo; the Deno path
  needs the equivalent restore.
- Snapshot/diff of git listings was chosen over an exclude list because no list
  can name whatever a mutant writes.

### Essential Design Decisions

- New module `worker/deno/lib/mutation_tree_guard.ts` (git via `runGitCommand`,
  the spawn chokepoint); two required seams `snapshotTree`/`restoreTree` on
  `MutationRunnerSeams`.
- The restore runs in the outer `finally`, so it covers the baseline run, every
  mutant and every early return (timeout, budget, baseline failure).
- Accepted limits: a tracked file already modified before the run and changed
  further is left as is; empty directories and ignored files are left; paths
  that are absolute, contain `.`/`..` or end in `/` are skipped with a warning.

### Undiscoverable Facts

- `docs/audits/lib-sweep-coverage/top-up-4905.json` registers the new module
  with the lib-sweep ledger test.

## Evidence

Backend only; no UI. Tests drive `runMutationCheck` over the real seams with a
fake `deno` runner in a temporary git repository.

## Test Plan

- Added `worker/deno/tests/mutation_tree_guard_test.ts` (12 tests; the first 5 below, then the mutation-check follow-ups): untracked
  `undefined` removed while a pre-existing untracked file stays; a rewritten
  tracked fixture is checked out while another file's earlier uncommitted edit
  stays; a deleted tracked file is restored; `snapshotTree` returns null with
  the cause warned in a non-git directory; `restoreTree` warns and does not
  throw when listing fails.
- Mutation-check follow-up: the two duplicated listing blocks in `listTree`
  became one `listPaths` helper, so each failure check exists once. New tests
  cover a missing directory (`!run.ok`), a failing `git diff` listing
  (`diff.renames=bogus`), exact snapshot contents, `isUnsafePath` (now
  exported) for every branch, a nested repository directory refused by
  `restoreTree`, a stray file that cannot be removed (OS message warned,
  other files still restored) and one that has already gone (silent).
  Hand-applied mutants (negated `NotFound` check, negated message ternary,
  dropped `!run.ok` / `code !== 0` operands, `isUnsafePath` returning
  undefined) each turn a test red.
- `worker/deno/lib/mutation_tree_guard.ts:59` exempt (untestable): the mutant
  flips `true` inside the `Listed<T>` type alias, which is erased at runtime.
- Updated the in-memory seam fakes in
  `worker/deno/tests/mutation_runner_test.ts` and
  `worker/deno/tests/coverage_carryover_runner_test.ts` with no-op
  `snapshotTree`/`restoreTree`.
- Red-check: with the `restoreTree` call in `runDeno` disabled, three of the
  five guard tests fail (stray file stays, fixture stays rewritten, deleted file
  stays missing); restored afterwards.
- `./quality.sh` on the final head: all stages pass except
  `tests/merge_fast_checks_credentials_4705_test.ts`, which fails because this
  host's proxy environment variables appear in the expected argv; it does not
  touch the mutation code.
- Docs: `docs/mutation-check.md` gains a paragraph on the restore. Twinned
  copies: none found.
