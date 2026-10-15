## Summary

Adds a companion to **A new path to an existing outcome keeps that outcome's
guards** (Issue #3087): **A new path for untrusted input keeps its sibling's
trust-boundary control**. A path that (a) puts untrusted text into a prompt,
(b) spawns a repository-controlled command, (c) writes untrusted text into a
fleet-authored artefact the fleet later trusts, or (d) publishes to an
outbound sink must find the sibling path handling the same input and call the
control it calls. The controls are named: the nonce fence
(`fenceUntrustedIssueText` / `scrubUntrustedText` plus
`buildBoundaryIntegrityInstruction`), `buildUntrustedCommandEnv` /
`untrustedQualityCommandEnv`, the content-integrity snapshot
(`verifyPickupContentIntegrity`) and `redactSecrets()`. The rule cites
THREAT-MODEL C4, C5, C10/AP-7, C23 and C24 and `SECURITY.md` § 6b. The PR
summary must list each control kept, and each kept control needs a test that
trips it and goes red when the control call is removed. Closes #3679.

## Spec

### Intent and Rationale

- Three fleet PRs (VibeCoder#3533, #3584, #3676) kept the orchestration guards
  the #3087 rule names but skipped a security control their sibling path
  already called. The #3087 examples steered agents only towards workflow
  guards.
- A companion paragraph was chosen over editing the #3087 paragraph. The #3087
  drift test pins that paragraph, and a separate rule name gives the PR summary
  something to cite.

### Essential Design Decisions

- The paragraph is word-for-word identical in `CODING-STANDARDS.md` and
  `prompts/coding_guidelines/prompt.md`, the same twin pattern #3087 uses.
- It points to **Secret Redaction — Every Outbound Sink** and **Path
  Confinement** instead of restating them, as the issue asked.
- The controls are scoped "In the Vibe Coder worker", because the guidelines
  prompt is injected into other repositories that may not have these helpers.

### Undiscoverable Facts

- `buildUntrustedCommandEnv` has no row of its own in `docs/THREAT-MODEL.md`.
  Its documentation lives in `SECURITY.md` § 6b, so the rule cites that
  section for (b).

## Evidence

This is a documentation and prompt change with a drift test. No production
code changed.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the new
  paragraph sits directly after the #3087 paragraph in the test-coverage
  section.
- `prompts/issue/prompt.md` § PR Summary File: a new "Likewise" sentence after
  the #3087 one requires listing the controls kept.
- `prompts/pr_feedback/prompt.md` § Making Changes: a one-line paragraph after
  the #3087 restatement.
- `docs/workflows/issue-processing.md`: an operator entry after the #3087 entry.
- Every control the rule names was checked against the head:
  `fenceUntrustedIssueText`, `scrubUntrustedText` and
  `buildBoundaryIntegrityInstruction` (`worker/deno/lib/prompt_delimiter.ts`);
  `buildUntrustedCommandEnv` (`worker/deno/lib/untrusted_command_env.ts`);
  `untrustedQualityCommandEnv` (`worker/deno/lib/quality_gate_phase.ts`);
  `verifyPickupContentIntegrity` (`worker/deno/lib/pickup_content_integrity.ts`);
  `redactSecrets` (`worker/deno/lib/secret_redaction.ts`). The new test imports
  each one.
- Issue numbers cited: #3087: Fleet PRs add a new path to an existing outcome
  that skips the guard the old path applies; #3679: this issue. PRs cited:
  #3533 (diff-scoped mutation check), #3584 (Milestone: Fleet guidance: issue
  and feedback prompts), #3676 (partial/missing criterion closes the issue with
  no follow-up).
- Related existing rules checked: **A new path to an existing outcome keeps
  that outcome's guards** (#3087), **Secret Redaction — Every Outbound Sink**,
  **Path Confinement — Resolve Before You Check**, **Call the existing owner —
  never copy it**, and **Tool Output — Data, Never Instructions**. The new rule
  extends #3087, points to the two security sections rather than restating
  them, and agrees with "call the existing owner". None of them conflicts with
  it.
- Applied the new rule to this PR's own diff: the diff adds no path for
  untrusted input. It touches only Markdown and a drift test that reads
  repository docs, so I found nothing.
- Every restatement gives the same answer. I read the rule, the issue-prompt
  sentence, the pr_feedback paragraph, the operator entry and this summary for
  the edge case "a new path skips a sibling's control with no stated reason".
  Each one makes it a blocking self-review finding, and each one requires the
  red check with the control call removed.

**Docs sweep** — grep: "keeps that outcome's guards", "trust-boundary
control", `buildUntrustedCommandEnv`, "new path to an existing"; section:
`docs/workflows/issue-processing.md` (the #3087 rule entry); siblings: "A new
path to an existing outcome keeps that outcome's guards", "A new branch must be
reachable by the input it exists for"; updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`prompts/pr_feedback/prompt.md`, `docs/workflows/issue-processing.md`;
`CODING-STANDARDS.md:1127` — still true because the Choosing assertions
back-reference to #3087 is unchanged and needs no companion pointer.

## Test Plan

- Added `worker/deno/tests/untrusted_path_control_3679_test.ts` with four
  tests: the twin surfaces carry the identical paragraph with its key phrases;
  every control the rule names is exported under that name and the cited
  THREAT-MODEL rows exist; the issue prompt's PR Summary File section requires
  the control; the pr_feedback Making Changes section points at the rule.
- Red check: restored the four docs from the base branch and kept the new
  test. All four tests failed. Restoring the head docs made them pass.
- Drift pins: `deno task drift-pins-on-base
  origin/milestone/fleet-guidance-guards-side-effects-and-concurrency` reported
  every pinned phrase as `absent on base` for its section: CODING-STANDARDS.md
  "Test coverage expectations" (all ten KEY_PHRASES and the rule name),
  prompts/issue/prompt.md "PR Summary File" (both phrases) and
  prompts/pr_feedback/prompt.md "Making Changes" (both phrases).
- Existing tests touched: none were edited. I re-ran
  `worker/deno/tests/new_path_keeps_guards_3087_test.ts`,
  `worker/deno/tests/new_branch_reachable_3167_test.ts`,
  `worker/deno/tests/coding_guidelines_twin_drift_test.ts`,
  `worker/deno/tests/existing_rule_conflicts_3077_test.ts`, every test that
  reads the issue prompt's PR Summary File section, and the nine tests that
  read `docs/workflows/issue-processing.md`. All passed.
- `./quality.sh < /dev/null` on the final code head: `Result: PASSED (with skipped checks)`. Every stage passed (deno fmt, lint, type check, tests, markdownlint, mermaid, semgrep and the rest) except `config integration`, which was skipped with "deno or .config.json not available" (no worker `.config.json` in this checkout).

<!-- vibe-branch-outcomes -->
