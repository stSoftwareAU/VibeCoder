## Summary

Adds a self-review rule, **A new state on an existing screen re-reads that
screen's existing text**, to `CODING-STANDARDS.md` (Test coverage
expectations) and to `prompts/issue/prompt.md` (a step-1 bullet beside the UI
browser-check guidance, and a clause in the PR Summary File Test Plan step).
When a change adds a state or mode to an existing screen, the run must list
every note, empty-state text, warning, badge and label the screen already
renders, say whether each is still true in the new state, fix the ones that
are not, test each one that differs, and list the messages checked in the
Test Plan. `docs/workflows/issue-processing.md` records the history
(GRQ-AutoTrader#2560, #2615). Closes #3259.

## Spec

### Intent and Rationale

- Fleet UI PRs built the new state's data path but left the screen's existing
  messages written for the old state; tests rendered only the new rows, so
  the suite stayed green. Listing the messages the component already renders
  is a small, finite check that would have caught both send-backs.
- Neither the changed-call-site rule nor the caller-reach rule (#3253) finds
  this: no caller is missed, and the diff never touches the stale message.

### Essential Design Decisions

- The rule sits next to the caller-reach rule in CODING-STANDARDS and as the
  last step-1 bullet in the issue prompt, directly above the UI/PWA
  browser-check guidance, as the issue proposed.
- It is cross-referenced as the rendered-screen counterpart of the existing
  **A Code Change Owes a Docs Change** bullet on a change that alters what an
  existing state means, so the two rules agree rather than overlap.

### Undiscoverable Facts

- The examples come from the fleet PR reviewer's send-backs on
  GRQ-AutoTrader#2560 (head `98fb5f4b`) and #2615 (heads `6e8a83de`,
  `5c0da579`), quoted in the issue body.

## Evidence

Prompt and standards change only — no UI, no runtime code. The drift test
`worker/deno/tests/existing_screen_text_3259_test.ts` pins the rule on both
surfaces and the Test Plan clause.

**Related existing rules checked:** `CODING-STANDARDS.md` **A Code Change
Owes a Docs Change** bullet "When a change alters what an existing state …
means … UI copy" (agrees; now cross-referenced); **Every changed call site
needs a test that goes red without it** (named as not covering this case);
**A new argument or behaviour reaches every caller that needs it** (#3253,
distinct: no caller missed); `prompts/issue/prompt.md` step 2 UI/PWA
browser-check guidance (unchanged, complementary). No rule contradicts the
new one.

**Docs sweep** — grep: `existing screen`, `empty-state text`, `renders or
explains`, "re-read\w*"; section: `docs/workflows/issue-processing.md` (the
issue prompt's self-review rule history); updated: `CODING-STANDARDS.md`,
`prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`;
`CODING-STANDARDS.md:1206` — still true because the docs-change bullet on
altering an existing state's meaning is unchanged and the new rule points at
it.

## Test Plan

- Added `worker/deno/tests/existing_screen_text_3259_test.ts` (3 tests).
- `deno test --allow-read worker/deno/tests/existing_screen_text_3259_test.ts
  worker/deno/tests/caller_reach_3253_test.ts` — passed on the final head.
- Red without the change: with `CODING-STANDARDS.md` and
  `prompts/issue/prompt.md` restored to the base, all three new tests failed
  ("could not locate the existing-screen-text rule", missing-phrase
  assertions); restored, all passed. Every pinned phrase is absent from the
  base versions of the sections read (Test coverage expectations,
  Instructions, PR Summary File).
- The 27 existing tests that read the issue prompt's "Instructions" or "PR
  Summary File" sections still pass (102 passed, 0 failed).
- No existing test assertion was removed.
- `./quality.sh` — GATE_RESULT

Branch outcomes: none added
