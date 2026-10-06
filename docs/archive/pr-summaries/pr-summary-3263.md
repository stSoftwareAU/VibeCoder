# PR Summary — Issue #3263: scope five whole-file drift tests to their sections

## Summary

Closes #3263

These five drift tests each read a whole doc and pinned phrases over the entire file, with no `section()` scope. The 3172, 3073 and 2952 tests loaded the issue and pr_feedback prompts with `loadPrompt` and collapsed them with `.toLowerCase().replace(/\s+/g, " ")`. The 3058 test loaded the issue prompt with `loadPrompt` and read `prompts/coding_guidelines/prompt.md` and `CODING-STANDARDS.md` with `Deno.readTextFile`, collapsing all three with `.replace(/\s+/g, " ")`. The 3015 test matched the issue, pr_feedback, ci_fix and merge_conflict prompts from `loadPrompt` as is, and collapsed only `CODING-STANDARDS.md`, which it read with `Deno.readTextFile`:

- `worker/deno/tests/prompt_docs_sweep_3172_test.ts`
- `worker/deno/tests/prompt_docs_sweep_3073_test.ts`
- `worker/deno/tests/prompt_docs_sweep_2952_test.ts`
- `worker/deno/tests/pr_claims_verified_3058_test.ts`
- `worker/deno/tests/pr_body_matches_final_diff_3015_test.ts`

That bypasses `section()` and the `DocSection` brand on `flat()`, which breaks condition 1 of CODING-STANDARDS.md § Documentation-drift tests. Each test now reads its doc with `readRepoDoc`, scopes it with `section(heading)` and flattens it with `flat()`, so a pin goes red when its rule leaves the section that owns it.

- [x] Convert the five files to `readRepoDoc` + `section()` + `flat()`
- [x] Red-check every section scope
- [x] Run `./quality.sh`: `Result: PASSED (with skipped checks)`. Only `config integration` was skipped. The run went past the 600s Bash tool cap; the harness moved it to the background and it finished there with exit 0.

## Spec

### Intent and Rationale

- A pinned phrase only proves the rule is where readers look if the test scopes it to that section. A whole-file match stays green when the rule moves anywhere else in the file.

### Essential Design Decisions

- Each pin moves to the section that actually carries it today. In `worker/deno/tests/pr_claims_verified_3058_test.ts` that splits one list across several sections: Escape Hatch, Acceptance-Criteria Closure, Blocked on another issue, Test coverage expectations, and PR Summary and Evidence.
- No test here makes a "nowhere in the file" claim, so none needed `flatWholeFile`.
- I did not add a guard test that flags an inline `.replace(/\s+/g, " ")` in test files. The issue makes it optional, and I left it out to keep the change small. It is a possible follow-up.

### Undiscoverable Facts

- `section()` returns everything up to the next heading at the same or a higher level. In `prompts/issue/prompt.md`, "## Instructions" therefore covers lines 103–297, up to `## Tool Use`, including the docs-sweep step.

## Evidence

- Docs sweep — grep: `prompt_docs_sweep_3172`, `prompt_docs_sweep_3073`, `prompt_docs_sweep_2952`, `pr_claims_verified_3058`, `pr_body_matches_final_diff_3015`, `loadPrompt`; section: `CODING-STANDARDS.md#documentation-drift-tests`; no hits. Only test files changed; no docs outside `docs/archive/` name these tests.
- `deno test -A` on the five files: 23 passed, 0 failed. `deno lint` is clean on all five.

## Test Plan

These assertions were removed or changed. Each was a whole-file load and is replaced by a section-scoped `readRepoDoc` + `section()` + `flat()`:

- `assertEquals(result.ok, true, "issue failed to load");` in `worker/deno/tests/prompt_docs_sweep_3172_test.ts` was removed. `readRepoDoc` throws on a missing file, so the load check is kept.
- `assertEquals(result.ok, true, \`${type} failed to load\`);` in the 3073, 2952, 3015 and 3058 tests was removed for the same reason.
- `const body = normalise(await load("issue"));` and `const body = normalise(await load("pr_feedback"));` in the 3073 and 2952 tests changed to `await scoped(<doc>, "Instructions" | "PR Summary File" | "Making Changes")`. This moves them to section scope.
- `const body = await load("issue");`, `const body = await load(type);` and `const body = await load("merge_conflict");` in `worker/deno/tests/pr_body_matches_final_diff_3015_test.ts` changed to `flat(section(...))`, scoped to "PR Summary File", "Making Changes", "Fixing the Failure" and "What To Do". This moves them to section scope.
- The `normalise(...)` calls in `worker/deno/tests/pr_claims_verified_3058_test.ts` (issue prompt, coding_guidelines, CODING-STANDARDS.md) changed. Each pinned phrase now asserts against the section that carries it. The pinned strings are unchanged.

These whole-file assertions were removed. #3263 requires every pin to be scoped to the section that carries it, so an assertion over the whole-file `body`, `guidelines` or `standards` string no longer holds. Each one's pinned strings are now asserted against section-scoped strings in the same test. The 3015 test keeps `assertStringIncludes(body, required)` itself — only `body`'s definition moved to `flat(section(...))` (see the "changed" bullet above); no assertion was removed there:

- Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`: `assertStringIncludes(body, required);` — #3263 scopes each pin to its section, so the whole-prompt `body` in `Issue #3058 - issue prompt demands demonstrated criteria and finished deliverables` is gone; its strings are asserted against `escapeHatch` and `acceptanceCriteriaClosure`
- Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`: `assertStringIncludes(guidelines, required);` — #3263 scopes each pin to its section, so the whole-file `guidelines` is gone; its strings are asserted against `blockedOnAnotherIssue` and `escapeHatch`
- Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`: `assertStringIncludes(standards, required);` — #3263 scopes each pin to its section, so the whole-file `standards` is gone; its strings are asserted against `testCoverageExpectations` and `prSummaryAndEvidence`

All five tests named above are tracked at the head (`git ls-files` from the repository root).

Branch outcomes: none added

`drift-pins-on-base` result: these are existing pins re-scoped, not new rules, so they are expected green on base. For example, `deno task drift-pins-on-base origin/main prompts/merge_conflict/prompt.md "What To Do" "Keep the PR summary true to the head" "superseded"` reports `ALREADY ON BASE` for both.

Red checks: each one inserts an unrelated `## Unrelated` heading directly above the pinned rule in a scratch worktree, so the rule falls outside its section. The named test went red in every case:

- `prompts/issue/prompt.md` Instructions: 3172 (`Docs sweep line as \`file:line`), 3073 (`raise the PR without that line`) and 2952 (`excluding \`docs/archive/\``) all went red.
- `prompts/issue/prompt.md` PR Summary File: 2952 (`Always: a one-line **Docs sweep**`) and 3015 (`must appear in \`git diff <base>...HEAD\``) went red.
- `prompts/pr_feedback/prompt.md` Making Changes: 3073 and 3015 (`must appear in that diff`) went red. `prompts/ci_fix/prompt.md` Fixing the Failure: 3015 went red.
- `prompts/merge_conflict/prompt.md` What To Do (3015), `CODING-STANDARDS.md` PR Summary and Evidence (3015, 3058), `prompts/coding_guidelines/prompt.md` (3058) and the issue prompt Escape Hatch (3058): all went red.

No new rule is added by this PR, so there was no new rule to apply to its own diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
