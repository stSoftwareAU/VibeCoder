## Summary

`sanitiseField` in `worker/deno/lib/closure_verdict.ts` no longer turns every `_` and `*` into a space, and now replaces markup characters before the label-keyword scrub. Cited files such as `test/creature/CheckpointWriteDanglingMemetic_test.ts` and `docs/API_REFERENCE.md` render unchanged, and a split label such as `reviewer_:` can no longer forge a `reviewer:` field. Closes #4844.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Underscores between word characters carry no Markdown structure and are common in file names, so they are kept; the replace-first ordering lets the label scrub see a label split by markup whole.

### Essential Design Decisions

- A `*` or `_` is kept only when it sits between two ASCII alphanumerics; backticks and `|` are always blanked. This applies to every sanitised field (not only evidence), which keeps one rule for all fields.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. Verified with `deno task test:unit` from `worker/deno`.

## Test Plan

- Added in `worker/deno/tests/closure_verdict_test.ts`: "word-internal underscores and asterisks in cited names survive" and "a label split by markup cannot forge a departing verdict" (covers `reviewer_:` and ``reviewer`:``).
- Red check: with the old `sanitiseField` body restored, both new tests failed (`src/a b/c test.ts`, `API REFERENCE.md`; reviewer verdict read `met` instead of `missing`); both pass with the fix.
- `deno task test:unit tests/closure_verdict_test.ts`: 27 passed, 0 failed. Other importers (`closure_verdict_prompt_test.ts`, `closure_verdict_recovery_test.ts`, `completion_phase_closure_render_test.ts`, `fence_coverage_verifier_test.ts`, `standing_violation_3196_test.ts`, `summary_rule_gate_retry_test.ts`, `tool_output_treat_as_data_3046_test.ts`): 67 passed, 0 failed.
- Not separately observed: the backtick split variant going red on its own (the loop stops at the first failure; both variants share the same code path).
