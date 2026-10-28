## Summary

The closing-keyword guidance now agrees with the #3177 guard. A summary whose
`## Acceptance Criteria` block marks a criterion `missing` carries `Part of #N`,
so the committed archive and the worker-assembled PR body say the same thing.
Otherwise (no `missing` entry, including a `partial` one) it carries
`Closes #N`, as the worker's body does. Closes #4445.

Wording changes only, in two prompt templates, the milestone-targeting section
that `buildIssuePrompt` renders ahead of the issue template, and one standards
line:

- `prompts/issue/prompt.md`, "Issue Closure in PR Summary": the unconditional
  MUST and "Do NOT omit the issue closure reference" are replaced by one
  conditional rule (`Part of #N` when any criterion is `missing`, otherwise
  `Closes #N`, including when one is `partial` or none are stated).
- `prompts/issue/prompt.md`, summary-file item 1 and `CODING-STANDARDS.md` item
  1: same conditional. The section's opening and its `Part of` paragraph give
  the reasons that hold in every repo: when no criterion is `missing` the worker
  appends `Closes #N` to the PR body (`ensurePrReferencesIssue`,
  `worker/deno/lib/pr_body.ts`, called from `assemblePrBody`,
  `worker/deno/lib/pr_body_sync.ts`), so the summary writes it too; a `Part of`
  summary with no parsed `missing` entry would be closed on merge, and
  `deno task pr-summary-check` blocking it is Vibe Coder-only (PR #4468 review).
- `prompts/issue/prompt.md`, the "unmet criterion" bullet: the false "raises no
  PR until every criterion is met" is replaced with what `completion_phase.ts`
  does since #4234 (an unmet criterion is named on the PR, which is raised
  anyway; only a `missing` one makes it `Part of #N`, a `partial` one still
  closes). The "appended automatically" sentence now reads "when no criterion is
  `missing`".
- `worker/deno/lib/prompt_builder.ts` (`buildMilestoneBranchSection`): the
  milestone line told the agent to use **Closes #N** unconditionally in the PR
  body and the archived summary. It now says `Closes #N`, or `Part of #N` when
  the `## Acceptance Criteria` block marks any criterion `missing`, matching the
  Issue Closure rule it precedes in the same prompt (PR #4468 review).
- `prompts/pr_feedback/prompt.md`, "Stopping the PR from closing its issue": the
  agent writes `Part of #N` in the summary itself; the body's
  `## Not closing #N` section is unchanged. The paragraph also gives the reverse
  step: when a fix finishes every `missing` criterion, the agent marks each one
  `met` and replaces `Part of #N` with `Closes #N`, because the rebuilt body
  then appends `Closes #N` (`ensurePrReferencesIssue`, called from
  `assemblePrBody` once `findMissingCriteria` is empty) and the committed
  summary must say the same (PR #4468 review).

Version bump: not applicable; no `VERSION` change is part of this wording
change.

## Spec

### Intent and Rationale

- Four passages (three in the prompt templates and standards, plus the
  milestone-targeting line in `prompt_builder.ts`) told the agent to write
  `Closes #N` and to rely on the worker for the rest, so a partial PR's archive
  contradicted its body. Rewording the source removes the contradiction with no
  new worker step.
- A worker-side rewrite of the archived file was considered and rejected in the
  issue: it would add a worker commit after the agent's last and change the
  summary the digest marker and `pr-summary-ci` compare against.

### Essential Design Decisions

- `withholdIssueClose` stays as the body backstop; a summary that follows the
  new text makes it a no-op.
- The `Part of` case is tied to `missing` entries only, matching
  `withholdIssueClose` and the `pr_summary_check.ts` "Part of still closes"
  gate, which passes `Part of #N` only when a `missing` entry parses. The prompt
  says so.
- No new gate or check, as the issue asks for "no new rule, gate or check". The
  one test added pins the reverse `Part of` → `Closes` step the review asked
  for, so the pr_feedback paragraph cannot lose it silently.

### Undiscoverable Facts

- None.

## Evidence

Prompt and docs wording only; no code path changed. The behaviour the new text
relies on was read at:

- `worker/deno/lib/missing_criterion_close_guard.ts` (`withholdIssueClose`,
  `buildMissingCriteriaPrNote`): rewrites only the body.
- `worker/deno/lib/pr_summary_check.ts` (`partOfStillClosesProblem`): a
  `Part of` summary passes when `findMissingCriteria` is non-empty.
- `worker/deno/lib/phases/completion_phase.ts` (unmet-criteria block, "raised
  and armed anyway"): backs the corrected "raises no PR" sentence.

Related existing rules checked: `CODING-STANDARDS.md` "not raised over a
`Closes #<n>`" and the #3177/#4304 paragraph below it (both already say
`Part of #<n>`), `docs/workflows/issue-processing.md` (describes the body
rewrite; still true), `prompts/issue/prompt.md` "When no criterion is `missing`,
the PR body gets `Closes #N` appended automatically" (consistent; a `partial`
criterion also still gets `Closes #N`). The rule was applied to this PR's own
summary: it has no `missing` criterion, so it carries `Closes #4445`.

## Test Plan

- Added to `worker/deno/tests/pr_claims_verified_3058_test.ts`: "Issue #4445 -
  pr_feedback prompt restores Closes #N once no criterion is missing" (PR #4468
  review). It reads the "Making Changes" section of
  `prompts/pr_feedback/prompt.md` and pins four phrases:
  ``write `Part of #N`
  in the summary yourself``,
  ``When your fix finishes every criterion marked
  `missing` (none is left `missing`)``,
  `` replace `Part of #N` in the summary
  with `Closes #N` `` and
  `the committed summary must say the same`.
  - Red check: with `prompts/pr_feedback/prompt.md` restored to the previous
    head's text, the test fails on
    ``When your fix finishes every criterion
    marked `missing` (none is left `missing`)``
    (5 passed, 1 failed); with the change it passes (6 passed, 0 failed).
  - `deno task drift-pins-on-base origin/main prompts/pr_feedback/prompt.md
    "Making Changes"`
    with the four phrases reports each one `absent on base`.
- Edited `worker/deno/tests/prompt_builder_test.ts` ("prompt builder - issue
  prompt includes milestone targeting"): it keeps `Closes #10` and now also pins
  the conditional sentence
  `` use **Closes #10**, or `Part of #10` when the
  summary's `## Acceptance Criteria` block marks any criterion `missing` ``.
  - Red check: with `buildMilestoneBranchSection` restored to the previous
    unconditional line, `deno task test:unit tests/prompt_builder_test.ts` fails
    on that assertion; with the change, `tests/prompt_builder_test.ts` and
    `tests/builder_prompt_deshout_2576_test.ts` pass (76 passed, 0 failed).
- Edited `worker/deno/tests/pr_claims_verified_3058_test.ts` ("issue prompt
  demands demonstrated criteria and finished deliverables"), which pinned the
  sentence this change had to reword.
  - Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`:
    `"An unmet criterion is not a PR"`
    - Replaced by: `"Finish every unmet criterion"`
    - Required by: "An unmet criterion is named on the PR, and the PR is raised
      as `Part of #N`"
  - Removed from `worker/deno/tests/pr_claims_verified_3058_test.ts`:
    `"The worker raises no PR until every criterion is met"`
    - Replaced by: `"is named on the PR, which the worker raises anyway"`,
      ``"a `missing` one makes it `Part of #{{ISSUE_NUMBER}}`"`` and
      ``"a `partial` one does not hold the issue open"`` (PR #4468 review)
    - Required by: "change \"The worker raises no PR until every criterion is
      met (Issue #4146)\" to match"
  - Red check: with `prompts/issue/prompt.md` restored to `origin/main`'s text,
    "issue prompt demands demonstrated criteria and finished deliverables" fails
    on its first new pin, `Finish every unmet criterion` (5 passed, 1 failed);
    with the change it passes.
    `deno task drift-pins-on-base origin/main prompts/issue/prompt.md
    "Acceptance-Criteria Closure"`
    with all four new pins reports each one `absent on base`:
    `Finish every unmet criterion`,
    `is named on the PR,
    which the worker raises anyway`,
    `` a `missing` one makes it `Part of
    #{{ISSUE_NUMBER}}` `` and
    ``a `partial` one does not hold the issue open``.
- Ran `deno task test:unit tests/pr_claims_verified_3058_test.ts`
  (`worker/deno/tests/pr_claims_verified_3058_test.ts`, 6 tests at head): 6
  passed, 0 failed.
- On the final head, `deno fmt --check`, `deno lint` and
  `deno task
  check:manifests` passed from `worker/deno`, and markdownlint
  passed on the changed Markdown. The full `./quality.sh` suite was not run for
  this push (the review-fix host cannot reach jsr.io); CI's `validate` job runs
  it.
- `deno task pr-summary-check` against this summary: 0 gates blocked, 0 not
  checked.
