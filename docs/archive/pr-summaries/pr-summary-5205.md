# PR Summary — Issue #5205

## Summary

This PR replaces the caller-inventory paragraph **A new argument or behaviour
reaches every caller that needs it** with the short rule the issue proposes. The
paragraph appears in `CODING-STANDARDS.md` and, word for word, in
`prompts/coding_guidelines/prompt.md`. The new rule says to carry required
behaviour through affected production callers and constructors, including
recovery paths. Required inputs are explicit in the type, and absence is
preserved where it is intentional. Wiring is judged by the observable behaviour
of the entry points, under the existing **Every changed call site needs a test
that goes red without it** rule. The grep-and-list procedure is gone, and so are
both PR-summary caller-list obligations. The issue prompt's Test Plan step
restated the caller list a third time; it now restates the short rule instead.
Closes #5205.

## Spec

### Intent and Rationale

- #3771 kept recurring after it closed. Ten independent PRs missed required
  wiring even though the rule asked for a caller list twice (#4800 left out a
  publication hook on a recovery push, and #5122 let a diagnostic launch skip
  disk admission). A list is not evidence that a path gets the input, so the
  rule now asks for the wiring and its observable test, not a report.
- The coverage obligation reuses the existing **Every changed call site needs a
  test that goes red without it** paragraph by name. That is the
  current-change, outcome-based standard aligned by #5019, so it is not
  restated here.

### Essential Design Decisions

- The bold title is kept, so the issue prompt's cross-reference still resolves.
  Only the body is replaced.
- The issue prompt's Test Plan restatement is reworded in the same diff. It
  carried a third caller-list obligation, and keeping it would contradict the
  simplified rule.
- No gate, lint rule, summary section, review step or checklist is added. The
  #3771 optional-input sentence for the review brief is not restored.
- The separate **Changing what a shared helper returns, refuses or finds
  changes every caller** paragraph (Issues #3100, #3779) is unchanged. It is a
  different rule, and the issue does not ask to change it.

### Undiscoverable Facts

- The recurrence count comes from the review-fleet-prs ledger (`guidance.ts
  due`), which is not in this repository.

## Evidence

This is a documentation and prompt change with no code or UI surface. It is
verified by the drift test below and the full gate.

- Doc surfaces updated: `CODING-STANDARDS.md` and
  `prompts/coding_guidelines/prompt.md`, the caller-reach paragraph in "Test
  coverage expectations". Also `prompts/issue/prompt.md`, the Test Plan item in
  "PR Summary File".
- Related existing rules checked:
  - **Every changed call site needs a test that goes red without it**, now
    referenced by name.
  - **Changing what a shared helper returns, refuses or finds changes every
    caller**, left unchanged; its own "List the callers checked" covers a
    different case.
  - **A new path to an existing outcome keeps that outcome's guards**, which is
    consistent and needs no change.
  - **Test discovery belongs to the change being developed**, which is
    consistent and needs no change.
- Grep on the final head for `callers\? and siblings`, `every caller and
  sibling` and `sibling route` across `*.md` and `*.ts` (outside
  `docs/archive/` and `docs/audits/`) finds no hit apart from the test's own
  retired-phrase list.
- Rule applied to this PR's own diff: the diff adds no parameter, constructor
  or recovery path, so the rule has nothing to flag. This summary carries no
  caller list.
- Provenance cited in the diff:
  - #3253: Fleet PRs wire a new argument or behaviour into some callers and
    miss one: an optional default or hard-coded old value hides it.
  - #5205: Simplify the ineffective caller-inventory guidance after #3771
    recurrence.

## Test Plan

- Updated `worker/deno/tests/caller_reach_3253_test.ts`:
  - It pins the new phrases on both surfaces and asserts the three retired
    caller-list phrases are absent there.
  - It keeps the check that the two surfaces are identical.
  - It asserts that the issue prompt's PR Summary File section carries the
    short restatement and no longer carries the caller list.
  - Result: 2 passed, 0 failed.
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"list every caller and sibling first",` (asserted present)
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations"
  - Replaced by: `!paragraph.includes(phrase)` over `RETIRED_PHRASES`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"state in the PR summary why that caller does not need it",` (asserted present)
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations"
  - Replaced by: `!paragraph.includes(phrase)` over `RETIRED_PHRASES`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"List the callers and siblings checked in the PR summary",` (asserted present)
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations"
  - Replaced by: `!paragraph.includes(phrase)` over `RETIRED_PHRASES`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"every sibling outcome a router dispatches",`
  - Required by: "The inspected checkout still frames the remedy around grepping a function name, listing every caller and sibling"
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"a default that silently turns the behaviour off",`
  - Required by: "Required behaviour inputs should be explicit in the type rather than silently disabled by an omitted parameter or field."
  - Replaced by: `"explicit in the type rather than silently disabled by an omitted parameter or field",`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"so the compiler or type checker names each caller you missed",`
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations, with concise wording along these lines"
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"hard-codes the old value",`
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations, with concise wording along these lines"
  - Replaced by: `"through affected production callers and constructors, including recovery paths",`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"while no production caller passes it",`
  - Required by: "direct helper coverage alone does not establish production wiring"
  - Replaced by: `"direct helper coverage alone does not establish production wiring",`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `text.includes("reaches every caller and sibling route that needs it")`
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations"
  - Replaced by: `!text.includes(phrase)` for `"reaches every caller and sibling route that needs it"`
- Removed from `worker/deno/tests/caller_reach_3253_test.ts`: `"a caller left on the old hard-coded value is a blocking self-review finding",`
  - Required by: "Replace the existing paragraph, including both caller-list reporting obligations, with concise wording along these lines"
  - Replaced by: `text.includes(phrase)` for `"reaches the affected production callers and constructors, including recovery paths"`
- Tests that read the edited docs: `deno task test:unit` over every test file
  that names `CODING-STANDARDS.md`, `coding_guidelines` or the issue prompt.
  The parallel pass gave 9052 passed, 0 failed, 1 ignored, and the serial pass
  227 passed, 0 failed. No other test pinned the removed wording.
  `markdownlint-cli2` reported 0 issues.
- `./quality.sh` on head `271bd83d` (the docs and test change): `PASSED (with
  skipped checks)`. `config integration` was skipped because there is no
  `.config.json`, and `checkov` was skipped because it is not on PATH.
  - The first run failed only
    `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts::PR summary CI task runs git with restricted environment permissions`,
    with `dns error: failed to lookup address information` while fetching
    `mdurl` from `registry.npmjs.org`.
  - That test reads the default `~/.cache/deno` under a cleared environment,
    and this host has no DNS for the registry. This is a host fault, not a
    product fault.
  - Copying the warm `DENO_DIR` npm cache into `~/.cache/deno`, outside the
    repository, made that test pass (11 passed). The re-run gate then passed.
