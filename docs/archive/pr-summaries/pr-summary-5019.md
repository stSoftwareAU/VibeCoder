# Scope test discovery to the current change

Closes #5019

## Summary

Routine feature and review-fix prompts previously demanded deliberate code
breaks for every caller, branch operand, pipeline step and documentation pin.
They now require meaningful positive, negative and boundary coverage of the
current change, repeatable regression tests for existing features, and a
failing regression test before fixing a later diagnosed bug. Existing coverage
may suffice for presentation changes such as moving a button.

Standards and injected guidelines agree. The issue, feedback, review and
standalone test-audit prompts, contributor guide and workflow manuals now
separate ordinary regression work from explicitly requested discovery.
Production-default wiring, discriminating fixtures, live-source documentation
pins and honest evidence remain required. No production behaviour, test runner,
workflow YAML, dependency, quality threshold or security check changes here.

## Spec

### Intent and Rationale

- Owner decision: assess missing tests during feature development/review; run
  existing deterministic regressions during later unrelated work.

### Essential Design Decisions

- Change the existing rules and their prompt restatements together; keep real
  production-path and meaningful-assertion requirements.
- Keep the two executable workflow retirements in #5095 and #5096 explicit.

### Undiscoverable Facts

- The owner considers automatic discovery cost during an ordinary button move
  outside the requested feature scope.

## Runtime boundary

The worker still invokes automatic mutation testing: #5095 owns its retirement.
The idle filer can still select a static coverage-gap audit: #5096 owns making
that separately requested work. The manuals explicitly record both pending
changes; changing prompts alone does not disable either path.

## Test Plan

The obsolete behaviour is the requirement to run synthetic mutations or
per-pin/per-caller proof campaigns as routine PR evidence. Documentation
assertions enforcing that policy are replaced with checks of meaningful
coverage review, current-change scope and later-bug TDD. The table below names
remaining checks in each changed test file. Existing behavioural tests of the
documentation helpers and baseline comparison utility remain intact; no test
file or production regression case was deleted, skipped or weakened to hide a
failure. The owner explicitly changed this documentation contract in #5019.

| Changed test file | Remaining or replacement coverage |
| --- | --- |
| `worker/deno/tests/branch_outcome_coverage_3069_test.ts` | `both surfaces carry the branch-outcome rule (Issue #3069)` |
| `worker/deno/tests/branch_outcomes_exempt_3428_test.ts` | `CODING-STANDARDS.md preserves honest staging limitations` |
| `worker/deno/tests/changed_call_site_red_3067_test.ts` | `both surfaces carry the changed-call-site-must-go-red rule (Issue #3067)` |
| `worker/deno/tests/coding_guidelines_twin_drift_test.ts` | `twin pair - both surfaces reject tests added only for coverage (Issue #2810)` |
| `worker/deno/tests/compound_condition_operands_3376_docs_test.ts` | `both surfaces carry the compound-condition rule (Issue #3376)` |
| `worker/deno/tests/drift_pin_source_value_3655_docs_test.ts` | `new-test rule delegates to canonical live-value guidance` |
| `worker/deno/tests/drift_pins_on_base_3193_test.ts` | `pinsAlreadyInSection - lists only the phrases the base section already held` |
| `worker/deno/tests/e2e_browser_check_run_3250_test.ts` | `issue prompt's Error Recovery section requires running e2e checks against the baked Chromium (Issue #3250)` |
| `worker/deno/tests/edited_expectation_red_3374_docs_test.ts` | `both surfaces carry the edited-expectation rule (Issue #3374)` |
| `worker/deno/tests/entry_point_wiring_3222_test.ts` | `both surfaces widen the changed-call-site rule to a single entry point and UI controls (Issue #3222)` |
| `worker/deno/tests/failure_reason_cause_3429_test.ts` | `both surfaces carry the failure-reason-cause rule in Never Fail Silently (Issue #3429)` |
| `worker/deno/tests/failure_record_clear_3430_test.ts` | `both surfaces carry the failure-record-clear rule, identical, right after the destructive-state rule (Issue #3430)` |
| `worker/deno/tests/negative_test_must_fail_3060_test.ts` | `both surfaces carry the negative-test-must-fail rule (Issue #3060)` |
| `worker/deno/tests/new_branch_reachable_3167_test.ts` | `both surfaces carry the reachable-branch rule (Issue #3167)` |
| `worker/deno/tests/new_path_keeps_guards_3087_test.ts` | `both surfaces carry the new-path guard rule (Issue #3087)` |
| `worker/deno/tests/new_test_must_go_red_3093_test.ts` | `both surfaces carry the new-test-must-go-red rule (Issue #3093)` |
| `worker/deno/tests/pr_feedback_red_on_base_3381_test.ts` | `pr_feedback prompt recounts the red-on-base result after a review fix (Issue #3381)` |
| `worker/deno/tests/refusal_test_rule_3162_test.ts` | `both surfaces carry the refusal-test rule (Issue #3162)` |
| `worker/deno/tests/rescoped_drift_pins_3307_test.ts` | `assertPins - passes when every pin is present, including one that spans the line wrap` |
| `worker/deno/tests/sibling_value_fixture_3851_docs_test.ts` | `both surfaces carry the sibling-value rule (Issue #3851)` |
| `worker/deno/tests/test_named_for_step_3666_docs_test.ts` | `both surfaces carry the per-step rule (Issue #3666)` |

Validation:

- Documentation regression selection (119 files importing the Markdown helper):
  653 passed. This includes the revised twin-guidance scope assertions.
- Completeness/manifest selection derived by `check_manifests.ts --list`:
  866 passed, 1 existing ignored case across 55 files.
- Both selections above used Deno 2.9.5 with a temporary, uncommitted import map
  to the official denoland/std checkout at
  `f834d0223364361169314833e3c7a8f62ce11d58`, with `--no-check`. JSR was unreachable
  here. These are supplementary behaviour checks, not a claim that the pinned
  dependency CI gate passed; neither the import map nor dependencies changed.
- Deno lint and formatting passed for the changed TypeScript test files.
- Markdown structural lint passed (251 files at that run); `git diff --check`
  passed. The final added audit-scope paragraphs and this summary are linted
  separately as well.
- Standard frozen Deno tests and `check:manifests` could not load
  `https://jsr.io/@std/assert/meta.json`. The full quality attempt did not pass;
  it also lacked configured security scan tools/credentials and was bounded
  locally. CI must validate the normal pinned environment.
- No mutation or fuzzing campaign was run.

## Consistency review

Checked the existing TDD, new-test, wrong-input, edited-expectation,
changed-caller, branch-outcome, pipeline-step, refusal, new-path guard,
failure-cause, failure-record-clear and documentation-drift rules, plus their
issue/review/workflow restatements. Replaced conflicting mandatory code-break
procedures in place rather than adding an exception over them. Applied the new
rule to this diff: these are documentation contract changes, so the existing
documentation regressions were updated; runtime retirement remains explicitly
pending, and no red test result or full quality pass is claimed.

## Acceptance Criteria

- **met** — Standards and injected guidelines agree on current-change coverage,
  deterministic regressions and later-bug TDD. Evidence: the shared scope
  paragraphs and `coding_guidelines_twin_drift_test.ts`.
- **met** — Implementation and review prompts no longer require automatic
  mutation/fuzzing or per-caller/per-operand/per-pin code breaks. Evidence:
  `prompts/issue`, `prompts/pr_feedback`, `prompts/pr_review_brief` and the
  corresponding documentation regressions.
- **met** — Production-default coverage and outcome-based fake guidance remain
  explicit. Evidence: the changed-call-site rule on both guideline surfaces
  and `entry_point_wiring_3222_test.ts`.
- **met** — Documentation distinguishes policy from pending runtime retirement.
  Evidence: `docs/mutation-check.md`, the workflow manuals and
  `docs/TEST-AUDIT-SCAN.md` identify #5095 and #5096 as unimplemented here.
- **met** — Relevant documentation regression, formatting and lint checks were
  run, with unavailable checks reported. Evidence: Test Plan above; the normal
  pinned dependency environment still requires CI validation.

## Standards Review

Independent review is pending. No reviewer verdict or provenance marker is
claimed. Local review checked the paired rules and their restatements; the
summary checker reports the missing independent review as advisory.

## Merge verification

- Required CI in the normal pinned environment: pending.
- Independent Spec/Standards review and code review approval: pending.
- `pr-summary-check`: executed; independent-review provenance is unavailable
  in this session. This is not a passed review gate.
