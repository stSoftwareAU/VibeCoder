# PR Summary — Issue #2576

## Summary

The `prompts/*` templates had already been cleaned of shouted rules, but the
strings the TypeScript builders splice into prompts had not. This PR rewrites
each string listed in the issue in the house style: say what to do, give the
reason in one clause, and use no capitals for emphasis. Closes #2576.

- **`prompt_builder.ts`**
  - The screenshot retry notice is now the exported
    `buildScreenshotRetryNotice()`. It no longer says `**CRITICAL**`,
    `you MUST` or `Do NOT skip`. It states the stakes as the reason: the PR
    validation gate blocks a PR without a committed image.
  - Milestone branch targeting:
    - the heading loses `IMPORTANT:`;
    - "you MUST target" becomes the reason the milestone branch exists;
    - "Do NOT omit `--base`" becomes "Keep the flag … without it the PR opens
      against the default branch".
  - Milestone assignment loses `IMPORTANT:` and `You **MUST**`, and gains the
    reason: an unassigned sub-issue is never scheduled with its siblings.
- **One milestone-assignment source.** `buildMilestoneAssignmentSection()` is
  now exported and used by all four sites: the two planning builders and the
  three `planning_processor.ts` fallback and retry prompts, which replace their
  three hand-written copies.
  - Security side effect: those three copies spliced the GitHub-controlled
    milestone title straight into an instruction. The shared section keeps it
    inside the untrusted fence, and the integrity block now names "the
    milestone title" as untrusted.
- **`planning_processor.ts`**
  - The planning retry no longer says "did NOT … You MUST … Do NOT just
    describe". It says to create the sub-issues now, because the worker checks
    for real ones after the turn.
  - The critique fallback's "Do NOT post your critique" now gives its reason:
    rejected draft ideas in the thread read as commitments.
- **`clarity_assessment.ts`**
  - `IMPORTANT:` and `DO NOT ask` become a positive instruction with a reason.
  - `CRITICAL RULES - You MUST follow these` becomes "Decision rules — each
    exists because a clarification loop stalls the issue".
  - `STRONG preference` becomes "Strongly prefer".
  - Both `NEVER` rules are reworded with their reasons.
  - Round ≥2 "You MUST respond with CLEAR" becomes "Respond with CLEAR …
    another round now costs more than a wrong guess".
  - The default-to-CLEAR intent and the real-blocker carve-outs (rules 5 and 7)
    are unchanged.
- **`claude_runner.ts`** (`SUMMARISE_SYSTEM_PROMPT`): `IMPORTANT:`, `Do NOT add
  any preamble` and `Output ONLY` become an "Output rules" list with the
  reason.
- **Rubric.** `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` gains three model rows,
  each citing its Anthropic page:
  - M1, no re-verification instructions, from Opus 5;
  - M2, no reasoning written into the response (`reasoning_extraction`), from
    Opus 5.5;
  - M3, unattended stops named, from Opus 5.5.

  It also adds them to the verdict-table template, and scores the four files
  against rows 2 and 10 and M1–M3. `docs/REFERENCES.md` credits the Opus 5
  page for M1 and adds an Opus 5.5 credit row for M2 and M3. The parts of the
  Opus 5.5 page not yet adopted stay in "Read, not yet adopted".
- Left as it is, on purpose: the `prompt_delimiter.ts` injection-boundary text.
  The new test cuts it out before scanning, and a comment in the test says why.

## Evidence

Backend and prompt change, with no web interface to screenshot.

Rendered sizes, in bytes, before (`origin/main`) and after. The approximate
token count is bytes ÷ 4.

| Rendered prompt | Before | After | Δ |
|---|---|---|---|
| issue, user turn (screenshot retry + milestone branch) | 54,559 | 54,540 | −19 |
| planning, user turn (milestone) | 20,890 | 20,873 | −17 |
| planning single-pass fallback (milestone) | 6,865 | 7,541 | +676 (~+170 tokens) |
| planning retry (milestone) | 3,637 | 4,344 | +707 (~+177 tokens) |
| planning critique fallback (milestone) | 3,781 | 4,525 | +744 (~+186 tokens) |
| clarification (round 3) | 7,836 | 8,061 | +225 (~+56 tokens) |
| summarise system prompt | 748 | 822 | +74 |

The three processor prompts grow only when the issue has a milestone. They now
carry the shared, fenced assignment section instead of a one-line copy that
left the title unfenced. The issue expected the change in bytes to be small;
its value is in behaviour.

## Acceptance Criteria

- **met**: None of the listed strings contains `CRITICAL`, `IMPORTANT:`, an
  ALL-CAPS `MUST`, `NEVER`, `DO NOT` or `Do NOT`; each remaining prohibition
  states its reason; a test scans for the tokens; and the `prompt_delimiter.ts`
  boundary is excluded with a comment saying why.
  - Evidence: `builder prompts - no shouted emphasis in any builder-injected
    string (Issue #2576)` renders all ten surfaces. `builder prompts - the scan
    catches a shouted string` proves the scan fires and that the boundary is
    excluded. `builder prompts - the rewritten rules still give their reasons`
    checks the reasons.
- **met**: The milestone-assignment instruction comes from one function, all
  four call sites use it, and the existing milestone tests pass.
  - Evidence: `milestone assignment - every site renders the one shared
    section` covers the planning, critique, single-pass, retry and critique
    fallback prompts. `milestone assignment - the processor prompts fence the
    title` also passes, as do `prompt_builder_milestone_fence_test.ts`,
    `prompt_builder_milestone_fence_16_test.ts` and `milestone_fence_test.ts`.
- **met**: `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` has the new model rows,
  each citing its Anthropic source, and `docs/REFERENCES.md` credits those
  sources.
  - Evidence: `model rows score the Opus 5 and 5.5 techniques, each citing its
    source (Issue #2576)` and `verdict table template carries the model rows`.
    `references_doc_test.ts` passes: each source is credited once and every
    path exists.
- **partial**: No quality regression.
  - The three clarity test files pass, with expectations changed only for the
    reworded text. `clarity_assessment_test.ts` changed two strings: "MUST
    respond with CLEAR" became "Respond with CLEAR", and "CRITICAL RULES"
    became "Decision rules". `assess_clarity_test.ts` and
    `clarity_phase_test.ts` needed no change.
  - Not measurable before merge: the ±5-point clarification-rate comparison
    over the next 20 runs, and a cited screenshot-retry run that commits a
    screenshot. Both need live fleet runs and belong in a comment on #2576.

## Standards Review

- Australian English throughout.
- The shouted-token test was written first and failed on eight clarity and
  summarise hits after the builder rewrite, until those were reworded.
- The M-row checklist tests were added alongside the rubric edit.
- Other tests changed only for reworded text:
  - `planning_processor_test.ts` now looks for "Create them now" instead of
    "MUST";
  - `planning_critique_v5_test.ts` now looks for the new assignment sentence;
  - `claude_runner_test.ts` now looks for the new output line.
- The M3 score is ❌ for `prompt_builder.ts` and `planning_processor.ts`: no
  builder names the unattended early-stop shapes yet. That is tracked in #2572
  and is out of scope here.

## Test Plan

- `deno test --allow-all` on the 203 test files that reference the changed
  modules, `PROMPTS_DIR` or the changed docs: 2,909 passed, 0 failed.
- `deno fmt --check`, `deno lint` and `deno check` on every changed `.ts` file.
- `npx markdownlint-cli2` on every changed `.md` file.
