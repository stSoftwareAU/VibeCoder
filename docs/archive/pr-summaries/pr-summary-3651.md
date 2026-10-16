## Summary

Adds the rule **"A per-cycle step is quiet at steady state"** to
`CODING-STANDARDS.md` § Automation and Shared GitHub State. It sits beside
"Remove only what you can prove you added" and the re-fire rule. A copy also
goes into the core layer of `prompts/coding_guidelines/prompt.md`, so fleet
agents see it. Code that runs on every scan must do nothing observable on a
pass where nothing has changed: no GitHub write, no repeated action, no
repeated WARNING, and no uncached per-item read. The rule gives four habits:
compare before writing, record that an action ran (failure paths too), gate
expensive reads on a change signal, and test the second pass. It cites
VibeCoder#3065 and #3640 as past regressions. Closes #3651.

## Spec

### Intent and Rationale

- Per-cycle steps passed single-pass tests and then rewrote, re-posted or re-ran on every ~60 s cycle. The new rule makes "what does the second pass over unchanged state do?" a question each change has to answer, and a test has to pin that answer.
- It follows the #3692 precedent: the full rule lives in `CODING-STANDARDS.md`, a shorter copy goes in the core guidelines layer, and a drift test pins both.

### Essential Design Decisions

- Quiet is not silent. A fault that persists is still logged when first seen and again when it changes, so the rule agrees with **Never Fail Silently — Fail Loud**. A step may still act again once the spacing its design asks for has passed.
- The rule names its overlaps. It is the steady-state counterpart of **must not re-fire on its own output**. It also says a record of a bad condition is still cleared on recovery, as **State recorded on a failure path is cleared on the path that recovers** requires.
- The guidelines copy sits before `<!-- guidelines-layer: code -->`, in the core layer beside the re-fire rule, so planning phases see it too.

### Undiscoverable Facts

- The 60 s figure is `LOOP_SLEEP_SECONDS` in `loop.sh` (default `60`).

## Evidence

This is a documentation and prompt change only, with no runtime code. The new
drift test guards it.

**Docs sweep** — grep: "re-fire on its own output", "Test the second pass", "Remove only what you can prove", "Automation and Shared GitHub State", "every cycle"; section: `CODING-STANDARDS.md#automation-and-shared-github-state`; siblings: "Remove only what you can prove you added", "must not re-fire on its own output" — no doc lists the section's rules as a closed set; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`; `prompts/coding_guidelines/prompt.md:912` — still true because the pointer says the standards section holds the full provenance rule; `worker/deno/tests/self_refire_guard_3692_test.ts:25` — still true because its `SECOND_PASS` search starts at the re-fire rule, so it still finds that rule's own bullet first (the test passes).

Related existing rules checked: "Remove only what you can prove you added", "Automation that creates fleet work must not re-fire on its own output", "State recorded on a failure path is cleared on the path that recovers", "Never Fail Silently — Fail Loud", "Log Levels Are a Promise About What the Reader Must Do" and `docs/GH-API-OPTIMISATION.md`. The new rule agrees with each one and links or names the ones it overlaps. Applied to this PR's own diff: the diff adds no per-cycle step, so the rule flags nothing in it.

Issue numbers cited: #3651: Fleet PRs add per-cycle scan steps that are not quiet at steady state…; #3065: Milestone: #2965 worker deno lib: conflict next-step ownership; #3640: Milestone rollups claim sub-issues whose work is not on the branch (#3476).

## Test Plan

- Added `worker/deno/tests/quiet_steady_state_3651_test.ts`, with three tests:
  - both surfaces carry the rule's key phrases;
  - the standards name both past regressions;
  - the guidelines copy sits after the re-fire rule and before the code-layer marker.
- Red check: restoring both docs to the base branch turned all three tests red (`FAILED | 0 passed | 3 failed`). The test passes on the head.
- `deno task drift-pins-on-base origin/milestone/fleet-guidance-guards-side-effects-and-concurrency …` printed `absent on base` for every pinned phrase. That covers all 17 pins in the standards section and the 8 pins checked in the Human Escalation section of the guidelines.
- `deno task test:unit` on the new test, `self_refire_guard_3692_test.ts`, `coding_guidelines_layers_2574_test.ts`, `coding_guidelines_twin_drift_test.ts` and `coding_guidelines_overlay_test.ts`: 40 passed, 0 failed.
- markdownlint on both edited Markdown files: 0 issues.
- `./quality.sh < /dev/null` on the head: `Result: PASSED (with skipped checks)`; only `config integration` was skipped.

<!-- vibe-branch-outcomes -->
