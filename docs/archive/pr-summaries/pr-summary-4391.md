## Summary

The review gate keeps a sent-back PR at `awaiting-fix` when a base merge and
workflow bump only change its JSON or TOML `version` line. Unchanged context is
accepted only in a complete single hunk; every other edit still receives a fresh
review. Closes #4391.

## Spec

### Intent and Rationale

- Avoid repeating an expensive review while the previously reported findings
  remain untouched, including repositories that store versions in manifests.
- Keep the exception narrow enough that dependency upgrades, other edits and
  changes addressing a finding on the manifest still reach the reviewer.

### Essential Design Decisions

- Accept a bare numeric version, JSON `"version": "..."` or TOML
  `version = "..."`. The removed and added lines must otherwise match exactly.
- Require exactly one adjacent removal/addition pair and unchanged context;
  both hunk counts must match the supplied lines. Additional hunks, truncation
  and newline markers fail closed to a fresh review.
- Retain the existing two-to-four-component numeric comparison using `BigInt`,
  the exact-head finding requirement, and all other own-diff safeguards.

### Undiscoverable Facts

- The two real fleet PRs in the issue are anonymised. Their private diffs were
  not accessed; the supplied JSON example was reproduced with local git.
- `git diff --no-index old.json new.json` and its TOML equivalent produced the
  context-bearing hunk shapes used by the regression fixtures: context lines
  have a leading space and contribute to both range counts.

## Evidence

Reproduced before the fix: the new manifest regression returned a fresh review
(`null`) instead of `awaiting-fix`. After the fix, all 28 tests in the gate and
upkeep suites passed, then all 255 `review_fleet_prs*_test.ts` tests passed.
Formatting, lint, Markdown lint and the standalone gate type-check passed. The
manifest checks passed: 867 tests, 1 ignored. The PR-summary check reported no
blocked gates; closure and independent-review checks were not checked without
an issue-body file, and reproduction status was not checked without labels.

A corpus check covered 14 JSON/JSONC/TOML file patches from the latest 20 base
commits and the two observed git manifest-bump patches. The base classifier had
zero false skips and two missed version bumps; the updated classifier had zero
false skips and zero missed version bumps in those 16 cases. This is local
validation; no production review-log trend has been observed yet.

Read and updated the canonical review manual's rule 8 and
`references/edge-cases.md` section **Version-only re-bumps**. The gate's module
and matcher comments now describe the same contract. Searches for
`isVersionIncrement`, `ownDiffUnchanged`, `bare version` and `version-only`
found one implementation: the root `gate.ts` is a forwarding shim. The local
`.agents` skill is not tracked in this repository. No implementation twin was
found. This backend change has no UI evidence.

## Test Plan

- Added two tests to `review_fleet_prs_gate_2675_test.ts`: JSON/TOML bumps,
  including numeric components beyond safe floating-point precision, produce
  `awaiting-fix`; a 25-case negative table keeps other keys, dependency pins,
  adjacent edits, formatting changes, malformed or truncated patches,
  unsupported versions and manifest findings reviewable.
- Existing test assertions are unchanged. Existing bare-version, file-status,
  incomplete-comparison and exact-head finding checks remain in the focused
  gate/upkeep run.
- The corpus check above exercises `ownDiffUnchanged` on both the base and
  updated implementation using real git patch shapes.

## Merge verification

Full quality execution and independent review remain pending on the combined
PR. No CI result is claimed by this isolated implementation summary.
