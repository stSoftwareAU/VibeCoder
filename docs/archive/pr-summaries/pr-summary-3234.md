## Summary

Issue #3234: documentation-drift tests kept pinning phrases against whole
files despite condition 1 of CODING-STANDARDS.md § Documentation-drift tests.
The type system now makes that rule hold.

- `worker/deno/tests/support/markdown_docs.ts`: `section()` and
  `withoutSection()` return a branded `DocSection`, and `flat()` accepts only a
  `DocSection`. A whole-file `flat(body)` therefore fails `deno check`.
  `excerpt()` and `splitSection()` cut a section into pieces and keep the
  brand. `flatWholeFile()` is the named exception for text that is not a
  section of a page: a pinned-phrase literal, text a module holds, or a whole
  file read for an absence check. A positive pin through it is a finding.
- The drift tests that `flat()` a paragraph or bullet now take a
  `DocSection`, and they slice it with `excerpt()` instead of `.slice()`.
- `branch_outcomes_record_3147_test.ts` and
  `documentation_drift_policy_test.ts` used to read the whole prompt through
  `loadPrompt`. They now read only the named heading (`PR Summary File`,
  `Making Changes`, `Source-text greps used as assertions`).
- `CODING-STANDARDS.md` condition 1 now says the type enforces the rule.
- New `worker/deno/tests/doc_section_type_3234_test.ts`: its
  `@ts-expect-error` lines are the contract that `flat(wholeFile)` and
  `flat(rawSlice)` do not type-check.

## Test Plan

- Removed from `branch_outcomes_record_3147_test.ts`: `` assertEquals(result.ok, true, `${type} failed to load`); `` — #3234 pins sections, not whole prompts, so the whole-prompt loader is gone; `section()` throws on a missing heading.
- Removed from `documentation_drift_policy_test.ts`: `` assertEquals(loaded.ok, true, `cannot load ${family}`); `` — same reason.
- Not removed: the assertions below are still in their files, unchanged. #3234 only retypes each enclosing helper's parameter to `DocSection`. The files are listed after the block.

```text
assert(start >= 0, `could not locate the branch-outcome rule in ${what}`);
assert(start >= 0, `could not locate the changed-call-site rule in ${what}`);
assert(start >= 0, `could not locate the base-branch-red rule in ${what}`);
assert( start >= 0, `could not locate the destructive-state inventory rule in ${what}`, );
assert(start >= 0, `could not locate the fake-mirrors rule in ${what}`);
assert(start >= 0, `could not locate the insertion-point rule in ${what}`);
assert(start >= 0, `could not locate the narrowing-helper rule in ${what}`);
assert(start >= 0, `could not locate the negative-test rule in ${what}`);
assert(start >= 0, `could not locate the reachable-branch rule in ${what}`);
assert(start >= 0, `could not locate the new-path guard rule in ${what}`);
assert( start >= 0, `could not locate the new-test-must-go-red rule in ${what}`, );
assert(start >= 0, `could not locate the observe-real-tool rule in ${what}`);
assert(start >= 0, "could not locate the 'fix the defect everywhere' rule");
assert(start >= 0, `could not locate the refusal-test rule in ${what}`);
assert(start >= 0, `could not locate the regex-vetting rule in ${what}`);
assert(start >= 0, `could not locate the source-comment rule in ${what}`);
```

Each of these assertions is still the first check in the helper that
encloses it, in `worker/deno/tests/`. Only the helper's parameter changed,
from `sectionText: string` to `sectionText: DocSection`:

- `branchOutcomeParagraph`: `branch_outcome_coverage_3069_test.ts` and
  `branch_outcomes_record_3147_test.ts`
- `changedCallSiteParagraph`: `changed_call_site_red_3067_test.ts` and
  `entry_point_wiring_3222_test.ts`
- `redRunParagraph`: `coding_guidelines_base_branch_red_2924_test.ts`
- `destructiveStateParagraph`: `destructive_state_inventory_3107_test.ts`
- `fakeMirrorsParagraph`: `fake_mirrors_production_3224_test.ts`
- `ruleBullet`: `insertion_point_rule_3194_docs_test.ts`,
  `regex_vetting_rule_3164_docs_test.ts` and
  `source_doc_comments_3219_docs_test.ts`
- `narrowingHelperParagraph`: `narrowing_shared_helper_3100_test.ts`
- `negativeTestParagraph`: `negative_test_must_fail_3060_test.ts`
- `reachableParagraph`: `new_branch_reachable_3167_test.ts`
- `newPathParagraph`: `new_path_keeps_guards_3087_test.ts`
- `newTestParagraph`: `new_test_must_go_red_3093_test.ts`
- `observeRealToolParagraph`: `observe_real_tool_3082_test.ts`
- `defectClassParagraph`: `pr_feedback_defect_class_3114_test.ts`
- `refusalTestParagraph`: `refusal_test_rule_3162_test.ts`

The two removed load checks lost nothing. `loadPromptBody()` (#3147) and
`promptCollapsed()` (drift policy) returned the whole `issue`,
`pr_feedback` and `test_audit` prompts, which is the whole-file pin #3234
forbids. They are replaced by `readRepoDoc()` + `section()` on one named
heading each: `PR Summary File`, `Making Changes` and
`Source-text greps used as assertions`. `readRepoDoc` throws when the file
is missing, and `section()` asserts `no heading containing "…"` when the
heading is gone, so a missing prompt still fails loudly.

New `worker/deno/tests/doc_section_type_3234_test.ts`:

- `flat(section())` reads the rule.
- `flat(wholeFile)` and `flat(rawSlice)` are both `@ts-expect-error`.
- `excerpt()`, `splitSection()` and `flatWholeFile()` compile and flatten.

## Review round — absence checks were still section-scoped

A review of this PR found that
`documentation_drift_policy_test.ts`'s "the auditor exempts the pattern it
still flags in source" test narrowed its two *absence* checks (the
cross-repo body guard on `SUPPORT`, and the unconditional
"Flag every grep-as-assertion you find." wording) to the
`Source-text greps used as assertions` section via `testAuditGrepCheckCollapsed()`.
#3234 only narrows *positive* drift pins to a section (condition 1); an
absence check is the opposite shape — it must hold over the whole prompt,
or drift added under an unrelated heading (e.g. `### 3. Performance / timing
assertions`) goes undetected. Fixed: the two absence checks now read
`prompts/test_audit/prompt.md` whole, via `readRepoDoc()` directly (the
path has no whitespace, so a raw `includes` suffices) and
`flatWholeFile()` for the sentence check. The positive assertions stay
section-scoped, unchanged.

- Reproduced at head `34c19c23`: inserting
  `See tests/support/markdown_docs.ts. Flag every grep-as-assertion you find.`
  under `### 3. Performance / timing assertions inside unit tests` in
  `prompts/test_audit/prompt.md` left the pre-fix test green (5/5 passed) —
  the section-scoped check never saw it.
- With the fix applied and the same insertion present, the test goes red:
  `AssertionError: Values are not equal` at
  `documentation_drift_policy_test.ts:138` (now the whole-file
  `SUPPORT`/sentence checks). Reverting the insertion restores a clean 5/5
  pass.
- `deno task test:unit tests/documentation_drift_policy_test.ts
  tests/doc_section_type_3234_test.ts tests/test_audit_unit_suite_checks_943_test.ts
  tests/drift_pins_on_base_3193_test.ts`: 40 passed, 0 failed.
- `deno fmt --check`, `deno lint`, `deno check` on the touched file: clean.
