## Summary

The issue-run and PR-feedback prompts no longer say that an issue with no
criteria heading must be closed whatever the run left undone. They now tell the
run to record each part it leaves undone as a `missing` entry that quotes the
issue, and to write `Part of #N`, so the issue stays open and queued. Prompt and
docs wording only; no code change. Closes #4477.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- `acceptance_criteria_gate.ts` reads criteria only under a few headings, so an
  issue listing its requirements under "Wanted" states none. The prompt then
  allowed only `Closes #N` for it, forbade a block, and forbade a follow-up
  issue, so a partly done run closed the only record of the undone part.
- The worker already holds the issue open from the summary's own block
  (`findMissingCriteria` in `missing_criterion_close_guard.ts`, used by
  `assemblePrBody` in `pr_body_sync.ts`), whatever heading the issue used. Only
  the guidance stood in the way, so only the guidance changes (the issue's own
  proposal).

### Essential Design Decisions

- The criteria heading match is not widened (the issue considered and rejected
  that: more issues under the closure gate, Spec review and verifier).
- The criteria-less block carries `missing` entries only: no
  `<!-- vibe-spec-review -->` marker and no `reviewer:` field, because no
  reviewer runs for such an issue. A test proves both gates accept that shape.
- `docs/workflows/issue-processing.md` said a criteria-less issue "nothing
  changes"; reworded, because a `missing` entry now legitimately appears.

### Undiscoverable Facts

- The two motivating PRs are in private fleet repositories and are not
  reproduced here; the issue's evidence table is the record.

## Evidence

Prompt and docs only; no UI files touched.

- `prompts/issue/prompt.md`: "Issue Closure in PR Summary" (the `Closes` branch
  no longer says "or the issue states no criteria"; the `Part of` branch covers
  a criteria-less issue), the "no acceptance criteria" bullets in the
  independent-review and closure sections, "The file MUST contain" item 5 and
  the skeleton lead-in (both now say the criteria-less block holds only
  `missing` entries with a `reason:`, no provenance marker and no `reviewer:`
  field).
- `prompts/pr_feedback/prompt.md`: "Stopping the PR from closing its issue".
- `DESIGN-PRINCIPLES.md` ("Unmet acceptance criteria are named…") and
  `docs/workflows/issue-processing.md` (closure gate and "At PR creation").

Related existing rules checked: the "never file a follow-up issue" rules in
`prompts/issue/prompt.md`, `prompts/coding_guidelines/prompt.md` and
`prompts/pr_feedback/prompt.md` (unchanged, still true: the undone part stays on
the same open issue); the #3761 Standards Review rule for criteria-less issues
(kept intact); `prompt_builder.ts:321`, which already says `Part of` when the
block marks a criterion `missing`. Applying the change to this PR's own diff:
this issue has no criteria heading and nothing in it is left undone, so
`Closes #4477` is the right line under the new rule.

## Test Plan

- New `worker/deno/tests/issue_prompt_criteria_less_closure_4477_test.ts` (7
  tests at head), all named `(Issue #4477)`:
  - Behavioural, on real code (3 tests): an issue under `## Wanted` yields no
    criteria; a summary with one `missing` entry and no `reviewer:` field passes
    `validateAcceptanceClosure` (not applicable) and `validateIndependentReview`
    and assembles to `Part of #123` plus `## Not closing #123` with no closing
    keyword; the same issue with no block still assembles to `Closes #123`.
    These pin the premise the prompt change relies on, so they are green on base
    by design.
  - Prompt pins (4 tests), each read through `flat(section(...))`, never a whole
    page: "Issue Closure in PR Summary" drops the old phrase and gains
    `states no criteria heading`, "record each undone part as a `missing` entry
    in the issue's own words" and "nothing it asks is left undone";
    "Acceptance-Criteria Closure" gains the criteria-less bullet and "no
    reviewer provenance marker and no `reviewer:` field"; "PR Summary File"
    (item 5 of the file's contents and the skeleton lead-in) gains "the block
    holds only `missing` entries, each with a `reason:`, and no provenance
    marker and no `reviewer:` field" and "writing the marker would claim a
    review that never happened"; the pr_feedback "Making Changes" section
    carries `When the issue states no criteria heading`.
- Pins on base: `deno task drift-pins-on-base main <doc> <section> <phrase>...`
  reports every pinned phrase above as absent on base for its section. The
  earlier bare `missing` and `Part of #{{ISSUE_NUMBER}}` pins, which the base
  section already held, were dropped.
- Red check, per pin, by editing the phrase in its own section only and running
  the file: closure `record each undone`, closure `nothing it asks is`, the
  bullet's "no reviewer provenance marker and no `reviewer:` field", item 5
  `For
  an issue with no criteria heading the block holds only`, skeleton
  `would claim
  a review that never happened`, and the pr_feedback
  `When the issue states no
  criteria heading` each turned the file from 7
  passed to 6 passed, 1 failed; restored, 7 passed, 0 failed.
- `deno test --allow-all` from `worker/deno` over `tests/issue_prompt_*.ts`,
  `tests/coding_guidelines_*.ts` and `tests/prompt_builder_test.ts` (69 tests at
  head, run only as a regression check; this PR does not change it). The new
  `worker/deno/tests/issue_prompt_criteria_less_closure_4477_test.ts` is among
  the `issue_prompt_*` files (7 tests at head). Combined run at head: 160
  passed, 0 failed.
- No existing assertion was removed or edited.
- Docs: `deno fmt --check` already fails on `DESIGN-PRINCIPLES.md` and
  `docs/workflows/issue-processing.md` on base; not reformatted.
- `./quality.sh` on the final head: Result: PASSED (with skipped checks);
  checkov was skipped by the gate. An earlier run of the gate failed once in
  `tests/pr_maintenance_command_test.ts` (Issue #4424 merge-queue test): that
  test passes alone and in the rerun, and is a host GitHub rate-limit cool-down
  effect on earlier tests in the same file, unrelated to this diff.
