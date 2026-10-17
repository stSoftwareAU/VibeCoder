## Summary

Both prose claim checks now include changed source comments and unchanged
module or declaration comments affected by a source change. Strings and
executable code are excluded from confirmed prose. The question asks for a
whole-head search when a claimed set has no single authoritative list.
Closes #3715. Shared scope work is described in [#3731](pr-summary-3731.md).

## Spec

### Intent and Rationale

- A new field or caller can invalidate an untouched comment; the same source
  scope must reach the first-run and review-fix checks.

### Essential Design Decisions

- Reuse the existing source lexer to separate comments from strings and code.
  A zero-context diff selects changed comments and declarations; module
  headers and attached declaration comments are included for changed code.
- Findings are confirmed against selected comment text, then use the existing
  doc-finding recovery path. Source files under docs also trigger this check.
- The existing 20-file cap remains. Missing diff data, unreadable tracked
  source and unterminated source literals are explicitly not checked.

### Undiscoverable Facts

- The independent review found a multiline parameter-object boundary error
  and a review-fix recovery path that accepted out-of-scope source findings.
  Both were corrected and covered before publication.

## Evidence

Reproduction status: reproduced. Tests cover TypeScript, shell, Rust and SQL
comments, unchanged headers, multiline parameters, excluded strings/code,
unreadable source and both production callers. No UI change.

**Docs sweep** — grep: `docProseClaimInstruction`, `doc_prose_claims`, `source comments`; section: CODING-STANDARDS.md Prose about the PR's own change; updated: CODING-STANDARDS.md, docs/workflows/issue-processing.md, docs/workflows/pr-feedback.md, docs/INTERNALS.md; siblings: `runSummaryClaimCheck`, `runPrFeedbackDriftCheck` — both prose-check callers use the shared scope.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Changed comments and unchanged affected headers are selected.
- **met** — The question requires whole-head search for distributed sets.
- **met** — Both first-run and review-fix callers use the same collector.
- **met** — Test files, executable lines and strings are excluded from source
  prose; skipped scope is reported as not checked.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Independent review checked caller parity, comment-only
  confirmation, changed declaration boundaries, caps and prompt fencing.
  Review findings were fixed and regression-tested.

## Test Plan

- `worker/deno/tests/doc_prose_claims_test.ts` exercises lexical selection,
  attached headers, malformed input and tracked unreadable source.
- `worker/deno/tests/summary_claim_check_test.ts` confirms selected source and
  manual findings reach the first-run gate.
- `worker/deno/tests/pr_feedback_drift_check_3347_test.ts` uses real temporary
  Git repositories to exercise review-fix selection and recovery, including a
  generator under docs whose executable string is never recovered as prose.
- The first-run and review-fix regression tests failed against the previous
  implementation. Shared final validation: 344 scoped tests and 687 manifest
  tests passed. The full hosted quality gate also passed; see
  [#3710](pr-summary-3710.md) for the tested commit, run and sole configuration
  integration skip.
- In the invalid-path fixture, `lib/x.ts` becomes `lib/x.bin`: TypeScript is
  now valid input. The same `assertThrows` and error-message check remain for
  unsupported and unsafe paths; the new caller tests exercise accepted source.
- Removed from `worker/deno/tests/summary_claim_check_test.ts`: ``assertStringIncludes(err instanceof Error ? err.message : String(err), `requires manual or prompt Markdown paths, got '${bad}'`,);``
  Required by: "widen the selection beyond `.md`."
  Replaced by: ``assertStringIncludes(err instanceof Error ? err.message : String(err), `requires manual, prompt or source paths, got '${bad}'`,);``

- Removed from `worker/deno/tests/summary_claim_check_test.ts`: `const err = assertThrows(() => buildSummaryClaimQuestionPrompt({ ...PROMPT_BASE, docFiles: [bad] }));`
  Required by: "widen the selection beyond `.md`."

The assertion line is retained. The scanner reports its changed loop context:
TypeScript leaves the invalid-path table and the unsupported binary path
replaces it; new accepted-source tests cover TypeScript.

**Branch outcomes:**

- Comments included / strings, executable code and tests excluded — `worker/deno/tests/doc_prose_claims_test.ts`.
- Unchanged attached header included / unreadable tracked source not checked — `worker/deno/tests/doc_prose_claims_test.ts`.
- Selected source finding recovered / executable quotation ignored — `worker/deno/tests/pr_feedback_drift_check_3347_test.ts`.
- Source and manual findings use existing first-run gate — `worker/deno/tests/summary_claim_check_test.ts`.
