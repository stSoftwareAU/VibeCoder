## Summary

The pr_feedback prompt now tells a review-fix run to answer every ask in a
change-request finding, not only the finding. Before changing anything, the run
breaks each finding into its asks: every separate change its **Fix** requests,
plus every case its problem text says is affected (lettered parts, "also", "as
well as", "the same way", a second input or path, a request to record observed
output in the PR summary). It lists those asks under each finding in
`.pr_response_message`, each with the commit, test or line that settles it or a
rebuttal with evidence. It also counts the asks it listed against the
requesting sentences in the **Fix**. The operator manual
(`docs/workflows/pr-feedback.md`) documents the rule, and a drift test pins
both. Closes #3348.

## Spec

### Intent and Rationale

- The existing rules ("Every change-request finding ends fixed or rebutted" and the `.pr_response_message` finding list) work per finding, so a finding with three asks counted as answered once one was done (VibeCoder#3312, VibeCoder#3318, GRQ-AutoTrader#2699).
- The new paragraph sits directly after its twin and ties a skipped ask back to it: a partly answered finding does not end **fixed**.

### Essential Design Decisions

- The issue's optional "cheap check" is implemented as a prompt instruction (count listed asks against the Fix's requesting sentences before replying), not as worker code. No worker step parses `.pr_response_message` per finding today, and adding one would be a new gate outside this issue's proposed guidance.
- The rule names its difference from **Fix the defect everywhere it lives** (#3114): that rule finds instances the finding did not name, and this one covers the parts it did name.

### Undiscoverable Facts

- `CODING-STANDARDS.md` has no twin of "ends fixed or rebutted" (`grep -n -i rebut CODING-STANDARDS.md` finds nothing), so the issue's conditional "mirror it in `CODING-STANDARDS.md` if the twin rule lives there" does not apply. The rule is mirrored in the pr_feedback operator manual instead.

## Evidence

Prompt and docs change only, so there is no UI surface. The new drift test
`worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts` pins the rule in
the prompt's Making Changes and Response Message sections and in the manual.

**Docs sweep** — grep: "rebut\w*", "fixed or rebutted", "each Automated Review Comments finding", "finding addressed", "every ask"; section: `docs/workflows/pr-feedback.md#every-finding-ends-fixed-or-rebutted-issue-2917`; updated: `prompts/pr_feedback/prompt.md`, `docs/workflows/pr-feedback.md`; `docs/USAGE.md:752` — still true because it describes when a claim retires (fixed, rebutted, handed off or escalated), which this change does not alter; `prompts/planning/prompt.md:174`, `prompts/planning_critique/prompt.md:156`, `prompts/quorum_judge/prompt.md:68` — still true because "every ask" there means an issue's asks in planning and judging, not review findings.

**Related existing rules checked:** `prompts/pr_feedback/prompt.md` — "Every change-request finding ends fixed or rebutted" (the new rule refines it and agrees: a partly answered finding is not fixed), "Fix the defect everywhere it lives, not only where the finding points" (complementary, and the new rule says how they differ), "\"No change\" is not an answer to a change request" (agrees: each ask needs a fix or a rebuttal with evidence), the Response Message finding list (extended to list the asks), and the Automated Review Comments false-positive rule (agrees). `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` have no rule on answering review findings.

**Applied the new rule to this PR's own diff:** the diff answers no review, so it has no finding to break into asks. The Response Message `### Example` lists single-ask lint findings, which already pass the rule. Nothing found.

**Provenance numbers added:** #3348: Review-fix runs do one ask of a multi-part finding and leave the rest: the next review says 'one part of the earlier review is still not done' (VibeCoder#3312, #3318, GRQ-AutoTrader#2699). The PRs cited as examples are VibeCoder#3312 (Branch-outcomes gate passes entries that admit 'no test reaches it' …), VibeCoder#3318 (fix: idle-inversion on stSoftwareAU/GRQ-AutoTrader …) and GRQ-AutoTrader#2699 (Policy: replace ceiling_below_target_percent with minimum_upside_percent), each checked with `gh pr view`.

## Test Plan

- Added `worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts`, which has three drift tests:
  - `pr_feedback Making Changes answers every ask in a finding (Issue #3348)` pins the rule's phrases and checks that it sits after "Every change-request finding ends fixed or rebutted".
  - `pr_feedback Response Message lists the asks under each finding (Issue #3348)`.
  - `pr-feedback manual documents answering every ask (Issue #3348)`.
- Red check: with the prompt and manual edits reverted and the new test kept, `deno task test:unit tests/pr_feedback_every_ask_3348_docs_test.ts` reported `FAILED | 0 passed | 3 failed`. With the edits restored, all three pass.
- Per-pin base check (`deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts …`): every pinned phrase is reported `absent on base` in its section. Making Changes: "break each finding into its asks", "every separate change its **fix** requests", "\"the same way\"", "list the asks under each finding", "the commit, test or line that settles it, or a rebuttal with evidence", "count the asks you listed for each finding", "leaves the finding partly fixed", and the paragraph heading. Response Message: "the asks under each finding with the commit, test or line that settles each one". The manual section does not exist on base.
- No existing test edited, so no assertions removed.
- `deno task test:unit` on the new test plus `worker/deno/tests/pr_feedback_defect_class_3114_test.ts` and `worker/deno/tests/pr_feedback_reviewer_no_change_docs_test.ts`: `ok | 8 passed | 0 failed`.
- `./quality.sh < /dev/null` on commit c762d05a (the final code, test and docs head before this summary was added): `Result: PASSED (with skipped checks)` — every stage passed; `config integration` was skipped by the gate itself.

**Branch outcomes:** none added
