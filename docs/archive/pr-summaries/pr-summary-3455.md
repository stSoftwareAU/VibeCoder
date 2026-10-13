## Summary

Adds the rule **Nothing exists only for a test to read** to `CODING-STANDARDS.md`
(Test-Driven Development, after rule 5) and, word for word, to the
`coding_guidelines` prompt (end of Testing Best Practices). The rule includes a
pre-PR self-check: find one production reader or setter for each field, prop,
parameter, type or export the diff adds to non-test code, or remove the member
and assert on the observable output. Public API the issue asks for is exempt,
and the PR summary says so. The issue prompt's Test Plan step restates the rule,
the issue-processing manual records it, and a drift test pins it.
Closes #3455.

## Spec

### Intent and Rationale

- Three fleet PRs in one week added a prop or field that only tests read. Nothing in VibeCoder's guidance asked the agent to look for a production reader before raising the PR, so the self-check makes that lookup a required step.
- Agents read the `coding_guidelines` prompt, not `CODING-STANDARDS.md`, so the rule goes on both surfaces and the drift test keeps them identical.

### Essential Design Decisions

- The self-check uses `git grep -n -w <name>` and then reads each hit. It does not use the issue's `':!*test*'` pathspec, because that pathspec also drops production files whose path contains `test` (see Evidence). The paragraph names that trap.
- A production default that passes the real dependency through an injected seam (clock, scheduler, process runner) counts as the member's setter. Without this, the rule would contradict the existing "needs an injected seam" advice in **Unit Tests vs Benchmarks** and **When a test does not fit**.
- The reviewer's rule is not relaxed. A missing production reader is a blocking self-review finding.

### Undiscoverable Facts

- The three source PRs are in a private fleet repo. The issue describes them only in prose, so the manual entry does the same, without links.

## Evidence

This is a documentation and prompt change with no UI and no runtime code.

Observed `git grep` behaviour: in a scratch repo holding `src/app.ts`, `src/latest.ts` and `src/main_test.ts`, each containing `fooField`, `git grep -n fooField -- . ':!*test*'` printed only `src/app.ts:1:fooField`. It dropped the production file `latest.ts`. In this repo, the same pathspec would also drop `worker/deno/lib/self_diagnostic_attestation.ts`.

**Docs sweep** — grep: "only (for )?a test (to )?read", "only a test reads", "production reader", "exists only for a test", "test-only (field|prop|export)", plus `worker/deno/lib` for the same terms. Section: `CODING-STANDARDS.md#test-driven-development-tdd` and `prompts/coding_guidelines/prompt.md#testing-best-practices`. Updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`. Every hit on the head is in lines this diff adds, except one: `docs/audits/security-sweep-2236-agent-marker-neutralisation.md:53` is still true because it names the production readers of a different helper and is unrelated to this rule.

Related existing rules checked:

- **Unit Tests vs Benchmarks** ("needs an injected seam") and **When a test does not fit** ("Take the seam"): the seam clause makes the new rule agree with both.
- **Do not hardcode to the tests**: complementary. That rule covers branching on test inputs, and the new rule covers members added for tests.
- **Call the existing owner — never copy it** (issue prompt): it widens a member's visibility for a production caller, so the member has a production reader and the new rule does not flag it.
- **Choosing assertions → Units** ("not private call sequences"): consistent. Both say to assert observable outcomes.

I applied the new rule to this PR's own diff. The diff adds no field, prop, parameter, type or export to non-test code (the Standards reviewer confirmed this), so nothing needed a production reader.

Issue numbers the diff cites as provenance:

- #3455: Fleet PRs add production fields and props that only tests read: no pre-PR check for a production reader (three private fleet PRs)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Add the rule to both: *A production type, prop, parameter or export that only a test reads or sets does not belong in production code. Assert on what production does with it instead: the returned value, the error message, the rendered text. Or inject through a seam the code already has.* — evidence: `CODING-STANDARDS.md:203`, `prompts/coding_guidelines/prompt.md:1232`, `worker/deno/tests/production_reader_rule_3455_test.ts::both surfaces carry the production-reader rule, identical, in their testing sections (Issue #3455)` — reviewer: met
- **met** — Add a pre-PR self-check step: for each field, prop, parameter or export the diff adds to non-test code, find one production reader or setter (`git grep -n <name> -- . ':!*test*'`) — evidence: the shared paragraph and `prompts/issue/prompt.md:1291`, `worker/deno/tests/production_reader_rule_3455_test.ts::issue prompt PR Summary File step restates the production-reader rule (Issue #3455)` — reviewer: met — reason: the reviewer noted the command is deliberately changed to `git grep -n -w <name>` with the hits read by hand, because the proposed pathspec drops production files (observed, see Evidence)
- **met** — If there is none, remove the member and move the assertion onto the observable output. — evidence: pinned phrase "remove the member and move the assertion onto the observable output" in `worker/deno/tests/production_reader_rule_3455_test.ts` — reviewer: met
- **met** — A member the issue explicitly asks for as public API (for example, a library export) is exempt, and the PR summary says so. — evidence: pinned phrase "explicitly asks for as public API" in `worker/deno/tests/production_reader_rule_3455_test.ts` — reviewer: met
- **met** — Do not relax the reviewer's rule. — evidence: no reviewer prompt touched, and the new rule marks a missing reader as a blocking self-review finding — reviewer: met
- **unrequested** — Entry in `docs/workflows/issue-processing.md` — reviewer: unrequested — reason: that manual records every guideline rule with its provenance, and **A Code Change Owes a Docs Change** applies to the issue-prompt change
- **unrequested** — Drift test `worker/deno/tests/production_reader_rule_3455_test.ts` — reviewer: unrequested — reason: it keeps the two mirrored copies identical and pins the issue-prompt restatement, following the documentation-drift convention
- **unrequested** — The rule defines test code (`#[cfg(test)]` module, fixture, test double) and treats a seam's production default as the setter — reviewer: unrequested — reason: this keeps the self-check honest for Rust's inline tests and stops the rule from contradicting the existing "injected seam" advice
- **unrequested** — The member list includes "type" in the self-check, not only in the rule — reviewer: unrequested — reason: rule 1 of the issue names types, so the check covers the same set

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Test imports resolve, section titles resolve, and no named test is absent. There is no stub of another repository's binary and no workflow change. The diff adds no production member for the new rule to flag. No assertion is removed from an existing test. Spelling is Australian English. Review-enforced rules checked: the reviewer searched for "by review" and "reader has to raise", and the diff breaches neither. Optional note: the pins wrapped across lines depend on `assertPins` flattening whitespace. It does: `assertPins` calls `flat()` in `worker/deno/tests/support/markdown_docs.ts`, and the test passes.

## Test Plan

- Added `worker/deno/tests/production_reader_rule_3455_test.ts` (2 tests). Ran `deno task test:unit tests/production_reader_rule_3455_test.ts tests/failure_record_clear_3430_test.ts tests/coding_guidelines_layers_2574_test.ts tests/existing_rule_conflicts_3077_test.ts tests/insertion_point_rule_3194_docs_test.ts`: 21 passed, 0 failed.
- Red checks:
  - I removed the paragraph from `CODING-STANDARDS.md` only. Test 1 failed with `section is missing pin "**Nothing exists only for a test to read.**"`.
  - I restored the base `prompts/issue/prompt.md`. Test 2 failed with `section is missing pin "**Nothing exists only for a test to read**"`.
  - Both files were restored afterwards.
- Every pinned phrase is absent from its base section. `deno task drift-pins-on-base origin/milestone/fleet-guidance-coding-standards-rules <doc> <section> <phrases…>` reported every phrase as `absent on base` for all three sections:
  - `CODING-STANDARDS.md` "Test-Driven Development (TDD)": 11 phrases.
  - `prompts/coding_guidelines/prompt.md` "Testing Best Practices": the same 11 phrases.
  - `prompts/issue/prompt.md` "PR Summary File": 3 phrases.
- Assertions removed from existing tests: none.
- `./quality.sh` on the head passed. Every stage passed, including `deno tests`, markdownlint and semgrep, except `config integration`, which was skipped.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
