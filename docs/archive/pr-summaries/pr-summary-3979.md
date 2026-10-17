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

- The legacy duplicate regression failed against base production code.
- Mutation checks failed when individual ownership, bounds, preservation and
  caller error-handling rules were removed. The original admission validator
  also fails its GRQ-shape regression when its shared check is removed.
- Docs sweep — grep: "hand-written", "facts file", "Branch outcomes", "marker";
  updated CODING-STANDARDS.md, docs/workflows/issue-processing.md and the issue,
  coding_guidelines and pr_feedback prompts; section:
  docs/workflows/issue-processing.md → "The facts file"; siblings: none.
- Removed the completion/local-check categorical facts-plus-prose refusal.
  Templates request facts plus the marker instead of two maintained lists.
- Private audit examples are not needed to reproduce this change.

## Acceptance Criteria

- met — Facts plus a legacy duplicate block converge to one correct generated
  block: completion and local-check regressions exercise the existing sequence.
- met — Re-running rendering produces no diff: repeated render assertions and
  narrative/CRLF/fenced-example controls cover ownership and preservation.
- met — A correction which moves code leaves evidence explicitly unresolved:
  the changed-head regression retains the old anchor and the existing drift
  validator reports it.
- met — Missing facts, fabricated results, ambiguous anchors and substantive
  defects remain detectable: existing schema/missing-test checks remain active;
  ambiguity and admissions block callers. Execution verification stays with
  the existing verification mechanism; facts are not execution evidence.
- met — Templates and callers share the same renderer contract. Removed the
  redundant hand-written-list requirement and duplicate refusal paths.

## Test Plan

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
  Replaced by: ``assertThrows(() => applyBranchOutcomesFacts(`a\n${BRANCH_OUTCOMES_MARKER}\nb\n${BRANCH_OUTCOMES_MARKER}\n`, "LIST"), Error, "ambiguous");``

- Removed from `worker/deno/tests/pr_summary_facts_test.ts`: ``assertEquals(applyBranchOutcomesFacts("body\n\n", "LIST"), "body\n\nLIST\n");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(applyBranchOutcomesFacts(prefix, "LIST"), expected);``

- Removed from `worker/deno/tests/pr_summary_facts_test.ts`: ``assertEquals(applyBranchOutcomesFacts("  \n", "LIST"), "LIST\n");``
  Required by: "Facts plus a legacy duplicate block converge to one correct generated block"
  Replaced by: ``assertEquals(applyBranchOutcomesFacts("  \n", "LIST"), `${BRANCH_OUTCOMES_MARKER}\nLIST\n${BRANCH_OUTCOMES_END_MARKER}\n`);``

<!-- vibe-branch-outcomes -->
