# PR Summary — Issue #5248

## Summary

Shortened the `CODING-STANDARDS.md` section "Worker failure causes" from four
paragraphs to the single paragraph the issue proposes, built only from
sentences already in it, and linked it to the manual. Before deleting, each
removed sentence was checked against "Source-declared failure causes
(Issue #3738)" in `docs/workflows/issue-processing.md`, and the points the
manual lacked were moved there. The manual's stale "all verifier findings
still block and hold merge" now agrees with "Pre-PR verifier (Issue #3395)":
findings are advisory at completion. No code, classifier, scan or gate
changed. Closes #5248.

## Spec

### Intent and Rationale

- Most of the section was a design record of #3738's code that the manual
  already holds; an author adding a failure path can act on little of it
- "Every verifier finding remains blocking" stopped being true when #4234 made
  pre-PR verifier findings advisory at completion

### Essential Design Decisions

- The standard keeps only the actionable rules: declare at source, never derive
  from reason text, expose verdict vs infrastructure in the type and map every
  case, decide at the tool boundary, carry the category through
- Moved to the manual (missing there before): the source-scan coverage
  sentence, `classifyRunFailure`'s explicit raw/declared input (its
  `declaredCategory` parameter, `worker/deno/lib/run_outcome_classifier.ts`),
  kill probes vs agent narration, `scheduled_release`/timeout keeping the
  runner's stop fields including raw exit status, no wholesale timeout
  exemption or discarding of preserved work, and already-landed provenance
  checks
- Sentences the manual already covered (finding categories, every
  simultaneous cause, PR-attached diagnostics, no outage authority) were
  merged into its existing wording rather than duplicated

### Undiscoverable Facts

- `prompts/pr_review_brief/prompt.md` also says "Every finding remains
  blocking"; there it describes the fleet reviewer's own request-changes
  verdict, not completion gating, so it was left unchanged (the issue scopes
  this to the standard and its manual)

## Evidence

Documentation-only change. Claims moved into the manual were checked against
the code: `classifyRunFailure(category, failureMessage, declaredCategory, …)`
at `worker/deno/lib/run_outcome_classifier.ts:454` (declared categories read
only the worker part of the message via `splitAgentNarration`), and the
source-scan test at `worker/deno/tests/failure_diagnosis_test.ts:980`, whose
positive cases include direct, assigned and nested result literals and whose
negative cases include comments and string/regex lookalikes. The runner stop
fields (`watchdogLateSeconds`, `killIncompleteSeconds`) are in
`worker/deno/lib/claude_runner.ts`.

Related rules checked: the issue states no rule is added. No twin copy of this
section exists in `prompts/coding_guidelines/prompt.md` (grep for "Worker
failure causes", "kill probes" and "remains blocking" found only the edited
files and the reviewer brief noted above).

## Test Plan

- No tests added or changed; no test pins the removed sentences.
- `markdownlint-cli2 CODING-STANDARDS.md docs/workflows/issue-processing.md`:
  0 issues.
- `deno test` on `worker/deno/tests/agents_md_pointer_anchors_test.ts`,
  `worker/deno/tests/coding_guidelines_twin_drift_test.ts`,
  `worker/deno/tests/failure_diagnosis_test.ts` and
  `worker/deno/tests/pre_pr_verifier_3395_test.ts`: 193 passed, 0 failed.
- `./quality.sh`: passed (config integration and checkov skipped by the gate
  itself).
