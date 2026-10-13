## Summary

Adds a new test-coverage rule, **A new precondition must not stop existing
tests short**. It extends the existing later-refusal re-run, which covered
only refusals, to any precondition a change adds before existing logic: a
check, an early return, a null or disabled result, or an environment
requirement such as a git repository, git identity, config value, network
or clock. The rule:

- asks the author to confirm each existing test of the changed function
  still reaches the logic it asserts on, paying most attention to negative
  tests;
- makes a test that now stops at the new precondition a blocking
  self-review finding;
- requires a fixture that meets the precondition, plus a positive control;
- requires the Test Plan to name the existing tests that needed fixture
  changes.

The paragraph is word for word the same in `CODING-STANDARDS.md` and
`prompts/coding_guidelines/prompt.md`. A new drift test pins it, and the
operator manual records it beside the #3162 entry. Closes #3530. The issue's
30-day measurement criterion stays `partial`: it can only be observed in
review logs after merge.

## Spec

### Intent and Rationale

- Two fleet PRs (#3388, #3522) added an earlier precondition that left
  unedited negative tests vacuous. The old re-run sentence said "refusal",
  so it did not cover a precondition that switches a feature off, such as
  #3522's null cache key.
- I added a new paragraph rather than rewording the refusal sentence. That
  sentence stays true as the refusal case, and its existing #3162 pins and
  its echoes in the issue and pr_feedback prompts stay unchanged and
  consistent.

### Essential Design Decisions

- The new paragraph sits directly after the refusal-test rule on both
  surfaces, because it says "the refusal-test rule above". The drift test
  checks both that placement and that the two surfaces are identical.

### Undiscoverable Facts

- `denoCheckDigest` (`worker/deno/lib/quality_gate.ts:1272`) returns
  `Promise<string | null>` and gives null when the working-tree digest
  cannot be computed. The rule's positive-control example is valid code
  against it.

## Evidence

This is a documentation and prompt change. No production code changes, and
there is no UI.

- `worker/deno/tests/earlier_precondition_rule_3530_test.ts` reads both
  test-coverage sections through `section()` and `flat()`. It asserts that
  the 8 key phrases are present, that the paragraph comes after the
  refusal-test rule, and that it is identical on both surfaces.
- Related existing rules I checked:
  - **A refusal test must be refused by the rule it names**: its re-run
    sentence is kept, and the new rule extends it.
  - **A negative test must be able to fail**: it covers new guards; the
    new rule covers existing tests behind a new precondition. They do not
    conflict.
  - **An edited expectation must still go red without its guard**: it
    covers edited tests, not unedited ones, so it does not overlap.
  - The issue prompt's Test Plan step (`prompts/issue/prompt.md:1300`) and
    the pr_feedback **A refusal finding is fixed at the rule it names**
    still describe the refusal case accurately.
- I applied the new rule to this PR's own diff and found nothing. The diff
  adds no precondition to any code path. The new test's only early check is
  an `assert` that fails loudly when the paragraph is missing.
- Issue numbers this diff cites as provenance:
  - #3530: Fleet PRs add an earlier precondition (git repo, commit
    identity) and existing negative tests silently stop reaching the guard
    they pin (VibeCoder#3388, #3522)
  - #3388: Milestone: #3346 worker deno: Floci audit check
  - #3522: Quality-gate test cache ignores non-TS inputs, so summary and
    doc edits reuse a stale PASS and fail in CI (Issue #3392)

**Docs sweep** — grep: "refusal that runs before", "precondition must not stop", "A negative test must be able to fail"; section: `docs/workflows/issue-processing.md#a-refusal-test-must-be-refused-by-the-rule-it-names-issue-3162`; siblings: "A refusal test must be refused by the rule it names", "A negative test must be able to fail"; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `docs/workflows/issue-processing.md`; `prompts/issue/prompt.md:1300` — still true because it describes the refusal case, which the new rule keeps; `prompts/pr_feedback/prompt.md:129` — still true for the same reason

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — widen the re-run sentence from refusals to any new precondition; find the existing tests of the changed function and confirm each one still reaches the logic it asserts on; a test that now stops at the new precondition is a blocking self-review finding — evidence: `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` new paragraph; `worker/deno/tests/earlier_precondition_rule_3530_test.ts::both surfaces carry the earlier-precondition rule (Issue #3530)` — reviewer: met
- **met** — the fix gives the fixture what the precondition needs and adds a positive control — evidence: same paragraph (`git init -q`, `assert(await denoCheckDigest(config) !== null)`); pinned by the same test — reviewer: met
- **met** — if the precondition is a new environment requirement, the Test Plan names the existing tests that needed fixture changes, or says that none did and how that was checked — evidence: same paragraph's last rule sentence; pinned by the same test — reviewer: met
- **met** — a prompt-contract or drift test that the coding guidelines carry the widened sentence and the positive-control requirement — evidence: `worker/deno/tests/earlier_precondition_rule_3530_test.ts::both surfaces carry the earlier-precondition rule (Issue #3530)` — reviewer: met
- **partial** — over the next 30 days, the review-fleet-prs `log.jsonl` records no new blocking finding where an unedited existing test became vacuous — evidence: `CODING-STANDARDS.md` rule that review rounds will check against — reviewer: missing — reason: the reviewer said this is "a post-merge, observational outcome … not applicable to the diff and not a defect in it"; no diff can show it, and the rule it measures ships here
- **unrequested** — the new paragraph in `docs/workflows/issue-processing.md` — reviewer: unrequested — reason: that manual records each test-coverage rule by issue (#3060, #3162, #3069), so the docs sweep requires the new sibling there
- **unrequested** — the provenance sentence citing stSoftwareAU/VibeCoder#3388 and #3522 in the rule — reviewer: unrequested — reason: it matches how neighbouring rules cite the fleet PRs that motivated them
- **unrequested** — the drift test's ordering and identical-text assertions — reviewer: unrequested — reason: the paragraph says "the refusal-test rule above", and the two surfaces are declared twins

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no violations. The reviewer checked and found compliant:
  - Australian English.
  - Drift-test conditions: section-scoped through `section()` and `flat()`,
    pins prose rather than code constants, and pins absent from base.
  - The named test exists in the diff.
  - No existing-test assertion is removed or edited.
  - No stubs or workflow changes.
  - No stale cross-reference left in either guidelines copy.
- **optional** — the test file is not named `*_docs_test.ts`. It follows
  the `refusal_test_rule_3162_test.ts` naming instead.

## Test Plan

- Added `worker/deno/tests/earlier_precondition_rule_3530_test.ts`. On the
  final head, `deno task test:unit` over it plus
  `worker/deno/tests/refusal_test_rule_3162_test.ts`,
  `worker/deno/tests/coding_guidelines_twin_drift_test.ts` and
  `worker/deno/tests/negative_test_must_fail_3060_test.ts` passed (16
  passed, 0 failed). The new test passed on its own (1 passed) after the
  last pin was added.
- Red checks on the new test:
  - Deleting "A test that now stops at the new precondition is a blocking
    self-review finding." from `prompts/coding_guidelines/prompt.md` only
    turned it red. The error was
    `coding_guidelines is missing "A test that now stops at the new precondition is a blocking self-review finding"`.
  - Deleting "any" from "the same holds for any precondition" in
    `CODING-STANDARDS.md` only turned it red. The error named that phrase
    as missing.
  - Both files were restored byte-identical, and the test went green again.
- `deno task drift-pins-on-base origin/main` printed `absent on base` for
  all 8 pinned phrases. It checked the `CODING-STANDARDS.md` section
  "Test coverage expectations" and the `prompts/coding_guidelines/prompt.md`
  section "Test Coverage Expectations":
  - "the same holds for any precondition a change adds before existing
    logic"
  - "a git repository, a git identity, a config value, the network or the
    clock"
  - "confirm each one still reaches the logic it asserts on"
  - "they stay green when the path is skipped"
  - "A test that now stops at the new precondition is a blocking
    self-review finding"
  - "add a positive control: an assertion that the precondition holds"
  - "the same fixture with only the probed value changed reaching the other
    outcome"
  - "names the existing tests that needed fixture changes, or says that
    none did"
- No existing test is edited, so no assertion is removed and no expectation
  needs a red check.
- `./quality.sh < /dev/null` passed. Config integration was skipped by the
  gate itself.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
