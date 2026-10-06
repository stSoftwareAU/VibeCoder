## Summary

Adds a self-review rule, **A new state on an existing screen re-reads that
screen's existing text**, to `CODING-STANDARDS.md` (Test coverage
expectations), to its injected twin `prompts/coding_guidelines/prompt.md`
(Test Coverage Expectations, the only surface a pr_feedback, ci_fix,
merge_conflict or custom_pr run in a fleet repo sees), and to
`prompts/issue/prompt.md` (a step-1 bullet beside the UI browser-check
guidance, and a clause in the PR Summary File Test Plan step).
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
`worker/deno/tests/existing_screen_text_3259_test.ts` pins the rule in all three
documents and the issue prompt's Test Plan clause.

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
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`docs/workflows/issue-processing.md`;
`CODING-STANDARDS.md:1206` — still true because the docs-change bullet on
altering an existing state's meaning is unchanged and the new rule points at
it.

## Test Plan

- Added `worker/deno/tests/existing_screen_text_3259_test.ts` (4 tests).
- The reviewer confirmed all 4 existing-screen-text tests passed on
  `7456e69e` in review 5426023899. This follow-up changes only this summary
  and synchronises the PR body; the test and its three documents are unchanged.
- Red-without evidence relies on the per-phrase `drift-pins-on-base` record
  below for all four sections, independently confirmed by that review.
  The earlier three-test restoration experiment did not cover the injected
  twin and is not claimed as evidence for the four-test suite.
- `deno task drift-pins-on-base origin/main …` per section, recorded for
  `7456e69e`: `CODING-STANDARDS.md` "Test coverage expectations" — absent on base:
  "list every message the screen already renders", "say whether it is still
  true in the new state", "reword it, hide it or mark it", "Add a test that
  renders the new state", "A pre-existing message left unchanged that is
  false or misleading in the new state is a blocking self-review finding",
  "List the messages checked in the PR summary's Test Plan" (the review of
  PR #3283 found the earlier bare pin "is a blocking self-review finding"
  ALREADY ON BASE; it is replaced by the full sentence). `prompts/issue/prompt.md`
  "Instructions" — absent on base: "A new state on an existing screen
  re-reads that screen's existing text.", "list every message the screen
  already renders", "add a test that renders the new state", "A pre-existing
  message left unchanged that is false or misleading in the new state is a
  blocking self-review finding". `prompts/issue/prompt.md` "PR Summary File"
  — absent on base: "re-reads that screen's existing text", "each marked
  still true or changed for the new state". `prompts/coding_guidelines/prompt.md`
  "Test Coverage Expectations" (added after the review of PR #3283 found the
  twin missing the rule) — absent on base: the same six phrases as the
  CODING-STANDARDS section, each `absent on base`.
- Earlier validation recorded 102 passed, 0 failed across the 27 existing
  test files reading the issue prompt's "Instructions" or "PR Summary File"
  sections; this summary-only follow-up does not claim a fresh run.
- No existing test assertion was removed.
- Fresh section-scoped comparison against base `d951d7df` confirmed all
  18 pinned-phrase checks across the four sections are absent on base and
  present on `7456e69e`. This used a standalone JavaScript comparison,
  not a fresh run of the Deno `drift-pins-on-base` task.
- Fresh `deno test --allow-read tests/existing_screen_text_3259_test.ts
  tests/caller_reach_3253_test.ts` (from `worker/deno`) could not run:
  the JSR package manifest for `@std/assert` failed to load from `jsr.io`.
- `./quality.sh < /dev/null` — attempted after installing the repository's
  checksum-verified Deno 2.9.6; completeness checks failed in this environment.
  No fresh Deno test or full quality-gate pass is claimed.
- `git diff --check` — passed for this summary correction.

Branch outcomes: none added
