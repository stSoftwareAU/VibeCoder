# PR Summary — Issue #3454

## Summary

Closes #3454

When a security-fix gate refusal ends a run, its reason now opens with the
worker-written `SECURITY_FIX_GATE_MARKER`. `detectFailureCategory` checks for it
with `startsWith`, before any free-text rule, and returns the new
`security_fix_gate` category. That category is an `agent-outcome`
(`not_code_fixable`). The pattern copies PR #3440's `SUMMARY_RULE_GATE_MARKER`.

## Spec

### Intent and Rationale

The gate's refusal comment quotes the agent's test declarations from the diff,
for example `Deno.test("rejects TypeError: … within timeout")`. The free-text
rules then read the quoted text as a worker crash, a timeout or a rate limit,
and the worker auto-files a false issue. A prefix that only the worker writes
cannot be imitated by quoted agent text. Requiring it at position 0 means a
marker quoted later in the text has no effect.

### Essential Design Decisions

- **Only the run-ending reason is marked.** That is `reportBlock(…,
  countsAsBlockedRun=true)` in `lib/security_fix_gate_retry.ts`, the second
  block in the same run.
- **The first-block reason in `lib/phases/completion_phase.ts` is not marked.**
  `workOnIssueCompletion` always passes that reason to
  `recoverFromSecurityGateBlock`, which replaces it, so it never ends a run.
- **The retry-launch failure reason is left unmarked on purpose.** A rate limit
  or a spawn failure is still classified on its own text, so a real
  infrastructure fault keeps its category.
- **The new category is handled like `summary_incomplete` everywhere it
  matters:**
  - `classifyCodingFailure` returns `ladder` (a normal attempt).
  - `classifyRunFailure` returns `AGENT_OUTCOME`.
  - `detectHostFault` returns `null`, so quoted `ENOSPC` or clone-failure text
    cannot raise a host fault.

### Undiscoverable Facts

- Residual risk: the launch-failure reason also quotes the block comment, so
  declarations quoted there can still be misread. This trade-off is
  deliberate, so that a genuine launch fault is never hidden.

## Evidence

```mermaid
flowchart TD
    R[run failure reason] --> S{startsWith SUMMARY_RULE_GATE_MARKER?}
    S -- yes --> SI[summary_incomplete]
    S -- no --> G{startsWith SECURITY_FIX_GATE_MARKER?}
    G -- yes --> SF["security_fix_gate (agent-outcome)"]
    G -- no --> F["free-text rules: SIGKILL, SIGTERM, timeout, rate_limit, Error:"]
```

Cited issues:

- #3454: Security-fix gate refusals that quote an agent test declaration containing `Error:` are classed worker-crash and auto-filed
- #3440: fix(worker): classify summary-gate refusals as summary_incomplete, not worker-crash (#3431)
- #3431: fix(worker): worker-crash — runs releasing with no PR
- #1575: A false security-fix gate block costs a whole run (#1385 lost three attempts)

Docs sweep: section: `docs/security-fix-gate-feedback.md` "The in-run retry
(Issue #1575)" and "Recognising a false block", `docs/INTERNALS.md` (new
security-fix gate marker subsection, inserted above the unchanged
"🩹 Host-fault failure labels release themselves (Issue #2890)" heading),
`docs/workflows/issue-processing.md` (new paragraph). Both doc paragraphs and
the `SECURITY_FIX_GATE_MARKER` JSDoc say that only the run-ending twice-blocked
report (`reportBlock` with `countsAsBlockedRun` true) is marked, and that the
completion phase's first-block reason stays unmarked; siblings: `summary_incomplete`, `"summary-incomplete"`,
`workflow_gate`. Every switch and list that names those siblings in
`lib/failure_diagnosis.ts` (category union, display union,
`VALID_FAILURE_CATEGORIES`, the infrastructure, display, diagnosis and
oneliner switches) now also names `security_fix_gate`.

Related rules checked: none found. This change adds no rule to a prompt
template or coding standard.

## Test Plan

- [x] TDD: the new tests in `worker/deno/tests/failure_diagnosis_test.ts`,
      `worker/deno/tests/run_outcome_classifier_test.ts`,
      `worker/deno/tests/coding_failure_ladder_test.ts`,
      `worker/deno/tests/host_fault_test.ts`,
      `worker/deno/tests/completion_phase_security_gate_retry_test.ts` and
      `worker/deno/tests/security_fix_gate_retry_test.ts` fail against the
      base. Targeted run of those six files: 224 passed, 0 failed; fmt, lint
      and check are clean.
- [x] Red-checks, each mutation reverted afterwards:

  | Mutation | Result |
  | --- | --- |
  | Remove the detector rule | 3 failed |
  | Change `startsWith` to `includes` | 1 failed (the prefix test) |
  | Remove the ladder early return | 1 failed |
  | Remove the classifier early return | 3 failed |
  | Remove the `host_fault` early return | 1 failed |
  | Remove the `reportBlock` prefix | test (a) failed |
  | Make `reportBlock` always mark | test (c) and the existing "a retry that cannot be launched charges no blocked run" failed |
  | Delete `status: "failure"` from the `reportBlock` return (`lib/security_fix_gate_retry.ts:254`) | 2 failed (the two direct `security_fix_gate_retry_test.ts` tests) |

**Branch outcomes:**

- `worker/deno/lib/failure_diagnosis.ts:324`: marker at position 0 →
  `security_fix_gate`. Reached by
  `worker/deno/tests/failure_diagnosis_test.ts::detectFailureCategory - a marked security-fix gate refusal quoting TypeError and timeout is security_fix_gate (Issue #3454)`.
  Removing the rule turned it red.
- `worker/deno/lib/failure_diagnosis.ts:324`: marker only quoted inside the
  text → falls through to the free-text rules. Reached by
  `worker/deno/tests/failure_diagnosis_test.ts::detectFailureCategory - the security-fix gate marker must be a prefix, not merely included (Issue #3454)`.
  Changing it to `includes` turned it red.
- `worker/deno/lib/coding_failure_ladder.ts:165`, `security_fix_gate`
  operand → `ladder`. Reached by
  `worker/deno/tests/coding_failure_ladder_test.ts::classifyCodingFailure - a marked security-fix gate refusal quoting a timeout and the cycle deadline earns a normal attempt (Issue #3454)`.
  Removing the operand turned it red. The `summary_incomplete` operand is
  covered by the existing #3431 test.
- `worker/deno/lib/run_outcome_classifier.ts:250`: `security_fix_gate` →
  `AGENT_OUTCOME`. Reached by
  `worker/deno/tests/run_outcome_classifier_test.ts::classifyRunFailure - a marked security-fix gate refusal is not_code_fixable and an agent-outcome (Issue #3454)`.
  Removing it turned it red.
- `worker/deno/lib/host_fault.ts:100`: marker prefix → `null`. Reached by
  `worker/deno/tests/host_fault_test.ts::host fault - a marked security-fix gate refusal quoting ENOSPC or a clone failure is never a host fault (Issue #3454)`.
  Removing it turned it red.
- `worker/deno/lib/security_fix_gate_retry.ts:256`, `countsAsBlockedRun` true
  → marked reason. Reached by
  `worker/deno/tests/completion_phase_security_gate_retry_test.ts::completion - a second block quoting TypeError and timeout is marked as the security-fix gate (Issue #3454)`.
  Dropping the prefix turned it red.
- `worker/deno/lib/security_fix_gate_retry.ts:256`, `countsAsBlockedRun` false
  → unmarked reason. Reached by
  `worker/deno/tests/completion_phase_security_gate_retry_test.ts::completion - a launch failure is not marked as the security-fix gate (Issue #3454)`.
  Marking it always turned it red.
- `worker/deno/lib/security_fix_gate_retry.ts:254`, the `reportBlock` return
  carries `status: "failure"` on both paths. Reached by
  `worker/deno/tests/security_fix_gate_retry_test.ts::gate retry - a second block ends the run in failure with the gate marker (Issue #3454)`
  and
  `worker/deno/tests/security_fix_gate_retry_test.ts::gate retry - a retry that cannot be launched ends the run in failure, unmarked (Issue #3454)`.
  These call `recoverFromSecurityGateBlock` directly, so the mutation check
  (which runs only tests that import the mutated module) reaches the line.
  Deleting the property turned both red.

Persisted data: none. `security_fix_gate` is a new category value, and no
stored record changes shape.

Quality gate: `./quality.sh` ran for about 20 minutes and was stopped by the
tool time limit before the full test suite finished. Every stage that
completed passed: completeness checks, source targets, mermaid,
markdownlint, semgrep and the release-tag ruleset. The targeted suites for
every touched file pass (224/0), and fmt, lint and check are clean. CI runs
the full gate.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh exceeded the tool time limit (stopped after ~20 min); completed stages all passed; targeted tests, fmt, lint and check green" -->

## Pre-PR Security Self-Check

- [x] No secrets or hidden files staged.
- [x] No new external input, shell, SQL or path surface. The marker is a
      worker-written constant, and the match is a fixed-prefix `startsWith`
      with no regex.
