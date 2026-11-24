# PR Summary — Issue #5411

## Summary

Shortened the **A new case re-reads the text it now reaches** rule (#3259,
reworded by #4198) on every surface that states it. The rule now says to follow
the new case to each place that shows, posts or prints something for it and to
read what that place says. It no longer asks for an inventory of every message a
screen renders or for a Test Plan list of the messages checked. Closes #5411.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the paragraph
  is replaced by the issue's proposed wording, the same in both twins.
- `prompts/issue/prompt.md`: the Instructions bullet is shortened to the same
  content, and the restatement in the PR Summary File Test Plan item is deleted.
- `worker/deno/tests/existing_screen_text_3259_test.ts`: re-pinned to the
  remaining phrases. The Test Plan test is removed, and a new test checks that
  the retired phrases are absent from the live copies.

## Spec

### Intent and Rationale

- The #4198 trigger covers code paths, posted comments and CLI output, but the
  body still told the author to inventory "the screen". None of the nine public
  hits listed in the issue involved a screen. Following the new case to where it
  is shown gets to the false text whichever component holds it.
- The Test Plan list was a self-written record that checked nothing (#3877 said
  so itself), so it is removed and nothing replaces it.

### Essential Design Decisions

- The test sentence uses the issue's proposed wording ("puts the new case
  through and asserts each text that differs for it"), not the old "renders the
  new state". Assumption: the issue gives this wording as its primary proposal,
  and the test duty is otherwise unchanged (a test asserting each text that
  differs, or is absent).
- Dropped as the issue lists: the bracketed screen states, the screen inventory,
  the "rendered-screen counterpart" sentence, and both Test Plan lines. Kept:
  the #4198 trigger and its examples, reword/hide/mark, the test, and the
  blocking self-review finding.
- Citation changed from `(Issue #3259)` to `(Issues #3259, #3877)`, as in the
  proposed text.

### Undiscoverable Facts

- The recurrence figures (27 independent PRs since #3877 closed) come from the
  review-fleet-prs ledger quoted in the issue, which is not in this repo.

## Evidence

Prompt and standards text only. No runtime code changed.

- Issue numbers the diff cites, looked up with `gh issue view` in this run:
  - #3259: Fleet UI PRs add a new state to an existing screen and leave its
    existing notes and badges stating the old state
  - #3877: Fleet PRs send a new case to existing user-visible text that is false
    for it: #3259's trigger covers only new screen states
  - #5411: this issue
- Restatements found and changed (every place the rule is stated): the
  `CODING-STANDARDS.md` paragraph, the `prompts/coding_guidelines/prompt.md`
  twin, the `prompts/issue/prompt.md` Instructions bullet, and the
  `prompts/issue/prompt.md` PR Summary File restatement, which is deleted.
- Swept the live copies, `docs/workflows/` and `worker/deno/` on the final head
  with `git grep` (`docs/archive/` and `evals/` excluded). Searched for: "screen
  already renders", "messages checked", "rendered-screen", "re-reads the text",
  "empty-state text" and "new state on a screen". The only hits left are the new
  rule text and the test that pins it.
- Related rules checked: the docs-change bullet on a change that alters what an
  existing state means (**A Code Change Owes a Docs Change**), which the removed
  "counterpart" sentence pointed at. That bullet does not point back, so nothing
  there changes. The documentation-drift test rules were applied to the edited
  test: phrases are scoped to the rule paragraph or section, and absence is
  checked over the whole file.
- I applied the rule to this PR's own diff and found nothing to fix. The diff
  sends no new case to existing text: it rewrites the rule's own text and the
  drift test that pins it.

## Test Plan

- `worker/deno/tests/existing_screen_text_3259_test.ts`:
  - **Three rule tests** (CODING-STANDARDS, coding_guidelines twin, issue prompt
    Instructions): they now share `RULE_PHRASES`. The removed phrases are those
    this issue retires ("list every message the screen already renders", "say
    whether it is still true in the new state", "List the messages checked in
    the PR summary's Test Plan") plus the old reword and test sentences, which
    the new wording replaces. The new phrases pin the reworded duty, the test
    and the blocking finding. `TRIGGER` and `TRIGGER_EXAMPLES` are kept.
  - **Removed:**
    `issue prompt Test Plan step lists the messages checked
    (Issue #3259)`,
    because the issue retires that restatement. The new absence test covers its
    old-heading-phrase check: the Issue #4198 test still checks `OLD_HEADING`
    over every live copy.
  - **Added:**
    `the retired screen inventory and Test Plan list are absent from
    the live copies (Issue #5411)`.
    It checks every live copy, as a whole file, for the absence of "the screen
    already renders", "messages checked in the PR summary's Test Plan",
    "rendered-screen counterpart" and "each marked still true or changed for the
    new state".
- Red against base: I restored the three base-branch Markdown files and kept the
  new test. Result: 4 failed, 1 passed (the unchanged #4198 test).
- Head: `deno test -A tests/existing_screen_text_3259_test.ts` passed 5 of 5.
- `./quality.sh < /dev/null` passed on the head, with the config integration and
  checkov checks skipped.

Not done or not checked: no independent Spec or Standards reviewers were
dispatched, because the issue has no acceptance-criteria heading. Whether the
shorter wording reduces the pattern is not claimed. The issue says the same.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
