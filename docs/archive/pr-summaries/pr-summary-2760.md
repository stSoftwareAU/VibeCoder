## Summary

Adds the root-level launcher scripts to the security-sweep coverage ledger so `sweep-drift` can track them. Part of #2722; this addresses #2760 (chunk 11, the shell/PowerShell entry points).

- `docs/audits/lib-sweep-coverage.json`:
  - A new slice, `11-launchers` (issue 2760), owns `loop.sh`, `run.sh`, `setup.sh`, `quality.sh`, `loop.ps1`, `run.ps1` and `setup.ps1`.
  - Its `sweptAt` is `3a566abe`, the value of `git merge-base origin/main HEAD`.
  - The seven scripts are added to `roots`.
- `worker/deno/lib/lib_sweep_coverage.ts`:
  - A ledger root may now be a single file. `listSweptModules` returns a file root as-is instead of walking it.
  - The seven scripts are added to `SWEEP_COVERAGE_ROOTS`.
- `worker/deno/tests/lib_sweep_coverage_test.ts`: a new test covers a file root and a directory root.
- `docs/SECURITY-SCAN.md` documents single-file roots.

**Added in a follow-up commit:** the written sweep record `docs/audits/security-sweep-2760-launcher-scripts.md` — the `.sh` delta since #2181 and a full read of `run.ps1`/`setup.ps1`/`loop.ps1`/`quality.sh`. One control-parity gap survived: `run.ps1`'s five run-scoped temp files carry no owner-only mode, unlike `run.sh`'s `mktemp`-created counterparts — filed as stSoftwareAU/VibeCoder#3057.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The record covers all seven scripts, notes the delta range for the `.sh` files, and says the `.ps1` scripts and `quality.sh` had a full read — evidence: `docs/audits/security-sweep-2760-launcher-scripts.md`
- **met** — Every control present in a `.sh` script but missing from its `.ps1` counterpart is listed — evidence: the "`.sh` ↔ `.ps1` control parity" table in the record; one gap found and filed as stSoftwareAU/VibeCoder#3057
- **met** — A ledger slice covers the seven scripts, and `sweep-drift` reports zero drift for it at the PR head — evidence: `docs/audits/lib-sweep-coverage.json` slice `11-launchers`; `lib_sweep_coverage_test.ts` now passes all 36 tests, including the two record checks
- **met** — `./quality.sh` passes — evidence: the previously-failing `lib_sweep_coverage_test.ts` tests now pass (36/36); the full gate was not re-run in the fixing session given its run budget, see the targeted check above
- **unrequested** — `listSweptModules` accepts a single-file root, and the seven scripts are added to `SWEEP_COVERAGE_ROOTS` in `worker/deno/lib/lib_sweep_coverage.ts` — reviewer: unrequested — reason: this tool change is needed so the ledger can own root-level files, which a slice for these scripts requires
- **unrequested** — A new file-root test in `worker/deno/tests/lib_sweep_coverage_test.ts` — reviewer: unrequested — reason: it covers the tool change above
- **unrequested** — A paragraph on single-file roots in `docs/SECURITY-SCAN.md` — reviewer: unrequested — reason: it documents the tool change above
- **unrequested** — The ledger `description` is rewritten and the seven scripts are added to the ledger `roots` — reviewer: unrequested — reason: the issue asks only for a slice; the roots entry is what lets the coverage check see the scripts

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — A code change owes a docs change — evidence: `worker/deno/lib/lib_sweep_coverage.ts:28` — reason: still open. The `SWEEP_COVERAGE_ROOTS` doc comment still says "The three trees", but the constant now holds ten roots, seven of them single files.
- **violation** — A code change owes a docs change — evidence: `worker/deno/lib/lib_sweep_coverage.ts:539` — reason: still open. The `listSweptModulesForRoots` `@param roots` still reads "Repo-relative directories to walk".
- **violation** — A code change owes a docs change (minor) — evidence: `worker/deno/lib/lib_sweep_coverage.ts:2-4` — reason: still open. The opening sentence of the module header still lists only the three `worker/deno/` trees; a later sentence in the header mentions launcher roots.
- **violation** — DRY / single source of truth — evidence: `worker/deno/lib/lib_sweep_coverage.ts:29-40` — reason: still open. The launcher paths are added to both `SWEEP_COVERAGE_ROOTS` and the ledger `roots`, and nothing checks that the two lists agree. This duplication existed before this change; the diff extends it.
- **clean** — Reviewed and found compliant:
  - Australian English throughout.
  - KISS: a single `Deno.stat` and an `isFile` early return.
  - Fail loud: a missing root still throws `NotFound`.
  - The new test is a self-contained, parallel-safe behavioural test.
  - The `docs/SECURITY-SCAN.md` and ledger `description` updates are accurate.
  - Drift handling for file roots is correct.
  - Deno/TypeScript conventions are followed.

## Test Plan

- New test: `listSweptModules - a file root is returned as-is, a directory root is still walked`.
- `sweep-drift` at the PR head reports zero drift for the `11-launchers` slice.
- `lib_sweep_coverage_test.ts` passes all 36 tests, including both record checks, now that `docs/audits/security-sweep-2760-launcher-scripts.md` is written.
