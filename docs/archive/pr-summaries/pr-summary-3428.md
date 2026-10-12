## Summary

Tightens the `exempt (untestable)` branch-outcome exemption so it can no
longer cover dead code (VibeCoder#3312) or an outcome existing tests can reach
behind an unchecked "no existing harness" claim. Closes #3428.

The same five sentences now appear on all four surfaces the issue names
(`CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`,
`prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`):

1. An outcome no input can reach is dead code: remove it, never exempt it.
2. `exempt (untestable)` is for an outcome production can reach but a test
   cannot stage, such as a permission or I/O fault the suite cannot stage
   portably. Its reason names what blocks staging and the harness search: the
   test files that already call the enclosing function or script (a grep of
   the test tree for its name), each with why it cannot reach the outcome.
3. "No existing harness" with no search named is not a reason.
4. An outcome the linked issue asks a test for, in its acceptance criteria or
   Definition of done, cannot be `exempt (untestable)`.

The wording in the gate's own guidance (`worker/deno/lib/branch_outcomes_gate.ts`
problem messages and its issue comment's item 6) now says the same thing, so
the gate's feedback no longer repeats the old "one no test can reach" wording.
The gate's logic is unchanged.

## Spec

### Intent and Rationale

- The old phrase "one no test can reach" described dead code as well as
  outcomes that genuinely can't be staged, so #3312 followed the letter of the
  rule. Splitting the two cases closes that gap.
- Requiring the reason to name the harness search makes a false "no harness"
  claim checkable when the PR is reviewed.

### Essential Design Decisions

- The optional automated check (the gate rejecting a reason that names no test
  path or grep) is not implemented. The issue asks for the rule to stay the
  primary fix so the gate does not turn into a phrase match.
- `CODING-STANDARDS.md` and the coding_guidelines twin carry byte-identical
  paragraphs, and both say plainly that the gate checks only the three-word
  reason count (`EXEMPT_RE` plus `reasonWordCount`).

### Undiscoverable Facts

- The issue was held until PR #3543 landed. That PR is now on the milestone
  base (`b64ee47f`).

## Evidence

Prompt and doc rule change, plus string-only gate guidance; there is no UI.
`worker/deno/tests/branch_outcomes_exempt_3428_test.ts` pins the five shared
sentences in each surface's section.

Related existing rules checked:

- "Every outcome of a branch you add needs a test that reaches it" on all four
  surfaces (edited here).
- `branch_outcomes_gate.ts` guidance strings (aligned here).
- `docs/workflows/issue-processing.md` § branch-outcomes gate (still true).

No other rule on dead code or exemption reasons exists in the prompts or
standards (grep: `dead code`, `Definition of done`, `no existing harness`).

I applied the new rule to this PR's own diff. The diff adds no branch and uses
no exemption, so I found nothing to fix.

Issue numbers the diff adds as provenance:

- #3428: Fleet PRs mark reachable outcomes exempt (untestable): dead code and
  an unverified 'no existing harness' claim pass the branch-outcomes rule
  (VibeCoder#3312 and a private fleet PR)

Independent review (the issue has no Acceptance Criteria section, so no
closure blocks):

- The Standards reviewer reported no violations and no removed assertions.
- The Spec reviewer judged guidance items 1–3 and "one wording" as met.
- It flagged the gate-string alignment and the drift test as outside the four
  named places. Both are kept: the first keeps the gate's own feedback
  consistent with the rule, and the second is the repo's drift-test standard.
- It noted `pr-summary-3298.md` is not cited by path. Its example wording is
  used instead, because the prompts are filed into other repositories, where
  that archive path does not exist.

**Docs sweep** — grep: "no test can reach", `exempt (untestable)`,
`untestable)`; section: `docs/workflows/issue-processing.md` (branch-outcomes
gate paragraph); updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`prompts/pr_feedback/prompt.md`, `worker/deno/lib/branch_outcomes_gate.ts`.
Hits left in place:

- `docs/workflows/issue-processing.md:2021` — still true because the gate
  still accepts any exemption reason of at least three words.
- `worker/deno/lib/branch_outcomes_gate.ts:1101` — still true because the
  three-word reason check is unchanged.

## Test Plan

- Added `worker/deno/tests/branch_outcomes_exempt_3428_test.ts`: four
  section-scoped `assertPins` cases, one per surface. It passed on the final
  head.
- I checked every pin with
  `deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts <doc> <section> <pins…>`
  for all four doc/section pairs. Each of the five pins is reported
  `absent on base` in every section, so each one goes red without this change.
- Existing tests on the touched files passed:
  - `worker/deno/tests/branch_outcomes_gate_test.ts`,
    `worker/deno/tests/branch_outcomes_admission_3288_test.ts`,
    `worker/deno/tests/completion_phase_branch_outcomes_test.ts` and the other
    branch-outcome suites: 242 passed.
  - `worker/deno/tests/coding_guidelines_twin_drift_test.ts` and the other
    coding_guidelines suites: 26 passed.
  - The 54 test files that read the issue or pr_feedback prompt: 270 passed.
- No existing test was edited and no assertion was removed.
- `./quality.sh < /dev/null`: PASSED (config integration SKIPPED, as on every
  local run).

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
