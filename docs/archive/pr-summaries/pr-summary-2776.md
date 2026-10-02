# PR Summary — Issue #2776

## Summary

Closes #2776

A PR-scoped security-tree-sweep run wrote its changed-files list with
`git diff --name-only`, which C-quotes non-ASCII paths (`"lib/caf\303\251.ts"`).
`readChangedFiles` kept the quoted line verbatim, so `splitByChangedFiles`
never matched the finding's raw path and an unbaselined finding in that file
was reported as out of scope — the check went green. The list is now written
NUL-delimited and unquoted, read on NUL, and a C-quoted line fails closed.

- [x] Workflow writes `git -c core.quotePath=false diff --name-only -z`
- [x] `readChangedFiles` splits a NUL list verbatim; rejects C-quoted lines
- [x] Workflow validator extended (positive + negative cases)
- [x] Regression tests red on base, green after
- [x] Docs updated

## Spec

### Problem

Git's default `core.quotePath=true` C-quotes any path with bytes above 0x7F
(or `"`, `\`, control characters). The sweep compared those quoted strings to
raw finding paths, so a finding in such a file silently dropped out of the
PR's blocking set.

### Change

- `.github/workflows/security-tree-sweep.yml`: the changed-files step now runs
  `git -c core.quotePath=false diff --name-only -z "$BASE_SHA" HEAD`. With
  `-z`, git emits paths verbatim with no quoting at all, NUL-terminated, so a
  newline-bearing filename cannot split an entry either.
- `worker/deno/lib/security_tree_sweep.ts` `readChangedFiles`: a list containing
  NUL is split on NUL with entries kept verbatim (no trim). A newline list is
  still accepted (local/manual use) but any line starting with `"` throws a
  `C-quoted` error naming the list and the fix command — fail closed rather
  than scope findings out.
- `worker/deno/tests/security_tree_sweep_workflow_test.ts`: validator helper
  `writesUnquotedChangedFiles` requires `-c core.quotePath=false`,
  `--name-only`, `-z` and the redirect on every line writing the list.

### Out of scope

CodeQL SARIF URIs may arrive percent-encoded (`caf%C3%A9.ts`), a separate root
cause on the finding side — filed as follow-up #3053 (unverified against a
real CodeQL run).

## Evidence

Security-fix tests (each fails on base `3a566abe`, passes after the fix):

- `worker/deno/tests/security_tree_sweep_test.ts::sweep: a finding in a non-ASCII changed file blocks the PR run (Issue #2776)` — primary regression: base put the finding in `outOfScopeRows`.
- `worker/deno/tests/security_tree_sweep_test.ts::sweep: readChangedFiles - a NUL-delimited list keeps non-ASCII and spaced paths verbatim (Issue #2776)` — base read the whole buffer as one entry.
- `worker/deno/tests/security_tree_sweep_test.ts::sweep: readChangedFiles - a git C-quoted line fails closed (Issue #2776)` — base accepted the quoted line silently.
- `worker/deno/tests/security_tree_sweep_workflow_test.ts::sweep workflow - the changed-files list is NUL-delimited and unquoted (Issue #2776)` — base workflow lacked `-z`/`core.quotePath=false`; three negative variants (old line, `-z` only, `quotePath` only) are rejected.

Red on base: library tests `0 passed | 3 failed`; workflow tests 2 failed.
After: `ok | 66 passed | 0 failed` across both files.

The original trigger is closed with no trivial bypass: `-z` disables all path
quoting in git's output (not only the non-ASCII case), the validator pins
every write of the list to that form, and should a quoted list ever reach the
reader again it throws instead of scoping findings out.

Docs sweep: `docs/SECURITY-TREE-SWEEP.md` (PR run paragraph) updated; doc
comments on `readChangedFiles` and `SweepOptions.changedFilesPath` updated;
grep for `changed-files.txt`/`--changed-files` found no other prose describing
the list format.

<!-- vibe-quality-gate-skipped reason="./quality.sh exceeded the 590s tool cap during the full deno test stage; every check reported before the cut passed (completeness, workflow hygiene, markdownlint, semgrep, mermaid, chokepoints). Targeted deno fmt --check, deno lint, deno check and both sweep test files pass on the changed files." -->

## Reproduction

- **Symptom:** a PR adding an unbaselined finding in `lib/café.ts` passes the
  PR-scoped sweep because the changed-files list holds `"lib/caf\303\251.ts"`.
- **Status:** verified — reproduced by the regression tests above against base.
- **Regression test:** `worker/deno/tests/security_tree_sweep_test.ts::sweep: a finding in a non-ASCII changed file blocks the PR run (Issue #2776)`

## Test Plan

```bash
cd worker/deno
deno test --allow-all tests/security_tree_sweep_test.ts tests/security_tree_sweep_workflow_test.ts < /dev/null
```

## Security self-check

- [x] Input validation: the changed-files list is parsed strictly; quoted lines rejected.
- [x] Secrets: none staged.
- [x] Injection surface: no new shell interpolation; `$BASE_SHA` usage unchanged.
- [x] Error handling: failure message names the list path and fix command only.
- [x] Dependencies: none added.
