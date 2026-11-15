# PR Summary — Issue #4992

## Summary

This PR rewrites the **Nothing exists only for a test to read** check from
#3455. The old check passed a member whenever one production hit "reads or sets"
it, and the code that declares or fills the member is such a hit. It also looked
only at members the diff adds. The new paragraph is identical in
`CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, and it uses the
wording the issue proposed:

- Only production code that consumes a member counts as a use: code that reads
  the field or result, calls the function, method or component, or passes the
  prop or parameter. The code that declares, fills or defaults the member is not
  a use.
- The grep now also covers each member whose production caller the diff removes
  or replaces.
- The list of members now names methods and components.
- The "the PR summary says so" obligation and the closing "blocking self-review
  finding" sentence are gone.

The **PR Summary File** step in `prompts/issue/prompt.md` no longer restates the
rule, and the drift test pins the new wording. Closes #4992.

## Spec

### Intent and Rationale

- Ten fleet PRs were sent back for a production member that only a test uses. In
  five of the nine counted cases, production only declared or filled the member,
  so the old "reads or sets" grep passed. In the other five, the diff removed
  the member's last production caller, a case the old check never looked at. One
  PR (VibeCoder#4531) was in both groups.
- The issue asked for a rewrite of about the same length that adds no gate, Test
  Plan line or summary obligation. This PR removes one summary obligation and
  one copy of the rule.

### Essential Design Decisions

- The paragraph is the issue's proposed text word for word, and it stays
  identical on both surfaces. The drift test asserts that after wrapping is
  flattened.
- The issue prompt's restatement is deleted rather than reworded. Issue runs
  load the `code` layer of the coding guidelines
  (`CODING_GUIDELINES_LAYER_BY_PHASE.issue` in
  `worker/deno/lib/prompt_builder.ts`), and **Testing Best Practices** sits in
  that layer.

### Undiscoverable Facts

- The recurrence count (10 independent PRs since #3455 closed) comes from the
  review-fleet-prs guidance ledger, as cited in the issue. That ledger is
  outside this repository. It tracks this issue under the
  `test-only-production-reader` pattern.

## Evidence

This change touches documentation and prompts only. No UI file is touched.

- Related existing rules checked: **A new argument or behaviour reaches every
  caller that needs it** (`CODING-STANDARDS.md`, mirrored in the coding
  guidelines). It agrees with the new paragraph: a parameter that no production
  caller passes is flagged by both. I found no other rule on test-only members.
- I applied the new rule to this PR's own diff. The diff adds no production
  member (it changes three Markdown files and one test file), so it found
  nothing.
- Every place that states the rule is now a single paragraph, kept identical in
  two files. The issue prompt no longer carries a copy that could give a
  different answer. `git grep` for the old wording ("reads or sets", "counts as
  its setter", "production reader or setter") outside `docs/archive/` and
  `evals/` now has no hit in `CODING-STANDARDS.md`, `prompts/` or the drift
  test. The `evals/capability_security/comparison-20261026.json` hits are a
  recorded eval capture, so they are left as recorded.
- Issue numbers in the diff: #3455 (the original rule, cited in the paragraph
  and in the test) and #4992 (Rewrite the #3455 production-reader check). Both
  are cited in the test's header comment.

## Test Plan

- Edited `worker/deno/tests/production_reader_rule_3455_test.ts`. The first test
  now pins the new wording, and its placement and identical-surfaces checks are
  unchanged. The second test is deleted.
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `"only a test reads or sets does not belong in production code",`
  - Required by: "replace the pins that name the old wording (\"only a test
    reads or sets does not belong in production code\", \"find one hit outside
    test code\", \"counts as its setter\", \"A new member with no production
    reader or setter is a blocking self-review finding\") with phrases from the
    new paragraph"
  - Replaced by: `"only a test uses does not belong in production code"`
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `"find one hit outside test code",`
  - Required by: "replace the pins that name the old wording (\"only a test
    reads or sets does not belong in production code\", \"find one hit outside
    test code\", ...) with phrases from the new paragraph"
  - Replaced by: `"whose production caller the diff removes or replaces"`,
    `"The code that declares, fills or defaults the member is not a use"`
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `"counts as its setter",`
  - Required by: "replace the pins that name the old wording (... \"counts as
    its setter\" ...) with phrases from the new paragraph"
  - Replaced by: `"counts as a production caller"`
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `"A new member with no production reader or setter is a blocking self-review finding",`
  - Required by: "\"The PR summary says so\" and the closing \"blocking
    self-review finding\" sentence are dropped."
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `"remove the member and move the assertion onto the observable output",`
  - Obsolete: the issue's paragraph says "Remove a test-only member and move the
    assertion onto what production does with it" instead.
  - Still covered by:
    `worker/deno/tests/production_reader_rule_3455_test.ts::both surfaces carry the production-reader rule, identical, in their testing sections (Issue #3455)`
  - Replaced by:
    `"Remove a test-only member and move the assertion onto what production does with it"`
- Removed from `worker/deno/tests/production_reader_rule_3455_test.ts`:
  `assertPins(section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"), [...])`
  (the whole second test)
  - Required by: "Delete the second test (\"issue prompt PR Summary File step
    restates the production-reader rule\"), because the restatement it pins is
    gone."
- The edited first test fails on the base copy of the docs, because its new pins
  are absent from the old paragraph. It passes at the head.
- `deno test -A tests/production_reader_rule_3455_test.ts tests/caller_reach_3253_test.ts tests/coding_guidelines_layers_2574_test.ts tests/existing_rule_conflicts_3077_test.ts`
  from `worker/deno`: 18 passed, 0 failed.
- `./quality.sh < /dev/null` (first run): it failed on one test,
  `worker/deno/tests/merge_fallback_issue_test.ts::createFallbackFlagFiler - routes the label creation through the caller's gh (Issue #2310)`.
  That test also fails on the base commit in a separate checkout. The cause is
  host state: `ensureLabelExists` reads this host's shared label cache under
  `TMPDIR` (`defaultLabelCacheDir` in `worker/deno/lib/label_cache.ts`), which
  already lists the label, so the test never reaches the POST. With a fresh
  `TMPDIR`, the test file passes (29 passed, 0 failed). This PR does not touch
  that code.
- `TMPDIR=<fresh dir> ./quality.sh < /dev/null` on the head: passed, with config
  integration and checkov skipped by the gate itself. The Deno tests passed in
  both the parallel and serial passes, as did lint, the type check, fmt,
  markdownlint, mermaid and semgrep.
