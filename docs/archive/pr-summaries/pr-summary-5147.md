## Summary

The pre-PR verifier now lets the recovery turn give the honest answer to a
closure-gap finding. When it rates a `met` entry `partial` or `missing`, the
turn may mark that entry `partial` with a reason naming the left-out case, which
is the fix the fleet reviewer accepts. The finding's `fix` text, the verifier's
PR comment and the recovery prompt now all say this. Findings about code are
unchanged: a bug is still closed only by fixing it or disputing it with
evidence. Closes #5147.

## Spec

### Intent and Rationale

- Until now, the procedure sentence from #3865 ("Marking a criterion `partial` …
  does not close a finding") also covered the closure-gap finding, whose subject
  _is_ the status. A run that could neither deliver the case nor honestly
  dispute it had no allowed move, so it raised the PR with an over-claimed
  `met`.
- The change rewords the existing guidance only. It adds no gate, check or
  obligation.

### Essential Design Decisions

- The first sentence of the procedure is kept ("A finding is closed only by
  fixing it or disputing it with evidence."). Marking an over-claimed `met`
  entry `partial` is the fix for that finding, so the two sentences agree.
- The finding's fix does not offer `missing`. The test asserts that, because the
  verifier's note names one case left out, not a criterion with nothing
  delivered.
- The issue's wording is used verbatim in all three places, so the finding and
  the procedure read the same in the recovery prompt and in the PR comment.

### Undiscoverable Facts

None.

## Evidence

Backend prompt and comment text only; no UI change.

- `worker/deno/lib/closure_met_check.ts:203`: the `fix` of `closureGapFindings`
  now reads "Deliver the case the note names, with its test, and keep `met`; or
  mark the entry `partial` with a `reason:` naming that case, so the PR says
  `Part of #N`; or dispute the verdict in your final message with evidence from
  the code."
- `worker/deno/lib/pre_pr_verifier.ts:1312` (`buildPrePrVerifierGateComment`)
  and `worker/deno/lib/summary_rule_gate_retry.ts:357`
  (`buildSummaryRuleRetryPrompt`) both now say: "Marking a criterion `partial`
  closes only a finding about that entry's `met` status. Listing a known gap or
  open limitation in the PR summary, or noting a test as "not red-checked",
  closes no finding."
- Docs sweep: I grepped `README.md`, `docs/` (outside the archive and audits),
  `prompts/*/prompt.md`, `CODING-STANDARDS.md` and `DESIGN-PRINCIPLES.md` for
  "Deliver every case", "Marking a criterion", "close a finding", "closed only
  by fixing" and "dispute the verdict". None of them restates the old wording. I
  read the verifier sections in `docs/workflows/issue-processing.md` ("Pre-PR
  verifier (Issue #3395)") and `docs/MODEL-AND-CACHING.md` ("Pre-PR verifier
  (issue phase)"), and both stay true. The doc comment on `closureGapFindings`
  does not describe the fix text.
- Related rules checked: `prompts/pr_feedback/prompt.md:87` (an unmet criterion
  is kept open with `partial`/`missing` plus `Part of #N`) now agrees with the
  finding. `prompts/issue/prompt.md:953` ("Mark `met` only when the diff
  delivers every case the criterion names") is unchanged and consistent. I
  applied the new rule to this PR's own diff and found nothing it would flag.
- Twinned copies: the same procedure sentence was in `pre_pr_verifier.ts` and
  `summary_rule_gate_retry.ts`, and both are changed. `pr_summary_check.ts`
  carries no copy.

## Test Plan

- `worker/deno/tests/closure_met_check_3766_test.ts::closureGapFindings: the fix offers delivery, an honest partial with a reason, or a dispute (Issue #5147)`:
  renamed and rewritten. It asserts the delivery, `partial`-with-reason,
  `Part of #N` and dispute options, and that the fix never mentions `missing`.
- `worker/deno/tests/pre_pr_verifier_3395_test.ts::gate comment and block reason name the findings`
  and
  `::the closure gap finding's fix agrees with the gate comment's procedure`:
  assert the new sentences, the absence of "does not close a finding", and that
  the comment carries "mark the entry `partial` with a `reason:` naming that
  case".
- `worker/deno/tests/summary_rule_gate_retry_test.ts::summary-rule retry - verifier findings need a fix or evidence-backed dispute (Issue #3797)`:
  the same sentence assertions on the recovery prompt's verifier exception, plus
  the absence of "does not close a finding".
- TDD: with the tests edited and the lib unchanged, `deno test --allow-all` on
  the three files gave `FAILED | 124 passed | 4 failed`, and the four failures
  were exactly the edited tests. After the lib edits the same command gave
  `ok | 128 passed | 0 failed`.
- `./quality.sh < /dev/null` on the head: every stage passed except
  `deno tests`. The parallel pass gave `35241 passed | 1 failed`; the single
  failure is
  `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts::PR summary CI task runs git with restricted environment permissions`,
  which failed with `Failed caching npm package 'commonmark@0.31.2'` because
  this container cannot resolve `registry.npmjs.org`. This diff does not touch
  that test or its inputs. The gate stops after a failed parallel pass, so the
  serial pass did not run here.

Removals from existing tests:

- Removed from `worker/deno/tests/closure_met_check_3766_test.ts`:
  `assert(!/partial|missing/.test(out[0]!.fix));`
  - Required by: "mark the entry `partial` with a `reason:` naming that case, so
    the PR says `Part of #N`"
  - Replaced by: `assertStringIncludes(out[0]!.fix, "mark the entry \`partial\`
    with a \`reason:\` naming that
    case")`and`assert(!/missing/.test(out[0]!.fix))`
- Removed from `worker/deno/tests/closure_met_check_3766_test.ts`:
  `assertStringIncludes(out[0]!.fix, "dispute");`
  - Replaced by: `assertStringIncludes(out[0]!.fix, "dispute the verdict")`
- Removed from `worker/deno/tests/pre_pr_verifier_3395_test.ts`:
  `assert(!comment.includes("mark the entry \`partial\`"));`
  - Required by: "or mark the entry `partial` with a `reason:` naming that case"
  - Replaced by: `assertStringIncludes(comment, "mark the entry \`partial\` with
    a \`reason:\` naming that case")`
- Removed from `worker/deno/tests/pre_pr_verifier_3395_test.ts` and
  `worker/deno/tests/summary_rule_gate_retry_test.ts`:
  `assertStringIncludes(…, "Marking a criterion \`partial\`")`,`assertStringIncludes(…,
  "listing a known gap or open limitation")`and`assertStringIncludes(…, '"not
  red-checked" does not close a finding')`
  - Required by: "Replace "Marking a criterion `partial`, listing a known gap or
    open limitation in the PR summary, or noting a test as "not red-checked"
    does not close a finding." with"
  - Replaced by: `"Marking a criterion \`partial\` closes only a finding about
    that entry's \`met\` status"`,`"Listing a known gap or open limitation in
    the PR summary"`,`'"not red-checked", closes no
    finding'`and`!….includes("does not close a finding")`

Not checked: CI on the branch, and the serial Deno test pass (the gate skipped
it after the environmental failure above).
