## Summary

The fleet's cost-guard guidance said to guard any super-linear cost by
asserting the output, because the case "never returns". That reason holds only
for catastrophic backtracking. A polynomial cost, such as a quadratic rescan,
returns the same output in seconds, so an output-only test passes on the
unfixed code (VibeCoder #5232, NEAT-AI-Discovery #2431). This PR rewords the
existing passages and adds no new rule. Closes #5234.

- `prompts/coding_guidelines/prompt.md`, **Guard super-linear cost by output,
  then by counted work**: the output form is now scoped to catastrophic
  backtracking. The bullet names polynomial cost as the case for counted work
  and says an output-only test passes on the unfixed code there.
- `CODING-STANDARDS.md`, **Guard super-linearity by behaviour first**: "A
  super-linear regression then hangs the case" now reads "A backtracking
  regression". The existing pre-fix-cost caveat and its
  `plan_coverage_gate_bounds_1245_test.ts` example moved up from the end of
  the last-resort ratio bullet into this bullet. The caveat now opens "The
  behavioural form only works when …" and names polynomial cost.
- **Every restatement gives the same answer.** In `CODING-STANDARDS.md`, the
  "target repository's own testing standard wins" bullet now says "by the
  output first where the pre-fix cost hangs". The **Vet every regex** bullet,
  which must stay identical on both surfaces, now gives "a deterministic step
  count" for a polynomial cost that still returns.

## Spec

### Intent and Rationale

- Agents copied the guidance's own "never returns" sentence into tests for
  quadratic work. Scoping that sentence where it is stated fixes the cause.
  The fix does not add a new obligation alongside the old one.
- The caveat already existed 40 lines further down, under the ratio bullet,
  so it was moved rather than written again, as the issue asked.

### Essential Design Decisions

- The bullet headings are unchanged. Test doc comments cite "Guard
  super-linearity by behaviour first", and the **Vet every regex** bullet pins
  "guard super-linear cost by output, then by counted work, as the timing
  bullets above say".
- The issue said the **Vet every regex** bullet "may need no change". I gave
  it the one-clause scope anyway, because it names quadratic regex shapes such
  as the `(.*)$` rescan, and it must give the same answer as the timing bullet
  it defers to.
- `prompts/test_audit/prompt.md` is left unchanged. It already scopes the
  sentence to "a catastrophic-backtracking input", as the issue says.

### Undiscoverable Facts

None.

## Evidence

This is a documentation and prompt change, with no UI files. It is protected
by a doc-pin test in `worker/deno/tests/timing_assertion_policy_test.ts`:
`timing policy - the output form is scoped to cost that never returns,
polynomial cost goes to counted work (Issue #5234)`.

- **Red first.** I ran the new test against the unedited docs before the
  rewording. It failed with
  `section is missing pin "Catastrophic backtracking on an input of real size never returns, so for that cost first assert what the code **produces**"`.
- **Green at head.** It passes on the final head.

Related rules checked:

- `prompts/test_audit/prompt.md` check 3 is already scoped.
- `prompts/pr_feedback/prompt.md`, "A backtracking finding covers every regex
  in the module", asks for "the pattern's result or a counted step". That is
  consistent.
- In `CODING-STANDARDS.md`, the target-repository bullet was changed and the
  ratio bullet lost the moved caveat.

Applying the rule to this PR's own diff: the only test added is a doc-pin test
over Markdown, not a cost guard, so the rule flags nothing in it.

Issue numbers cited: #5234 is this issue. #1245 is the existing citation,
moved with its sentence.

## Test Plan

- Added the Issue #5234 test to
  `worker/deno/tests/timing_assertion_policy_test.ts`. It pins the scoped
  wording in both bullets and checks that the two old sentences are absent from
  both whole files. No existing test was edited, and no assertion was removed.
- I ran these on the final head with `deno test --allow-all`: the file above,
  `worker/deno/tests/regex_vetting_rule_3164_docs_test.ts` (which checks the
  two regex bullets are identical), `worker/deno/tests/regex_vetting_rule_3186_docs_test.ts`,
  `worker/deno/tests/coding_guidelines_twin_drift_test.ts` and
  `worker/deno/tests/markdown_code_spans_test.ts`. Result: 65 passed, 0
  failed.
- I ran `./quality.sh` once on the head. Every stage passed except
  `deno tests`: 35239 passed and 1 failed, so the serial pass did not run. The
  one failure is
  `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`, "PR summary CI task
  runs git with restricted environment permissions". It downloads npm packages
  at run time and failed with
  `dns error: failed to lookup address information: Temporary failure in name resolution`
  for `registry.npmjs.org`, because this container has no DNS
  (`getent hosts registry.npmjs.org` returns nothing). It fails the same way
  when run alone, and it touches no file this PR changes.

Not checked: the serial test pass, which the gate did not reach after the
network failure, and the network-dependent test above. CI runs both. Remaining
risk: none known.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
