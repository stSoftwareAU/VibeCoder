## Summary

Prose checks now select bounded unchanged manual sections named in the Docs
sweep or referencing a changed source path, basename or exported declaration.
This includes untouched manuals outside the archive. The question checks
whether this change makes the sentence false, preserving the existing claim
classes and recovery path. Closes #3731.

## Spec

### Intent and Rationale

- Adding a new behaviour must also check the existing contract in the affected
  manual section, even when that manual is not edited.

### Essential Design Decisions

- One collector serves completion and review-fix callers. Named sections
  include subsections up to the next peer heading; reference matches select
  the local heading block. Archive manuals are excluded from this extra scope.
- The section cap is 40 and the shared file cap is 20. Overflow is reported as
  not checked, never passed. Selected ranges are nonce-fenced prompt data.
- Existing changed-Markdown checking remains; extra unchanged prose is limited
  by heading ranges and confirmed against the selected text.

### Undiscoverable Facts

- The exact issue example, `docs/CONFIGURATION.md pre-flight gate section`,
  initially matched the filename's root heading. A regression now checks the
  intended pre-flight section and excludes its unrelated sibling.

## Evidence

Reproduction status: reproduced. The caller tests select and report an
unchanged counted claim while leaving an agreeing neighbouring sentence
unreported. Scope tests also select an untouched manual by source basename
and an exported function identifier, and record capped sections. No UI change.

**Docs sweep** — grep: `docProseClaimInstruction`, `affected manual`, `changed manuals`; section: docs/workflows/pr-feedback.md The worker's drift check; updated: docs/workflows/issue-processing.md, docs/workflows/pr-feedback.md, CODING-STANDARDS.md, docs/INTERNALS.md; siblings: `runSummaryClaimCheck`, `runPrFeedbackDriftCheck` — both callers use the same bounded manual scope.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Named and reference-matched sections include unchanged sentences
  and untouched manuals; archive sections are excluded from this extra scope.
- **met** — Question asks only whether this change invalidates the sentence.
- **met** — Both callers feed confirmed findings through existing recovery.
- **met** — Counted stale claim, agreeing sentence, untouched manual and
  section overflow scenarios are covered by regression tests.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Independent review checked exact named-section syntax, bounded
  confirmation, source-reference matching, caps, both callers and nonce fences.

## Test Plan

- `worker/deno/tests/doc_prose_claims_test.ts`: named section, basename and
  identifier references, archive exclusion, cap and exact issue syntax.
- `worker/deno/tests/summary_claim_check_test.ts` and
  `worker/deno/tests/pr_feedback_drift_check_3347_test.ts`: selected unchanged
  claims reach the model and existing gates; an agreeing sentence is not
  reported by the fake semantic reviewer.
- Both caller regressions failed against the previous implementation. Shared
  validation: 344 scoped tests and 687 manifest tests passed; full local gate
  networking limitations are recorded in [#3710](pr-summary-3710.md).
- The screenshot regression's Git spy now distinguishes per-file UI patch
  requests from the whole-branch prose diff. Its existing assertions still
  require exactly the UI patch read, permit a version-only bump and refuse a
  real UI edit without evidence. The initial CI failure reproduced locally;
  after the spy correction, all 330 completion and assertion-guidance tests
  passed, including `worker/deno/tests/completion_phase_version_bump_2300_test.ts`.
- Removed from `worker/deno/tests/completion_phase_summary_claim_check_test.ts`: `assertStringIncludes(prompt, "check only the lines this branch's diff adds or edits",);`
  Required by: "add a second, bounded scope of **unchanged** sentences"
  Replaced by: `assertStringIncludes(prompt, "check the lines this branch's diff adds or edits",);`
- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assertStringIncludes(withDocs, "check only the lines this branch's diff adds or edits",);`
  Required by: "add a second, bounded scope of **unchanged** sentences"
  Replaced by: `assertStringIncludes(withDocs, "check the lines this branch's diff adds or edits",);`
- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `assertFalse(without.includes("check only the lines this branch's diff adds or edits"),);`
  Required by: "add a second, bounded scope of **unchanged** sentences"
  Replaced by: `assertFalse(without.includes("check the lines this branch's diff adds or edits"),);`

The old added-lines-only prompt expectation is incompatible with the requested
extra scope. The updated presence/absence checks retain the same caller
conditions and go red against the original instruction.

**Branch outcomes:**

- Named section and source-reference section selected / unrelated sibling and archive excluded — `worker/deno/tests/doc_prose_claims_test.ts`.
- Section cap allows selected scope / records omitted sections — `worker/deno/tests/doc_prose_claims_test.ts`.
- Changed-source findings and selected unchanged manual findings reach completion — `worker/deno/tests/summary_claim_check_test.ts`.
- Same selected scope reaches review-fix recovery — `worker/deno/tests/pr_feedback_drift_check_3347_test.ts`.
