## Summary

`buildReproductionGateComment` no longer tells the agent the reproduction must
be recorded "before the PR is raised". Since Issue #4234 the reproduction gate
is advice: the verdict is reported once in the session, and whatever remains is
posted on the raised PR under "They did not block this pull request". The
comment and its JSDoc now describe that flow, matching the sibling closure-gate
comment (#4513) and the unmet-criteria note (#4469). Closes #4578.

## Spec

### Intent and Rationale

- The reviewer note otherwise contradicted itself: "did not block this pull
  request" sat above "before the PR is raised". Rewording the one builder fixes
  both the in-session report and the reviewer note, because both use it.

### Essential Design Decisions

- Only the comment text and JSDoc changed; the gate's verdict logic and the
  `Reproduction status missing` heading (asserted by
  `completion_phase_summary_rule_retry_test.ts`) are untouched.
- The module header's "gated at the same PR-creation chokepoint" line was left
  as it is: it names where the gate runs, not that it withholds the PR.

### Undiscoverable Facts

- None.

## Evidence

Backend text change. Tests run from `worker/deno`:

- `deno task test:unit tests/reproduction_status_gate_test.ts tests/completion_phase_reviewer_note_folds_4583_test.ts`
  — 21 passed, 0 failed.
- `deno task test:unit tests/completion_phase_summary_rule_retry_test.ts` — 15
  passed, 0 failed.
- `deno fmt --check` and `deno lint` on the two touched files — clean.

The issue's own wording was the spec: the comment must say "raised anyway" and
make no withheld-PR claim.

## Test Plan

- Added
  `worker/deno/tests/reproduction_status_gate_test.ts::buildReproductionGateComment - does not claim the PR is withheld or that a gate blocks`,
  modelled on the closure-gate test in
  `worker/deno/tests/acceptance_criteria_gate_test.ts`.
  - Red check: it failed against the unfixed comment (`20 passed | 1 failed`),
    and again when only the old opening string was restored; it passes with the
    fix.
- No existing test was edited; no assertion was removed.
- Existing callers checked: `completion_phase.ts` (`reproductionVerdict`) passes
  the builder as `comment`; `completion_phase_reviewer_note_folds_4583_test.ts`
  and `completion_phase_summary_rule_retry_test.ts` still pass.
- Docs: grepped `README.md`, `docs/` and `prompts/` for "before the PR is
  raised", "Reproduction status missing" and "reproduction gate blocks"; no
  manual quotes the old comment text.
- Not checked: the full `./quality.sh`. It was started under a 600 s limit and
  was killed before finishing, so it is left to CI and the worker's pre-PR run.

<!-- vibe-quality-gate-skipped reason="./quality.sh exceeded the 600 s foreground limit and was terminated; targeted tests, fmt and lint pass; CI runs the full gate" -->
