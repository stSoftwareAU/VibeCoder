## Summary

Adds the rule **State recorded on a failure path is cleared on the path that
recovers** to `CODING-STANDARDS.md`, directly after **Code that deletes or
replaces state proves everything it destroys is safe to lose**. The rule text is
copied word for word into the `coding_guidelines` prompt, restated in the issue
prompt's Test Plan step (PR Summary File), and recorded in the issue-processing
manual. A drift test pins it. Closes #3430.

## Spec

### Intent and Rationale

- Two fleet PRs wrote a degraded streak or an ineligible ledger entry on the failure path and never cleared it when a later run found the condition gone. Their tests stubbed the record helper. A self-review rule that pairs each set with every clear, plus a lifecycle test through the real helper, catches both cases.
- Agents see the `coding_guidelines` prompt, not `CODING-STANDARDS.md`. The test-coverage rules are mirrored word for word between the two, as #3107 and #3429 did, so the rule goes on both surfaces.

### Essential Design Decisions

- The paragraph is identical on both surfaces, and the drift test asserts this, as `worker/deno/tests/destructive_state_inventory_3107_test.ts` does for its rule.
- A record held in shared GitHub state (a label, a marker comment) is cleared only as **Remove only what you can prove you added** allows. Without this the new rule would contradict that existing one.
- The lifecycle test uses the real helper "against a temporary store", so the test does not touch host state.

### Undiscoverable Facts

- Both source PRs are in private fleet repos. The issue describes them only in prose, so the manual entry describes them the same way, without links.

## Evidence

Documentation and prompt change only (no UI, no runtime code). Both surfaces carry the rule identically, and `worker/deno/tests/failure_record_clear_3430_test.ts` pins it.

**Docs sweep** — grep: "set/clear", "never cleared", "nothing clears", `first_seen`, "cleared on the path that recovers", "Code that deletes or replaces state"; section: `CODING-STANDARDS.md#test-coverage-expectations` (sibling of the #3107 destructive-state rule); updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`; every hit on the head is in lines this diff adds, so no hit is left in place.

Related existing rules checked:

- **Code that deletes or replaces state proves everything it destroys is safe to lose**: the new rule sits beside it and does not change it.
- **Remove only what you can prove you added**: the new rule defers to it for labels and marker comments.
- **Changing the Shape of Persisted Data**: covers type changes, not clearing, so there is no overlap.
- **Never let a unit test inherit the host's state**: the "temporary store" wording agrees with it.
- **A new test must go red without its change**: the "delete the clear and confirm the test goes red" step applies that rule.

I applied the new rule to this PR's own diff. The diff writes no persistent record of a bad condition, so there are no set/clear pairs to list.

Issue numbers the diff cites as provenance:

- #3430: Fleet PRs record a degraded or ineligible state on the failure path but never clear it on a later healthy run (two private fleet PRs)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Add a rule to `CODING-STANDARDS.md` next to **Code that deletes or replaces state proves everything it destroys is safe to lose** — evidence: `CODING-STANDARDS.md:611`, `worker/deno/tests/failure_record_clear_3430_test.ts::both surfaces carry the failure-record-clear rule, identical, right after the destructive-state rule (Issue #3430)` — reviewer: met
- **met** — A drift test in `worker/deno/tests/` pins the new rule's heading in `CODING-STANDARDS.md` — evidence: `worker/deno/tests/failure_record_clear_3430_test.ts` — reviewer: met
- **partial** — In later review-fleet-prs rounds, findings of the form "the entry, streak or marker set on failure is never cleared on a healthy run" stop appearing in fleet PRs that add such records — evidence: the rule in `prompts/coding_guidelines/prompt.md:1383` and `prompts/issue/prompt.md:1282` — reviewer: missing — reason: the reviewer said this cannot be checked from a diff. It is an outcome of later fleet runs, and this diff contains the only change that can bring it about: the guidelines and issue-prompt rule.
- **partial** — Fleet PRs that add such a record list the set/clear pairs they checked in the PR summary — evidence: `prompts/issue/prompt.md:1287`, `worker/deno/tests/failure_record_clear_3430_test.ts::issue prompt PR Summary File step restates the failure-record-clear rule (Issue #3430)` — reviewer: partial — reason: the requirement is in place and pinned, but whether future PRs comply can only be seen in later runs.
- **unrequested** — The rule is copied into `prompts/coding_guidelines/prompt.md` — reviewer: unrequested — reason: agents read that prompt, not `CODING-STANDARDS.md`, and the test-coverage rules are mirrored word for word (precedent: #3107, #3429).
- **unrequested** — The rule is restated in the issue prompt's PR Summary File Test Plan step — reviewer: unrequested — reason: this is how fleet PRs come to "list the set/clear pairs they checked in the PR summary" (How to verify, bullet 3).
- **unrequested** — A paragraph is added to `docs/workflows/issue-processing.md` — reviewer: unrequested — reason: that manual records each Test Plan rule with its provenance, and **A Code Change Owes a Docs Change** applies to the issue-prompt change.
- **unrequested** — The rule adds a shared-GitHub-state clause, "against a temporary store", and "List the set/clear pairs checked" — reviewer: unrequested — reason: the first avoids contradicting **Remove only what you can prove you added**, the second keeps lifecycle tests off host state, and the third serves How to verify, bullet 3.
- **unrequested** — The drift test also checks that both surfaces are identical and that the issue prompt restates the rule — reviewer: unrequested — reason: this guards the mirrored copies added above.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Documentation-drift conditions 1–4 (section-scoped via `section()`/`excerpt`, prose-only rule, no retyped constants, every pin new and none subsumed). No assertion removed from an existing test. No conflict with **Remove only what you can prove you added** or the destructive-state rule. The paragraph is identical on both surfaces. Australian English. Review-enforced rules checked: no raw whole-page `includes`, no home-made whitespace-collapsing helper, no `flatWholeFile` positive pin. Optional note: "the issue prompt's Test Plan step" in `docs/workflows/issue-processing.md`. I left it as is, because the restatement sits in Test Plan item 7 of the PR Summary File section, and the #3107 entry uses the same wording.

## Test Plan

- Added `worker/deno/tests/failure_record_clear_3430_test.ts` (2 tests). Ran `deno task test:unit tests/failure_record_clear_3430_test.ts tests/destructive_state_inventory_3107_test.ts tests/failure_reason_cause_3429_test.ts tests/coding_guidelines_layers_2574_test.ts`: all pass.
- Red-checks:
  - I deleted the new paragraph from `CODING-STANDARDS.md` only, and test 1 failed with `section is missing pin "**State recorded on a failure path is cleared on the path that recovers.**"`.
  - I restored the base `prompts/issue/prompt.md`, and test 2 failed with `section is missing pin "**State recorded on a failure path is cleared on the path that recovers**"`.
  - Both files were restored afterwards.
- Every pinned phrase is absent from its base section. I ran `deno task drift-pins-on-base origin/milestone/fleet-guidance-coding-standards-rules <doc> <section> <phrases…>` for all three sections, and each exited 0 with every phrase listed as `absent on base`:
  - `CODING-STANDARDS.md` "Test coverage expectations": 10 phrases.
  - `prompts/coding_guidelines/prompt.md` "Test Coverage Expectations": the same 10 phrases.
  - `prompts/issue/prompt.md` "PR Summary File": 3 phrases.
- Assertions removed from existing tests: none.
- `./quality.sh`: the first run failed at the `deno tests` stage. Its output was truncated, so I could not identify the failing test. The second run on the same head passed every stage, including `deno tests` (parallel 6m00s, serial 2m21s, real execution, no cache), with `config integration` skipped. That points to a flaky test unrelated to this documentation-only diff.

Branch outcomes: none added
