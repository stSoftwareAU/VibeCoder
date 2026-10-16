## Summary

Closes #3861.

The docs-sweep gate accepted entries whose grep terms the advisory scanner
silently dropped. Read quoted terms after colonless `grep` and `grep terms`,
and stop a field at the next field label as well as a semicolon. Quoted field
labels remain literal terms. An `Updated:` path no longer becomes a search term.

The gate now refuses a grep field with no usable quoted term unless it gives
an explained `grep: none — <why>` negative. Quotes in that explanation do
not become search terms. Stale hits remain advisory; this does not introduce
a model call or broaden the file search.

## Spec

### Intent and Rationale

- Reuse the existing scan so it actually searches the terms the agent chose.
- Refuse unusable sweep evidence before the PR reaches review.

### Essential Design Decisions

- The gate and scanner share the same term and negative parsers.
- Field boundaries are recognised outside quoted spans. The parser remains
  linear over the field; existing term count and length caps are retained.
- A negative reason must begin with a letter or number, optionally after an
  opening quote. A missing or punctuation-only reason is not an explanation.

### Undiscoverable Facts

- The issue was unassigned and had no open implementation PR when claimed.

## Evidence

- Docs-sweep and completion-phase suites: 464 passed, 0 failed.
- New regression tests against the unfixed parser and gate: 116 passed,
  9 failed. They reproduce dropped colonless terms, field contamination,
  unusable grep evidence being accepted and the missed source doc comment.
- Eight targeted breaks went red: omit the next-field boundary; treat
  quoted names in a negative explanation as terms; remove the grep gate;
  reject an explained negative by dropping its exception; ignore a semicolon;
  stop skipping quoted spans; discard earlier terms at an unmatched quote;
  invent a term when the field is absent.
- Completeness checks: 687 passed, 0 failed, 1 ignored.
- Full local quality check: blocked locally, not a pass. The unit stage
  stalled with `DENO_JOBS=4`; the unchanged clean-kill test in
  `claude_runner_kill_bound_test.ts` also exceeded a 15-second timeout alone.
  This host reports a process namespace mismatch (`ps` cannot look up itself).
  Type checking, lint, formatting, Mermaid and completeness checks passed.
  Optional markdownlint, Semgrep, configuration integration and release-tag
  checks were skipped. Keep this PR draft until the full gate passes in CI
  or a supported host.

**Docs sweep** — grep: `Docs sweep`, `grep:`, `siblings:`; section: `docs/workflows/issue-processing.md#-docs-sweep-on-a-code-change`, `CODING-STANDARDS.md#pr-summary-and-evidence`; siblings: `section:`, `updated:`; updated: `docs/workflows/issue-processing.md`, `CODING-STANDARDS.md`. Existing prompt examples already quote their grep terms and remain valid.

## Test Plan

- `docs_sweep_hits_test.ts`: colonless forms, next-field boundaries, quoted
  labels, explained negatives, a missed `///` comment in a touched Rust file,
  and hostile whitespace/near-label growth checks.
- `docs_sweep_gate_test.ts`: usable terms and explained negatives pass;
  missing, unquoted, bare-negative and punctuation-only fields fail with a
  grep-specific finding.
- `docs_sweep_wrap_3356_test.ts`: the hard-wrap fixture now quotes its existing
  three terms as the new contract requires. Its section assertion and all
  other assertions are unchanged. The test still exercises a `section:` key
  separated from its value by a newline.
- Shared-helper callers checked: `extractSiblingTerms`, `validateDocsSweep`,
  `checkDocsSweepTerms` and the completion-phase gate callers. Existing sibling
  terms and negative controls pass; no model or Git interface changed.
- Existing cap, duplicate, curly-quote, unmatched-quote, semicolon-in-term,
  sibling-negative, real-git and completion tests remain in the suites.
- No assertion was removed or weakened. No UI or performance result is claimed.

<!-- vibe-branch-outcomes -->
