## Summary

Adds the rule **Automation that creates fleet work must not re-fire on its own
output** to `CODING-STANDARDS.md` → **Automation and Shared GitHub State**. It
is mirrored in `prompts/coding_guidelines/prompt.md` directly after **Remove
only what you can prove you added**. When code files an issue, raises a PR,
pushes a ref or applies a label that the fleet will act on, the PR summary must
say what stops the trigger from firing again on the state that work leaves
behind. A **Test the second pass** bullet asks for a test that runs the trigger
again against that state and asserts it does nothing. The standards copy lists
VibeCoder#2898 and VibeCoder#3676 under "Past regressions". Closes #3692.

## Spec

### Intent and Rationale

- Two unrelated PRs (milestone partial rollups, completion-phase `Finish #N` follow-ups) each added a trigger that its own merged or closed output could satisfy again. Their only guard deduped against *open* items, and that output is never open by the next pass.
- The issue asks for guidance, not a code gate. A deterministic generation marker is the issue's fallback if a third PR shows the pattern.

### Essential Design Decisions

- The prompt copy says "code you write", as the neighbouring provenance rule does. That keeps it from conflicting with the escape hatch's agent-filed follow-up dedup ("search before you file"), which governs what the agent files, not automation.
- The second-pass bullet says "files, raises, pushes or applies nothing" rather than the issue's "files, raises or pushes nothing". This way it covers every output the rule's first sentence names, the label included.
- The prompt copy is unmarked, so it sits in the core layer like the provenance rule it follows, before `<!-- guidelines-layer: code -->`.

### Undiscoverable Facts

- `#2898` is the merged milestone PR that added `createPartialRollup`. `#3676` is still open, and its review (2026-10-13) found the `Finish #F1: Finish #N` cascade.

## Evidence

This is a documentation and prompt change with a drift test. No UI files are touched.

**Docs sweep** — grep: "Automation and Shared GitHub State", "Remove only what you can prove", "re-fire", "own output"; section: `CODING-STANDARDS.md#automation-and-shared-github-state`; siblings: "Remove only what you can prove you added" — no doc lists this section's rules, so only the two twin surfaces carry it; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`; `prompts/coding_guidelines/prompt.md:912` — still true because "holds the full rule" refers to the provenance rule, which is unchanged.

Issue numbers cited as provenance (each checked with `gh issue view`):

- #2898: Milestone: #2794 worker deno lib milestone: Milestone deadlock partial
- #3676: A healthy run that closes out a criterion as partial or missing still closes the issue with no follow-up (three private fleet PRs) (Issue #3506)
- #3692: Fleet automations that create work re-fire on their own output: a follow-up files a follow-up, a merged rollup triggers the next rollup (VibeCoder#2898, #3676)

Related existing rules checked for conflicts:

- **Remove only what you can prove you added** (the twin pair it sits beside) — consistent. A fleet-authored marker is the same provenance idea.
- **A new path to an existing outcome keeps that outcome's guards** — no overlap.
- **State recorded on a failure path is cleared on the path that recovers** — no overlap.
- The escape hatch's **Search before you file — at most one follow-up per root cause** — governs follow-ups the agent files, while the new rule is scoped to code. No contradiction.

Rule applied to this PR's own diff: the diff adds no code that files, raises, pushes or labels anything. Nothing found.

## Test Plan

- Added `worker/deno/tests/self_refire_guard_3692_test.ts`, a documentation-drift test with three tests:
  - `both surfaces carry the re-fire rule (Issue #3692)` — ten key phrases in each surface's rule paragraph and bullet.
  - `the standards name both past regressions (Issue #3692)`
  - `the guidelines copy sits in the core layer beside the provenance rule (Issue #3692)`
- Pins checked against the base: `deno task drift-pins-on-base origin/milestone/fleet-guidance-guards-side-effects-and-concurrency …` reported **absent on base** for each pin in `CODING-STANDARDS.md` § Automation and Shared GitHub State (12 phrases). It did the same in `prompts/coding_guidelines/prompt.md` § Human Escalation (11 phrases, including the bold rule opening).
- Red check: with the base versions of both docs restored, the test reported `FAILED | 0 passed | 3 failed`. With the head docs, all 3 pass.
- Existing `worker/deno/tests/coding_guidelines_twin_drift_test.ts`, `worker/deno/tests/coding_guidelines_layers_2574_test.ts` and `worker/deno/tests/existing_rule_conflicts_3077_test.ts` pass (24 passed).
- `./quality.sh < /dev/null` passed on the head. Config integration was skipped because no `.config.json` is available.
- No existing test edited, and no assertion removed.

<!-- vibe-branch-outcomes -->
