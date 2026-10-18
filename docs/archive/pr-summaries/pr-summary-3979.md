## Summary

Closes #3979.

Structured facts now refresh one renderer-owned Branch outcomes block. Safely
identified legacy lists are replaced in the existing renderer, while unrelated
narrative and fenced examples survive. Ambiguous ownership and unreached-outcome
admissions stay blocking in completion, local validation and body sync.

## Spec

### Intent and Rationale

- Remove duplicate evidence maintenance without discarding unresolved evidence.

### Essential Design Decisions

- Retain the existing facts schema, renderer and established opening marker; add
  a closing marker so later refreshes have an explicit ownership boundary.
- Reuse the existing Markdown parser, admission check and bounded scan limits.
- Keep the existing missing-test and head-drift checks. Rendering does not prove
  a claimed test execution, and never moves a stale anchor to another line.

### Undiscoverable Facts

- Default branch is `main`.

## Evidence

- Independent real-corpus run: all 32 pre-existing archived summary/facts pairs
  rendered successfully and were byte-identical on a second render. False
  positives: zero in that positive-only corpus. Real-corpus false negatives:
  unmeasured because it contains no labelled negatives. Synthetic refusal
  controls below cover the negative shapes.

- #3979: Render Branch outcomes once from existing facts and remove duplicate summary evidence maintenance.

- The legacy duplicate regression failed against base production code.
- Mutation checks failed when individual ownership, bounds, preservation and
  caller error-handling rules were removed. The original admission validator
  also fails its GRQ-shape regression when its shared check is removed.
- Docs sweep — grep: "hand-written", "facts file", "Branch outcomes", "marker";
  updated CODING-STANDARDS.md, docs/workflows/issue-processing.md and the issue,
  pr_feedback prompts; verified existing coding_guidelines parity; section:
  docs/workflows/issue-processing.md → "The facts file"; siblings: none — no existing configuration or outcome set gained a member.
- Removed the completion/local-check categorical facts-plus-prose refusal.
  Templates request facts plus the marker instead of two maintained lists.
- Private audit examples are not needed to reproduce this change.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Facts plus a legacy duplicate block converge to one correct generated block without a full implementation retry merely for duplicate formatting. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts` and `worker/deno/tests/pr_summary_check_test.ts` exercise the production sequence. — reviewer: met
- **met** — Re-running rendering produces no diff; unrelated summary text survives unchanged. — evidence: `worker/deno/tests/pr_summary_facts_test.ts` covers idempotency, narrative, fenced examples and CRLF preservation. — reviewer: met
- **met** — A correction which moves code leaves evidence valid for the final head or explicitly unresolved, never silently stale. — evidence: `worker/deno/tests/pr_summary_facts_test.ts` retains the old anchor; `worker/deno/tests/branch_outcome_citations_facts_3396_test.ts` covers production drift/recovery. — reviewer: met
- **met** — Missing facts, fabricated results, ambiguous anchors and substantive defects remain detectable; no test/verifier result is invented. — evidence: existing schema/missing-test checks and the specific refusal cases in `worker/deno/tests/pr_summary_facts_test.ts`; callers retain blocking errors. — reviewer: met
- **met** — Templates and callers share the same contract, and the PR names the redundant requirement/path removed. — evidence: shared renderer and issue/coding/feedback prompt changes. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Expected ambiguity refusals used exceptions — evidence: `worker/deno/lib/pr_summary_facts.ts:75` — reason: fixed with Result and explicit handling in all three callers.
- **violation** — Decorated/wrapped inline-code examples could be discarded — evidence: `worker/deno/lib/pr_summary_facts.ts:136` — reason: fixed with full-block shared Markdown masking and specific refusal controls.
- **violation** — Local-check replacement regression could pass without rendering — evidence: `worker/deno/tests/pr_summary_check_test.ts:397` — reason: fixed with a stale named-test citation that only authoritative facts replace.
- **clean** — Reviewed Result contracts, shared admission reuse, named-test paths, test-only production members, documentation truthfulness and issue-required assertion replacements. No routing or merge protections change.


## Test Plan

- `./quality.sh --sequential < /dev/null` passed on implementation head `39154562` with `DENO_JOBS=1`, including both required unit passes, unchanged timing budgets, lint, type checking, formatting and available security checks. Optional config integration was skipped because no runtime configuration was supplied.
- After the clean merge of default head `b5a3fd09`, six affected summary, body-sync and formatter suites pass: 150 tests, no failures. The removed-assertion gate remains valid; source anchors are unchanged.

- Labelled synthetic refusal corpus: 14 invalid inputs and 14 paired legal
  controls; zero false positives and zero false negatives on these fixtures.
  This is bounded fixture evidence, not an estimate for all archived summaries.
- Completion valid-facts marker expectation: bypass rendered assignment → red.
- Completion legacy replacement status, PR count, rendered-list and single-block
  expectations: remove legacy discovery → red; the completion composition
  regression also fails when rendered content is bypassed.
- Body-sync valid-facts marker expectation: bypass rendered assignment → red.
- Local-check legacy replacement status/problems expectations: bypass rendered
  assignment → red because the stale named test remains unresolved.
- Duplicate-start expectation: remove only duplicate-start guard → red.
- Append expectation: omit the appended block → red. Empty-summary
  expectation: return an empty string in that arm → red.

- Eight focused suites pass after updating the base: 173 tests, no failures.
- Focused regressions cover rendering, completion, local validation and body
  sync, plus existing admission and head-drift validation.
- Existing marker-absence expectations change because refreshed bodies retain
  an ownership marker. Their replacement assertions check the marker and the
  rendered facts. Duplicate-evidence refusal expectations now check one correct
  generated block. Actual ambiguous ownership remains blocking.
- Duplicate start/end, missing start, marker order, fenced code, admissions,
  owned refresh, legacy discovery/body/continuation/entry/cap handling, marker
  placement, narrative preservation, input/output bounds and all three callers:
  each rule was broken separately and its corresponding regression went red.

- Removed from `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`: ``assertEquals(outcome.prBodies[0]!.includes(BRANCH_OUTCOMES_MARKER), false);``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(outcome.prBodies[0]!.includes(BRANCH_OUTCOMES_MARKER), true);``

- Removed from `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`: ``assertEquals(outcome.status, "failure");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(outcome.status, "continue");``

- Removed from `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`: ``assertEquals(outcome.prCreateCalls, 0);``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(outcome.prCreateCalls, 1);``

- Removed from `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`: ``assertStringIncludes(blockedText(outcome), FACTS_FILE);``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertStringIncludes(outcome.prBodies[0]!, renderBranchOutcomes(factsFor(EXISTING_TEST)));``

- Removed from `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`: ``assertStringIncludes(blockedText(outcome), "hand-written");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(outcome.prBodies[0]!.match(/\*\*Branch outcomes:\*\*/g)?.length, 1);``

- Removed from `worker/deno/tests/pr_body_sync_test.ts`: ``assertEquals(newBody.includes(BRANCH_OUTCOMES_MARKER), false);``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(newBody.includes(BRANCH_OUTCOMES_MARKER), true);``

- Removed from `worker/deno/tests/pr_summary_check_test.ts`: ``assertStringIncludes(report.problems.join("\n"), "hand-written");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(report.problems, []);``

- Removed from `worker/deno/tests/pr_summary_facts_test.ts`: ``assertEquals(out, `a\nLIST\nb\n${BRANCH_OUTCOMES_MARKER}\n`);``
  Required by: "preserve unrelated narrative and flag ambiguous ownership explicitly"
  Replaced by: ``assertThrows(() => applyBranchOutcomesFacts(`a\n${BRANCH_OUTCOMES_MARKER}\nb\n${BRANCH_OUTCOMES_MARKER}\n`, "LIST"), Error, "unmatched renderer markers");``

- Removed from `worker/deno/tests/pr_summary_facts_test.ts`: ``assertEquals(applyBranchOutcomesFacts("body\n\n", "LIST"), "body\n\nLIST\n");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(applyBranchOutcomesFacts(prefix, "LIST"), expected);``

- Removed from `worker/deno/tests/pr_summary_facts_test.ts`: ``assertEquals(applyBranchOutcomesFacts("  \n", "LIST"), "LIST\n");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(applyBranchOutcomesFacts("  \n", "LIST"), `${BRANCH_OUTCOMES_MARKER}\nLIST\n${BRANCH_OUTCOMES_END_MARKER}\n`);``

- Removed from `worker/deno/tests/pr_summary_check_test.ts`: `assertEquals(report.status, "blocked");`
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: `assertEquals(report.status, "passed");`

<!-- vibe-branch-outcomes -->
