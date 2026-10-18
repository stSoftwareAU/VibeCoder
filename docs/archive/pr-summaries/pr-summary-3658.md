## Summary

Whole-tree security sweep `falsePositives` entries must now say where the
defence is. Each entry needs an `evidence` list of repository-relative
`path:line` citations of the defence, type constraint or non-attacker origin
that eliminates the finding. Every citation must resolve to a regular file
inside the swept tree, at a line inside that file. Each entry also needs a
`line` or a `snippet`, so no entry suppresses a whole file. Any breach is a
baseline error, and the sweep fails. `accepted` entries are unchanged. The
committed `.github/security-tree-sweep-baseline.json` is migrated, and
`docs/SECURITY-TREE-SWEEP.md` documents the new field. Closes #3658.

## Spec

### Intent and Rationale

- Before this change, a PR whose own file tripped the sweep could add a
  10-character `falsePositives` entry and turn the gate green. That is the
  "loosen the check" route #3512 documents. VulnHunter's Phase 2b rule says
  a finding is eliminated only by citing the file:line that eliminates it.
- The check runs inside `parseSweepBaseline`, so a bad entry follows the
  existing path for baseline errors: the run fails and the entry suppresses
  nothing. No new reporting path was added.

### Essential Design Decisions

- `parseSweepBaseline(json, countLines)` takes the tree-line counter as a
  **required** argument. With a default, a caller could leave the counter out
  and skip the check, which would fail open.
- `countTreeLines` checks the path shape first. Absolute paths, backslashes,
  NUL, and empty, `.` or `..` segments are refused before any filesystem
  access. It then resolves the path with `realPathSync`, confines it with the
  existing `isAtOrAbove` owner from `host_path_style.ts`, and requires a
  regular file. Any failure is `null`, which the parser reports as "does not
  resolve". A citation that resolves to nothing is never treated as passing.
- Evidence is validated but not stored on the parsed entry, because nothing in
  production reads it after parsing.
- An unlocated finding has no `line` or `snippet`, so it can no longer be a
  false positive. The filed issue body says so and points to `accepted`.

### Undiscoverable Facts

- The migrated `line` and `snippet` anchors come from the latest
  `security-tree-sweep` CI artefact, run 38474898022 (download it with
  `gh run download 38474898022 -n security-tree-sweep`). Its report placed the
  three `export_branding_test.ts` clusters at 57, 61 and 125,
  `export_scrub_gate_test.ts` at 159, `planning_processor_test.ts` at 2923,
  `planning_processor.ts` at 244 and `merge_conflict_deferrals.ts` at 393.
- Citations are pinned to lines. An edit that shortens a cited file below the
  cited line turns the baseline into an error until someone re-points the
  citation. That is the intended fail-closed direction.

## Evidence

Backend/CLI change; no UI files touched.

```mermaid
flowchart LR
    B[baseline JSON] --․> P[parseSweepBaseline]
    P --․> V{falsePositives entry}
    V --․>|no line and no snippet| E[baseline error]
    V --․>|evidence missing / malformed| E
    V --․>|countTreeLines: no file in tree,<br/>escapes via .. or symlink| E
    V --․>|line past end of file| E
    V --․>|all citations resolve| K[entry suppresses its finding]
    E --․> F[sweep fails, suppresses nothing]
```

- **Real baseline against the real tree.** I ran the sweep locally on the CI
  artefact's semgrep JSON and CodeQL SARIF:
  `deno run -A mod.ts security-tree-sweep --repo ../.. --semgrep-json … --codeql-sarif … --sources semgrep,codeql`.
  The report shows 12 `false positive (baselined)` rows, with no stale entries
  and no baseline errors. The run listed 5 unbaselined findings (in
  `completion_phase.ts`, `shared_clone_repair_history.ts`,
  `pre_push_gate_cli_test.ts`, `prompt_best_practices_checklist_test.ts` and
  `summary_rule_gate_retry_test.ts`). None of these files is in this diff, so
  the PR gate's changed-files scope does not block on them.
- **Issue numbers cited and looked up this run:** #3658: Security tree sweep:
  falsePositives baseline entries must cite the eliminating defence as a
  resolvable path:line. #3512: Fleet PRs silently edit, loosen or delete an
  unrelated failing check to turn the gate green. #3657: Security-fix gate:
  replace the agent-written trigger-closed prose with an independent
  read-only verifier verdict (open). #3659: Security-fix gate: execute the
  named test against base production files and require red→green (landed on the base branch).
- **Docs sweep** — grep: `falsePositives`, `parseSweepBaseline`,
  "with a reason", "Optional line anchor", `MIN_REASON_LENGTH`; section:
  `docs/SECURITY-TREE-SWEEP.md#the-baseline` (plus "Triage and filing");
  siblings: `snippet`, `reason`; updated: `docs/SECURITY-TREE-SWEEP.md`,
  `docs/security/vulnhunter-methodology-evaluation.md`,
  `.github/security-tree-sweep-baseline.json` (`note`), and doc comments in
  `worker/deno/lib/security_tree_sweep.ts` (`SweepBaselineEntry.line`,
  `SweepBaseline.falsePositives`, `parseSweepBaseline`). Hits left in place:
  `docs/SECURITY-TREE-SWEEP.md:55` is still true because it says only that
  baselined entries record a reason. `docs/SECURITY-TREE-SWEEP.md:270` is
  still true because it is a dated triage record.

## Acceptance Criteria

<․!-- vibe-spec-review inputs="diff+issue-body" --․>

- **met** — A `falsePositives` entry without `evidence`, or with an evidence path that does not resolve, is a baseline error and the sweep fails. — evidence: `worker/deno/tests/security_tree_sweep_test.ts::falsePositives - an entry without evidence is refused (Issue #3658)`, `::falsePositives - evidence that does not resolve in the tree is refused (Issue #3658)`, `::sweep: a falsePositives entry whose evidence is absent from the tree fails the run (Issue #3658)` — reviewer: met
- **met** — A `falsePositives` entry without `line` or `snippet` is a baseline error. — evidence: `worker/deno/tests/security_tree_sweep_test.ts::falsePositives - an entry with neither a line nor a snippet is refused (Issue #3658)`, `::sweep: a falsePositives entry with no line or snippet fails the run (Issue #3658)` — reviewer: met
- **met** — `accepted` entries are unchanged (they are real risks, not eliminations). — evidence: `worker/deno/tests/security_tree_sweep_test.ts::accepted - an entry needs no evidence and no anchor (Issue #3658)`; the `accepted` list in `.github/security-tree-sweep-baseline.json` is unchanged — reviewer: met
- **met** — `docs/SECURITY-TREE-SWEEP.md` documents the new field. — evidence: `docs/SECURITY-TREE-SWEEP.md` "The baseline" rules and "Triage and filing" step 2 — reviewer: met
- **unrequested** — the filed issue body's suggested triage JSON now carries `evidence` (and `snippet` when known), says an unlocated finding goes under `accepted`, and the report's "New findings" text asks for `evidence` — reviewer: unrequested — reason: without it the sweep's own template would suggest entries the new parser rejects
- **unrequested** — `docs/security/vulnhunter-methodology-evaluation.md` now records that #3658's check ships, and its section 3 baseline description is in the past tense — reviewer: unrequested — reason: the report described the pre-#3658 behaviour as present, which this change makes false
- **unrequested** — path hardening beyond "does not exist": `..`, symlink escape, backslash and NUL are refused, and quoted citations are truncated to 120 characters — reviewer: unrequested — reason: required by the repository's Path Confinement standard for a new path guard, and keeps a hostile value out of the report
- **unrequested** — baseline entries re-anchored (`planning_processor.ts` 139→244, `merge_conflict_deferrals.ts` 394→393) and the `export_branding_test.ts` entry split into three — reviewer: unrequested — reason: the issue asks for the entries to be migrated; each now anchors the cluster the sweep actually reports
- **unrequested** — `classifyClusters` no longer lets a snippet-only entry (no `line`) suppress a finding that has no snippet (`snippetOnlyUnanchored`) — reviewer: unrequested — reason: without it, the AC2 snippet anchor would still let a snippet-only entry suppress a snippetless finding anywhere in the file, which is the whole-file suppression AC2 forbids
- **unrequested** — `worker/deno/tests/content_tooling_env_test.ts` runs its environment canary in a child process (`runInChild`) — reviewer: unrequested — reason: the diff-scoped mutation gate runs tests under `env -i`, so the canary must set its own environment in a child rather than rely on the parent's (and Issue #880 forbids `Deno.env.set` in tests)

## Standards Review

<․!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" --․>

- **violation** — Every outcome of a branch needs a test: the backslash and NUL operands of `isRepoRelativePath` had no test — evidence: `worker/deno/lib/security_tree_sweep.ts:1191` — reason: fixed in this diff (backslash and NUL cases added; deleting either operand turns the malformed-citation test red)
- **violation** — Call the existing owner: the confinement check was hand-rolled instead of calling `isAtOrAbove` — evidence: `worker/deno/lib/security_tree_sweep.ts:1289` — reason: fixed in this diff (`countTreeLines` now calls `isAtOrAbove` with `pathStyleFor`, as `codebase_map.ts` does)
- **violation** — A code change owes a docs change: the methodology report's section 3 still described the old behaviour in the present tense — evidence: `docs/security/vulnhunter-methodology-evaluation.md:159` — reason: fixed in this diff (now "had at evaluation time (before #3658)", past tense)
- **clean** — Australian English; Path Confinement (shape check before access, realpath, confine, act on the resolved path; negative `..`, `missing/..` and symlink tests); fail loud (baseline errors are fatal); nothing exists only for a test (`countTreeLines` and `TreeLineCounter` are read by `runSecurityTreeSweep`); no removed assertions in `security_tree_sweep_test.ts` (the #1473 test's `"rule": "SEC-8d02435d8683"` assertion moved into its `fixedBody` check, and its `unknown` entry moved from `falsePositives` to `accepted` because AC2 makes an unanchored false positive invalid); dead code removed rather than exempted (the unreachable snippet operand of `snippetOnlyUnanchored`); temp dirs via `Deno.makeTempDir`; no hidden paths beyond `.github/`; regex on untrusted text is the digit-only `CITATION_LINE`, with a 100,000-character hostile case. Review-enforced rules checked: insertion placement, import merging, no unrequested refactor.

## Test Plan

- `worker/deno/tests/security_tree_sweep_test.ts` — 16 new tests named
  `(Issue #3658)` (14 `Deno.test("…")` calls plus the two symlink tests,
  "countTreeLines - a symlink pointing outside the tree is null (Issue #3658)"
  and "countTreeLines - a symlink pointing inside the tree is counted (Issue
  #3658)"). The file has 77 `Deno.test` calls against 61 on the base branch.
  They cover missing evidence, unresolved evidence, a line past the end (with
  the last line accepted), malformed citations, how a citation is quoted in
  the error (a long one truncated to 120 characters), the
  line/snippet anchor, `accepted` left unchanged, `countTreeLines`, two
  end-to-end sweep runs and the issue-body template. They also include these
  traversal cases:
  - `../outside.ts`
  - `sub/../file.ts`
  - `missing/../file.ts`
  - a symlink pointing out of the tree
  - `missing/../linkdir/file.ts`, where `linkdir` is a symlinked directory
    pointing out of the tree
  - a symlink pointing inside (positive control)
- Each refusal test asserts its specific error text, and has a control that
  makes only the probed value legal and expects no errors.
- **Regression tests, failing before the fix and passing after it.** Added
  `worker/deno/tests/security_tree_sweep_test.ts::falsePositives - an entry without evidence is refused (Issue #3658)`
  and
  `worker/deno/tests/security_tree_sweep_test.ts::sweep: a falsePositives entry whose evidence is absent from the tree fails the run (Issue #3658)`.
  They reproduce the flaw: an uncited `falsePositives` entry turns the sweep
  green. Both fail against the unfixed code and pass after the fix. Before the
  quoting test was added, I ran the 15 `(Issue #3658)` tests then on the
  branch against the base branch's
  `worker/deno/lib/security_tree_sweep.ts`, with only a stub
  `countTreeLines` export added so the module loads. 12 failed, including
  both tests named above and
  `::falsePositives - an entry with neither a line nor a snippet is refused (Issue #3658)`.
  The 3 that passed are controls that expect only `null` or an unchanged
  `accepted` list. On this branch's code all 16 pass.
- **Original trigger closed, no trivial bypass.** The original trigger was a
  short `falsePositives` entry, with only a `reason`, that suppresses a
  finding. `parseSweepBaseline` now rejects that entry. A baseline error
  fails the run and the entry suppresses nothing. The counter is a required
  argument, so no caller can skip the check. There is no trivial bypass:
  - Citing a made-up path fails: `countTreeLines` returns `null`, which is
    reported as "does not resolve".
  - Citing a path outside the tree fails: `..`, absolute paths, backslashes,
    NUL and symlink escapes are all refused.
  - Citing a line past the end of a real file fails.
  - Leaving out `line` and `snippet` to cover the whole file fails, both in
    the parser and in `classifyClusters` (`snippetOnlyUnanchored`).
  - The remaining route is to cite a real file:line. That is the evidence the
    issue asks for, and a reviewer can check it.
- Existing tests: every `parseSweepBaseline` call now passes a counter, and
  the valid `falsePositives` fixtures gained `evidence`. Fixtures that had no
  anchor gained a `line`: `gone/away.ts:1`, plus `worker/lib/files.ts:40` and
  `.github/workflows/ci.yml:7`, both matching `SEMGREP_JSON`. In "baselining
  one unlocated finding leaves the others reported (Issue #1473)", the
  `unknown` entry moved from `falsePositives` to `accepted`, because the
  issue's line/snippet rule makes an unlocated false positive invalid. All of
  that test's assertions are kept, and one was added for the
  "goes under `accepted`" note. Its `"rule": "SEC-8d02435d8683"` assertion
  moved into the `fixedBody` check rather than being removed. In
  `security_tree_sweep_test.ts` no assertion is removed from an existing
  test; the `content_tooling_env_test.ts` rewrites are listed below.
- Moved `assertStringIncludes( buildSweepIssueBody(fixed, ".github/security-tree-sweep-baseline.json"), '"rule": "SEC-8d02435d8683"', "an unlocated finding must be triaged by its own id, not by its family", );` to `worker/deno/tests/security_tree_sweep_test.ts::baselining one unlocated finding leaves the others reported (Issue #1473)`
  (it now asserts on the same `buildSweepIssueBody` result, held in `fixedBody`).
- New guard test: "falsePositives - a snippet-only entry never suppresses a
  finding with no snippet (Issue #3658)".
- Mutation check on changed lines. Each of these mutants now turns a test
  red. I applied each one by hand and restored the file afterwards:
  - `worker/deno/lib/security_tree_sweep.ts:1199` (negate the
    `typeof value === "string"` ternary in `quoteCitation`) and `:1203`
    (return `undefined`): killed by
    `worker/deno/tests/security_tree_sweep_test.ts::falsePositives - a citation error quotes the citation, truncating a long one (Issue #3658)`.
    It asserts that a short citation is quoted in full in the error, and
    that a 205-character one is cut to its first 120 characters plus `...`.
    Each mutant made only the named regression fail. Negating the `:1200`
    truncation ternary as well turned 2 red.
  - `worker/deno/lib/security_tree_sweep.ts:1957` (delete the `""` before
    the unlocated note) and `:1958` (delete its first line): killed by
    `worker/deno/tests/security_tree_sweep_test.ts::baselining one unlocated finding leaves the others reported (Issue #1473)`.
    That test now also asserts the whole note text, set off from the JSON
    block by a blank line. Each deletion made only the named regression fail.
- `content_tooling_env_test.ts` assertions rewritten, not kept verbatim. The
  mutation gate runs tests under `env -i`, so the worker's own environment
  is empty. Then the old `Object.keys(Deno.env.toObject())` positive control
  is untrue, because there is nothing to inherit. Issue #880 forbids
  `Deno.env.set` in tests. Each check therefore now runs the real runner in a
  child `deno eval` process (`runInChild`) that is handed CANARY. It compares
  the child's output against the names that process was handed
  (`report.handed`). The same properties are asserted, in the same two tests:
  "markdownlint - the linter runs with a built environment, not the worker's"
  and "security tree sweep - scanners run with a built environment, not the
  worker's".
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assert( inheritable.length > 0, `${site}: the worker's own environment carries nothing outside the ` + "allowlist, so this test cannot tell a built environment from an " + "inherited one", );` — under `env -i` the worker's own environment carries nothing, so the old message is untrue. It is replaced in `assertBuiltEnvironment` by the same `inheritable.length > 0` check over `handed`, with the message "the runner was handed nothing outside the allowlist".
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertEquals( inheritable.filter((name) => childNames.has(name)), [], `${site}: these names were inherited rather than built from the allowlist`, );` — it is still in `assertBuiltEnvironment`, word for word. `inheritable` is now computed from `handed` rather than this process's environment, and every call site changed, so the gate counts it as removed.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertEquals( isCredentialVariableName(name), false, `${site}: ${name} reached a content-processing child`, );` — it is still in `assertBuiltEnvironment`, word for word. It is listed only because the helper's signature and call sites changed.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assert( childNames.has("PATH"), `${site}: PATH must survive — the tool cannot run without it`, );` — it is still in `assertBuiltEnvironment`, word for word. It is listed only because the helper's signature and call sites changed.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assert(runner !== null, "the stub binary must be detected");` — the runner now runs in the child, so the parent cannot see `runner`. It is replaced by `assert(report.stdout !== null, "the stub binary must be detected")`, because the child returns `stdout: null` when detection fails.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertBuiltEnvironment(result.stdout, "markdownlint runner");` — replaced by `assertBuiltEnvironment(report.stdout, report.handed, "markdownlint runner")`. The helper now takes the names the child was handed, because the parent's environment is empty under `env -i`.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertBuiltEnvironment( await Deno.readTextFile(capture), "markdownlint probe", );` — replaced by the same call with `report.handed` as its second argument, for the same reason.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertEquals(result.code, 0);` — replaced by `assertEquals(report.code, 0)`. The scanner's exit code now comes back from the child as `report.code`.
  - Removed from `worker/deno/tests/content_tooling_env_test.ts`: `assertBuiltEnvironment(result.stdout, "security tree sweep runner", [ "DOCKER_HOST", "XDG_RUNTIME_DIR", ]);` — replaced by `assertBuiltEnvironment(report.stdout, report.handed, "security tree sweep runner", ["DOCKER_HOST", "XDG_RUNTIME_DIR"])`. The extra names are the same, and `handed` is added.
- Red checks: each new guard was broken on its own and the named test went
  red; see the branch-outcomes list below. For #1473, I set the
  unlocated-note condition to false and the test went red. Recorded per change:
  - `snippetOnlyUnanchored` guard removed from `classifyClusters` → 75 passed,
    1 failed (the guard test).
  - its `entry.line === undefined` operand forced true → 3 failed.
  - its `cluster.snippet === undefined` operand forced true → 1 failed (the
    guard test's positive control). The former snippet operand was
    unreachable once the parser refused an entry with neither anchor, so it
    was removed rather than exempted.
  - `content_tooling_env_test.ts` (2 tests): `runInChild` given `env: {}`
    (the canary dropped) → 0 passed, 2 failed. Unmutated head: 2 passed,
    0 failed.
- `deno task test:unit tests/security_tree_sweep_test.ts < /dev/null` on the
  final head: `ok | 77 passed | 0 failed`. The mutation-check counts above are out of
  these 77. The `snippetOnlyUnanchored` red-check counts were taken before
  the quoting test was added, so they are out of 76. The other importers of
  `security_tree_sweep.ts`: 24 passed. `deno fmt --check`, `deno lint` and
  `deno check` on the changed files are clean.
- `./quality.sh < /dev/null`: **Result: PASSED (with skipped checks)**, with
  only `config integration` skipped. That run came after the review fixes, but
  before this retry added the quoting test and the note assertion. Only
  `tests/security_tree_sweep_test.ts` changed since then, and the run above
  covers it. The worker re-runs the quality gate.

<․!-- vibe-branch-outcomes --․>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
