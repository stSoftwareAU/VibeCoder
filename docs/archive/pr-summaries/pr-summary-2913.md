# PR Summary — Issue #2913

## Summary

Closes #2913

Issue-phase PR summaries now carry an AfterVibe-style `## Spec` section directly
after `## Summary`, with three sub-headings: `### Intent and Rationale`,
`### Essential Design Decisions` and `### Undiscoverable Facts`. Each holds at
most four bullets, and `None.` is allowed. The section is added to the
"PR Summary File" list in `prompts/issue/prompt.md` and to the prompt's worked
example. `CODING-STANDARDS.md` and `docs/PROMPTS.md` are updated to match.

## Spec

### Intent and Rationale

- A reviewer can see *what* changed in the diff but not *why*. The Spec section
  records intent, the decisions that must hold, and facts the repo cannot
  reveal.
- The rule is enforced by the prompt alone: one template edit reaches every
  repo, and no new worker code can fail a run.

### Essential Design Decisions

- `## Spec` sits between `## Summary` and `## Evidence`. The acceptance-criteria
  and independent-review gates locate sections by their `##` heading, so they
  are unaffected.
- The cap of four bullets per sub-heading, with `None.` allowed, keeps the
  section short and stops it being padded with filler.
- The test is a section-scoped documentation-drift test, because the contract
  lives only in prompt prose; there is no code value to import.

### Undiscoverable Facts

- The issue comments settled the scope: the change is prompt-only, applies
  fleet-wide and has no config flag. The `pr_feedback` and `ci_fix` prompts and
  `closure_verdict_recovery.ts` are deliberately left unchanged.
- Whether to keep the section will be decided after the first 10 issue-phase
  PRs: it stays if a human reviewer rates at least 7 of the 10 Spec sections as
  useful.

## Evidence

- `worker/deno/tests/issue_prompt_spec_section_docs_test.ts` reads
  `prompts/issue/prompt.md` with `readRepoDoc` and narrows it to the
  "PR Summary File" section with `section()`. Its three tests:
  1. The required-content list has `**Spec**` before `**Evidence**`, the three
     sub-headings in order, "at most four bullets each" and `None.`.
  2. In the worked example, `## Spec` comes after `## Summary` and before
     `## Evidence`, with the three `###` sub-headings in order.
  3. A `withoutSection` negative control shows the four-bullet cap appears
     nowhere else in the prompt.
- `deno task test:unit tests/issue_prompt_spec_section_docs_test.ts`: 3 passed.
  The existing prompt suites `issue_prompt_v39_independent_review_test.ts` and
  `completion_phase_summary_rule_retry_test.ts` still pass (13 passed).
- `./quality.sh` passed.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- [x] `prompts/issue/prompt.md` gains `## Spec` directly after `## Summary`, in
  both the required-content list and the worked example, with the three
  sub-headings. reviewer: met
- [x] Each sub-heading has at most four bullets, and `None.` is allowed.
  reviewer: met
- [x] Every issue-phase PR's body and `pr-summary-N.md` carry `## Spec` with the
  three sub-headings. The single issue prompt drives both. reviewer: met
- [x] Enforcement is prompt-only: no worker check, gate or warning, and the
  `pr_feedback`, `ci_fix` and `closure_verdict_recovery.ts` paths are
  untouched. reviewer: met
- [x] Blind regeneration and verification conditions are not built.
  reviewer: met
- [ ] Post-merge evaluation of the first 10 issue-phase PRs (keep the section
  if at least 7 of 10 are useful). reviewer: missing — reason: this is a human
  review step after merge and cannot be done in this diff.
- [x] The `CODING-STANDARDS.md` and `docs/PROMPTS.md` updates were not named in
  the issue. reviewer: unrequested — reason: they keep the documented PR
  summary contract consistent with the prompt, as "A Code Change Owes a Docs
  Change" requires.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- Documentation-drift tests: reviewer: met. The first review was partial
  because the test ran whole-file `includes` over the prompt. It was rewritten
  to use `readRepoDoc` and `section()`, renamed to `*_docs_test.ts`, and given
  a negative control. A re-review confirmed all three conditions are met.
- A Code Change Owes a Docs Change: reviewer: met. The prompt,
  `CODING-STANDARDS.md` and `docs/PROMPTS.md` all agree.
- Prompt templates (one editable template, no versioned copies): reviewer: met.
- KISS / DRY and file size: reviewer: met.
- Australian English: reviewer: met.

## Test Plan

- [x] Run `deno task test:unit tests/issue_prompt_spec_section_docs_test.ts`
  from `worker/deno`.
- [x] Re-run the existing issue-prompt suites
  (`issue_prompt_v39_independent_review_test.ts` and
  `completion_phase_summary_rule_retry_test.ts`).
- [x] Run `./quality.sh` from the repo root.
- [ ] After merge, check that the next issue-phase PR's summary includes
  `## Spec` with the three sub-headings.
