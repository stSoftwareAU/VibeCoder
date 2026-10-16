## Summary

The agent guidance now states condition 3 of `CODING-STANDARDS.md` §
Documentation-drift tests: a drift pin that names a value a module or a
checked-in config file already holds is built from that source, never typed
in. It also adds the red check that catches a typed-in value: change the value
at its source, run the drift test, see it fail, restore it, and record one
Test Plan line per value. Closes #3655.

## Spec

### Intent and Rationale

- The only red check the guidelines asked for (remove the doc change) passes
  a typed-in value, because deleting the new sentence still turns the test
  red. VibeCoder#3478 and #3654 were both sent back for exactly this, so the
  missing step is the source mutation, not a restatement of condition 3.
- The rule goes into the shared **A new test must go red without its change**
  paragraph, which `new_test_must_go_red_3093_test.ts` already holds
  identical in `prompts/coding_guidelines/prompt.md` and
  `CODING-STANDARDS.md`. Both copies carry the same new sentences.

### Essential Design Decisions

- `CODING-STANDARDS.md` condition 3 stays the canonical rule. The prompts
  point to it and carry only the short form plus the red check. Condition 3
  now also covers flags, command lines, function names, versions, tags and
  values in checked-in config files, so the prompts' wider list matches it.
- Every place that restates the per-phrase drift check now gives the same
  answer for a code-held value: the issue prompt's Test Plan step, the
  pr_feedback red-run rule, step 4 of the shared review brief (the issue's
  optional item), the CONTRIBUTING drift-pin bullet and the operator doc.

### Undiscoverable Facts

- Issue #3655 says the reviewer found the #3654 case by changing `--depth=1`
  to `--filter=blob:none` in `buildShallowCloneArgs`. The guidance uses that
  mutation as its Test Plan example.

## Evidence

Purely a guidance and documentation change, plus one documentation-drift
test. No runtime code changed.

- `worker/deno/tests/drift_pin_source_value_3655_docs_test.ts` pins the new
  text in six tests, each pin scoped to its section: `CODING-STANDARDS.md`,
  `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
  `prompts/pr_feedback/prompt.md`, `prompts/pr_review_brief/prompt.md` and
  `CONTRIBUTING.md`. It does not read `docs/workflows/issue-processing.md`,
  so the operator-doc sentence is not pinned. Following its own
  rule, it builds the example pin from `buildShallowCloneArgs.name` and the
  `--depth=` argument that `buildShallowCloneArgs` returns. Neither is typed
  in.
- Related existing rules checked: the new-test rule (extended), condition 3
  (extended) and condition 4 (consistent) of Documentation-drift tests,
  **Re-scoping an existing drift test** (unchanged, since moved pins are
  exempt from both checks), `prompts/test_audit/prompt.md` check 2 (consistent),
  the pr_feedback red-run rule, the issue prompt Test Plan step, review brief
  step 4 and the CONTRIBUTING drift-pin bullet (all extended). No rule now
  contradicts another.
- Applied the new rule to this PR's own diff. The only code-held values the
  new test names are the function name and the depth flag, and both are built
  from `git_operations.ts`. Every other pin is prose the code cannot express.
  The `buildShallowCloneArgs --depth=1` example matches the head code
  (`worker/deno/commands/git_operations.ts`, `buildShallowCloneArgs`).
- Provenance numbers: #3655: Drift tests retype values the code already
  holds, so they stay green when the code changes: condition 3 is missing from
  the agent's guidance (VibeCoder#3478, #3654). #3478: Add a Floci CI job for
  VibeCoder's own CloudFormation template (#3369). #3654: Fleet code and tests
  assume git history the worker's --depth=1 checkout does not have
  (VibeCoder2893, 3398 and a private fleet PR) (Issue #3494).

**Docs sweep** — grep: "retyp\w*", "typed in", "never retyped", "imported from the live module", `drift-pins-on-base`, "per pinned phrase"; section: `CODING-STANDARDS.md#documentation-drift-tests`; siblings: "config keys", "markers" (condition 3's list of code-held value kinds gained flag, command line, function or export name, version and tag); updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `prompts/pr_review_brief/prompt.md`, `CONTRIBUTING.md`, `docs/workflows/issue-processing.md`; `prompts/test_audit/prompt.md:378` — still true because its parenthetical only illustrates "a value the code does express" and the audit asks for no red check; `docs/SETUP.md:545` — still true because it is an unrelated use of "typed in" (choosing `dynamic` at the setup prompt)

## Test Plan

- Added `worker/deno/tests/drift_pin_source_value_3655_docs_test.ts`, six
  tests. Run with `deno test -A tests/drift_pin_source_value_3655_docs_test.ts
  tests/new_test_must_go_red_3093_test.ts`: 12 passed, 0 failed. The second
  file confirms the two copies of the new-test rule are still identical.
- Per-phrase base check:
  `deno task drift-pins-on-base origin/milestone/fleet-guidance-tests-twins-and-portability <doc> <section> <phrase>...`
  ran for every pin in each section the test reads (CODING-STANDARDS.md "Test
  coverage expectations" and "Documentation-drift tests", coding_guidelines
  "Test Coverage Expectations", issue "PR Summary File", pr_feedback "Making
  Changes", pr_review_brief "Review Mode", CONTRIBUTING "Test layout"). Every
  pinned phrase, the example line included, printed `absent on base`, and
  each command exited 0.
- Source-mutation check (the new rule applied to the new test):
  `buildShallowCloneArgs --depth=1 → --depth=2: test red`. The test failed
  with `section is missing pin "`buildShallowCloneArgs --depth=2 →
  --filter=blob:none: test red`"`, and the source was then restored.
- Per-phrase deletion checks: deleting only the review-brief sentence turned
  "review brief step 4 checks code-held drift pins" red, deleting only the
  CONTRIBUTING sentence turned "CONTRIBUTING drift-pin bullet names the
  source-value red check" red, and deleting only the pr_feedback phrase
  turned "pr_feedback asks for the source-value red run" red. Each was
  restored.
- No existing test was edited and no assertion was removed.
- `./quality.sh < /dev/null`, full gate: the first run failed only on
  markdownlint MD018 (a wrapped line in `docs/workflows/issue-processing.md`
  began with `#3655`). After the reflow, `check-markdownlint` passed on 226
  files, and the full gate re-run on the final head passed.

<!-- vibe-branch-outcomes -->
