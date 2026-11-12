# PR Summary — Issue #4991

## Summary

Rewrote the #3444 style-literal rule around what fleet tests actually pin. The
rule was framed by where a colour or `calc()` value lives. Fleet tests instead
kept asserting a class or tag name, often for a look a component unit test
cannot see. `CODING-STANDARDS.md` (**Choosing assertions → UI / PWA**) and rule
2 of `prompts/issue/prompt.md` now carry the issue's shorter passage, which
opens **Do not pin incidental appearance choices.** The Test Plan quote and
removed-line obligations are gone. The `prompts/pr_feedback/prompt.md` copy
(**A replaced style literal is removed, not joined.**) is deleted, and the docs
test now pins the new wording.

The pre-push gate blocked the first attempt. Its unit-test list includes tests
that mention a changed prompt type, and one of them,
`worker/deno/tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts`, made real
`gh` calls and ran over the one-second unit budget. The cause is in
`ensureAutoMerge`: its `attemptMerge` never passed the sweep's gh runner to
`enableAutoMerge`, so an injected runner did not reach the merge. It now passes
`ghCommandFn: gh`. The #4243 wiring test's fake now answers the milestone
lookups that reach it. Closes #4991.

## Spec

### Intent and Rationale

- Eleven of the twelve recurrences asserted a class or tag name in a component unit test. The old rule listed "class name" sixth among value kinds and offered only browser-side replacements, so it gave a unit test nothing to assert in place of the class.
- The new passage says a unit test cannot see weight, colour, wrapping or layout. For a requested visual outcome, the class that produces the look is not a test of it, and the browser check described next measures the result.

### Essential Design Decisions

- The passage is the issue's text verbatim, rewrapped to each file's indentation. It starts on its own line after "required." in the issue prompt and after "behaviour test." in `CODING-STANDARDS.md`.
- No gate, check, Test Plan line or summary obligation is added. The pr_feedback copy is removed because **Every change-request finding ends fixed or rebutted** and **Answer every ask in a finding, not only the finding** already cover a finding left unfixed.
- `prompts/coding_guidelines/prompt.md` ("Avoid pinning incidental CSS, DOM or private code.") and the reviewer's rule are unchanged, as the issue says.

### Undiscoverable Facts

- The twelve PRs behind this issue are in a private fleet repository. Their evidence is in the review-fleet-prs host's review log, not in this repository.

## Evidence

Documentation and prompt change, plus one runtime line. In
`worker/deno/lib/run_core_production_deps.ts`, `ensureAutoMerge`'s
`attemptMerge` now passes `ghCommandFn: gh` (`gh` is
`options.autoMergeGhCommandFn ?? runGhCommand`) to `enableAutoMerge`. In
production `autoMergeGhCommandFn` is unset, so `gh` is `runGhCommand`, the same
runner `enableAutoMerge` used by default. Only a test that injects a runner
sees a difference. This change is outside the issue's text and is here only
because the gate's unit list for this branch includes the 4952 wiring test.

- Related existing rules checked, all consistent with the new passage:
  - `prompts/coding_guidelines/prompt.md`: "Avoid pinning incidental CSS, DOM or private code." (unchanged)
  - `CODING-STANDARDS.md`: the sentence after the passage. A layout claim needs a headless-browser check, and with no browser harness the Test Plan names the gap.
  - `CODING-STANDARDS.md`: the `visually-hidden` closed-state sentence. The passage still classes an open-only class whose absence marks the closed state as semantic state.
  - `prompts/issue/prompt.md` rule 2: the `.css`/`.scss` source-grep paragraph and **A browser check you did not run is not a safety net**.
  - `prompts/pr_feedback/prompt.md`: **Every change-request finding ends fixed or rebutted** and **Answer every ask in a finding, not only the finding**. These now cover what the deleted paragraph did.
- Every place this diff states the rule gives the same answer: `CODING-STANDARDS.md`, `prompts/issue/prompt.md` and the docs test's shared `PINS` list. A class that only produces a look is not a test of it. An open-only class and `aria-*` state count as semantic state.
- Applied the rule to this PR's own diff. The only test the diff edits pins documentation phrases, not a class, tag or style value, so the rule flags nothing in it.
- Grep on the final head for the old wording found no hits outside `docs/archive/` in any `.md` or `.ts` file. The grep covered "style literal", "kind of value, not the file", "box ends above the bar", "TS/JS options object" and "replaced style literal".
- Issue numbers in the diff:
  - #3444: Fleet UI tests still pin exact style values outside stylesheets: colours in TS chart config, calc() strings from computed style (two private fleet PRs, after #3247)
  - #4991: Rewrite the #3444 style-literal rule: fleet tests keep asserting a class or tag name, often for a look a unit test cannot see, while the rule is framed around where a colour or calc() value lives (twelve private fleet PRs)

## Test Plan

- Modified `worker/deno/tests/style_literal_assertions_3444_docs_test.ts`. Its two remaining tests share one `PINS` list taken from the new passage and check it in `CODING-STANDARDS.md` § Choosing assertions and in `prompts/issue/prompt.md` § Instructions. `deno test -A tests/style_literal_assertions_3444_docs_test.ts` from `worker/deno`: 2 passed, 0 failed.
- Removed from `worker/deno/tests/style_literal_assertions_3444_docs_test.ts`: the `assertPins(section(... "CODING-STANDARDS.md"), "Choosing assertions"), [...])` pins `"A style literal is incidental wherever it lives"`, `"in a TS/JS options object"`, `"in a computed style a browser test reads"`, `"it is never a test's expected value unless the issue names that value"`, `"quote the issue sentence that names it in the Test Plan"` and `"the panel's box ends above the bar's top"`
  - Required by: "in its first two tests, replace the pins with phrases from the new passage, for example "Do not pin incidental appearance choices" and "the class that produces the look is not a test of it"."
  - Replaced by: `"Do not pin incidental appearance choices"`, `"A component unit test cannot see weight, colour, wrapping or layout"`, `"the class that produces the look is not a test of it"`, `"Its test is the browser check described next"`, `"are semantic state, not style"`
- Removed from `worker/deno/tests/style_literal_assertions_3444_docs_test.ts`: the `assertPins(section(... "prompts/issue/prompt.md"), "Instructions"), [...])` pins `"is never a test's expected value unless the issue names that value"`, `"The rule is about the kind of value, not the file it lives in"`, `"in a TS/JS options object"`, `"computed style a browser test reads"` and `"replace the literal with the behaviour it stands for"`
  - Required by: "in its first two tests, replace the pins with phrases from the new passage, for example "Do not pin incidental appearance choices" and "the class that produces the look is not a test of it"."
  - Replaced by: the same `PINS` list as above, including `"Do not pin incidental appearance choices"` and `"the class that produces the look is not a test of it"`
- Removed from `worker/deno/tests/style_literal_assertions_3444_docs_test.ts`: the test "prompts/pr_feedback/prompt.md Making Changes removes a replaced style literal (Issue #3444)" with its pins `"A replaced style literal is removed, not joined"`, `"the push deletes the literal assertion"`, `"A new check added beside the literal does not fix the finding"` and `"cite the removed lines"`
  - Required by: "Delete the third test, because the paragraph it pins is gone."
- I ran the docs tests that read the edited prompts together in one `deno test -A` call: every `tests/*.ts` that names `prompts/pr_feedback/prompt.md`, plus `worker/deno/tests/ui_assertion_closed_state_3250_test.ts`, `worker/deno/tests/stylesheet_regex_layout_3247_docs_test.ts` and `worker/deno/tests/coding_guidelines_twin_drift_test.ts`. Result: 157 passed, 0 failed.
- Modified `worker/deno/tests/milestone_sync_after_target_wiring_test.ts`. No assertion changed. The `sweepGh` fake's fallback now returns `answerMilestoneLookup(args)` instead of `""`, because the merge gate's milestone lookups now reach the injected runner and no longer the spawn runner. The module doc and the helper's doc comment now say this. Without the fixture change the test failed with "the behind PR must reach the in-cycle sync path". With it, the test passes and still asserts the start gate's deferral text.
- `deno task test:unit` over the 35 `tests/*.ts` files that name `autoMergeGhCommandFn` or `createProductionRunCoreDeps`: 302 passed, 0 failed. Run alone, `worker/deno/tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts` is no longer listed as a slow unit test. `worker/deno/tests/auto_merge_sweep_keeps_armed_test.ts` takes about 6 s per test with or without the fix, and the time budget does not flag it.
- `deno task test:unit` over all 541 `tests/*.ts` files that name the edited prompts, `CODING-STANDARDS.md` or a prompt type, before the wiring fix: parallel pass 9,446 passed, 0 failed; serial pass 145 passed, 0 failed. The time budget listed three files over budget but did not enforce it, because the git guard shim was on PATH. Of the three, `worker/deno/tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts` is the one whose overrun comes from real `gh` calls, not from the shim. The gate's own output for this branch was truncated and named no file, so its block is attributed to that test by this reproduction, not by the gate itself.
- `./quality.sh < /dev/null` on c0deb839 (the final code commit) passed, with config integration and checkov skipped by the gate itself. Deno tests, deno lint, type check, fmt, markdownlint, mermaid and semgrep all passed.
