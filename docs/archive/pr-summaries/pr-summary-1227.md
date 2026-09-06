# A variable binary name no longer evades the gh/git spawn chokepoints

## Summary

The `gh` and `git` spawn chokepoint quality checks matched a **literal** binary
name, so a module written as `new Deno.Command(cmd[0]!, …)` whose callers hand
it `["gh", "api", …]` was a direct spawn the gate reported as a clean tree.
Both checks now also flag a **variable** binary, and every module the extended
scan surfaced routes through its chokepoint. Closes #1227.

What changed:

- `spawn_chokepoint_scan.ts` — new `scanContentForVariableBinarySpawn()` plus a
  `variableBinary` option on the directory walk. A variable-binary spawn is a
  violation only when the module itself names the guarded binary at the head of
  an argv literal and does **not** import the chokepoint, so a generic
  subprocess helper that never mentions `gh`/`git` stays clean.
- `gh_spawn_chokepoint_check.ts` / `git_spawn_chokepoint_check.ts` — wire the
  new half in, each with its own argv, delegation and false-positive rules.
- Five `gh` evasions now delegate to `spawnGh`: `language_detector.ts` and
  `workflow_auditor.ts` (the two the issue names), plus `repo_visibility.ts`,
  `recent_activity.ts` and `software_updates.ts` (`gh --version`,
  `gh extension list|install`), which the extended scan found in the same shape.
- Three `git` evasions now delegate to `runGitCommand`: `benchmark.ts`,
  `dependency_lock_regen.ts` and `security_tree_sweep.ts` — the issue's "the
  same reasoning applies to the sibling `git` chokepoint".
- Docs: `SECURITY.md`, `docs/AGENT-ACCOUNTABILITY.md` and the sweep ledger
  `docs/audits/security-sweep-1214-subprocess-argv.md` (whose "Residual risk in
  the new gate" section named this gap) record the closure and the residual
  risk that remains.

```mermaid
flowchart LR
    S["worker/deno/lib + commands<br/>source files"] --> L["literal scan<br/>new Deno.Command(\"gh\", …)"]
    S --> V["variable scan (new)<br/>new Deno.Command(cmd[0], …)"]
    V --> Q1{"module names the<br/>binary in an argv literal?"}
    Q1 -->|no| C["clean — generic runner"]
    Q1 -->|yes| Q2{"imports the<br/>chokepoint module?"}
    Q2 -->|yes| C
    Q2 -->|no| F["VIOLATION — gate fails"]
    L --> F
    style F fill:#a4161a,stroke:#6a040f,color:#fff
    style C fill:#2d6a4f,stroke:#1b4332,color:#fff
```

## Evidence

Backend/CLI change with no web interface to screenshot. The evidence is the
gate and the tests.

**The gate sees it now.** Running the extended scanners over `worker/deno/lib`
and `worker/deno/commands` before the module fixes reported eight violations
the previous gate reported as a clean tree:

```
GH:  language_detector.ts:94, recent_activity.ts:94, repo_visibility.ts:54,
     software_updates.ts:368, workflow_auditor.ts:102
GIT: benchmark.ts:83, dependency_lock_regen.ts:319, recent_activity.ts:94,
     security_tree_sweep.ts:1606
```

After the fixes both scans return `[]`, and `./quality.sh` reports
`gh spawn chokepoint PASSED` / `git spawn chokepoint PASSED`.

**Regression linkage (fails red, then green).** With the scanner extension in
place and the eight module fixes stashed, three tests fail:

```
scanDirectoriesForGhSpawn - the worker tree has no direct gh spawns ... FAILED
scanDirectoriesForGitSpawn - the worker tree has no direct git spawns ... FAILED
language_detector - the default runner routes gh through the shared chokepoint ... FAILED
```

Restoring the fixes turns all three green. The added test
`worker/deno/tests/language_detector_test.ts::language_detector - the default runner routes gh through the shared chokepoint`
is the direct reproduction: it drives `detectRepoLanguages()` with **no**
`runCommand` override — the production default — and asserts the chokepoint's
injectable runner received `api repos/owner/repo/contents/` and
`api repos/owner/repo/languages`. Against the unfixed code the chokepoint runner
is never called (the module spawns `gh` itself) and the assertion fails; after
the fix it passes.

**Original trigger closed, no trivial bypass.** The trigger was a `gh` spawn
whose binary is not the string literal `"gh"`. Statically over the changed code
path: `createDefaultRunCommand` in `language_detector.ts`, `workflow_auditor.ts`
and `repo_visibility.ts`, `defaultRunner` in `recent_activity.ts` and
`runWithTimeout` in `software_updates.ts` all branch on `cmd[0] === "gh"` before
any `Deno.Command` is constructed, so no argv reaching those runners can start a
`gh` process outside `spawnGh` — the allowlist, timeout and audit journal now
run for every one of them. The equivalent spelling of the bypass (writing a new
variable-binary runner) is what the gate now fails the build on: the check no
longer depends on the binary being a literal, only on the module naming it in
its own argv. The two remaining escapes are stated rather than hidden — a module
that imports the chokepoint is exempt on its other spawns, and the two
documented false positives (`secrets_history_scan.ts`, `claude_runner.ts`, which
name `git` as tool *data*) are allowlisted — both recorded in
`git_spawn_chokepoint_check.ts` and in the sweep ledger.

## Test Plan

Added (all names below appear in this branch's diff):

- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - flags a variable binary in a module that names the guarded binary`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - a generic runner that never names the binary is clean`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - a module that delegates to the chokepoint is clean`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - honours the false-positive allowlist`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - a literal binary is left to the literal pattern`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanContentForVariableBinarySpawn - ignores comments naming the binary`
- `worker/deno/tests/spawn_chokepoint_scan_test.ts::scanDirectoriesForDirectSpawn - variableBinary rules are applied during the walk`
- `worker/deno/tests/gh_spawn_chokepoint_check_test.ts::scanContentForGhSpawn - flags a variable binary handed a gh argv literal`
- `worker/deno/tests/gh_spawn_chokepoint_check_test.ts::scanContentForGhSpawn - a variable binary that delegates gh to the chokepoint is clean`
- `worker/deno/tests/gh_spawn_chokepoint_check_test.ts::scanContentForGhSpawn - a generic runner that never names gh is clean`
- `worker/deno/tests/git_spawn_chokepoint_check_test.ts::scanContentForGitSpawn - flags a variable binary handed a git argv literal`
- `worker/deno/tests/git_spawn_chokepoint_check_test.ts::scanContentForGitSpawn - a variable binary that delegates git to the chokepoint is clean`
- `worker/deno/tests/git_spawn_chokepoint_check_test.ts::scanContentForGitSpawn - an allowlisted module naming git as tool data is clean`
- `worker/deno/tests/language_detector_test.ts::language_detector - the default runner routes gh through the shared chokepoint`
- `worker/deno/tests/workflow_auditor_test.ts::workflow_auditor - the default runner routes gh through the shared chokepoint`

Existing coverage that now enforces more: the two whole-tree tests
`scanDirectoriesForGhSpawn - the worker tree has no direct gh spawns` and
`scanDirectoriesForGitSpawn - the worker tree has no direct git spawns` scan for
variable binaries as well as literal ones.

Also run green: the suites of every module touched — `benchmark_test.ts`,
`dependency_lock_regen_test.ts`, `recent_activity_test.ts`,
`recent_activity_cache_test.ts`, `repo_visibility_test.ts`,
`security_tree_sweep_test.ts`, `security_tree_sweep_workflow_test.ts`,
`software_updates_test.ts`, `workflow_auditor_local_path_test.ts`,
`workflow_auditor_local_path_fallback_test.ts`, `quality_gate_test.ts` and
`quality_gate_docs_consistency_test.ts` (210 + 107 tests, 0 failures).

## Quality gate

`./quality.sh` was run in full. Every check passes — `gh spawn chokepoint`,
`git spawn chokepoint`, `semgrep`, `deno lint`, `deno type check`, `deno fmt`,
`markdownlint`, `mermaid` — except `deno tests`, which fails on **one**
pre-existing test unrelated to this change:

```
every worker/deno/lib module is claimed by exactly one sweep slice ... FAILED
  - worker/deno/lib/gh_body_file_io.ts
  - worker/deno/lib/gh_timeout.ts
```

`docs/audits/lib-sweep-coverage.json` was never updated when PRs #1304 and
#1319 added those two modules. Verified failing at `HEAD~1` of this branch in a
clean worktree, so it predates this work; adding the paths to the "closing pass"
slice would falsely claim a security sweep read them. Filed as
stSoftwareAU/VibeCoder#1325.
