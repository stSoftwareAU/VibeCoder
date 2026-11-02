## Summary

Removes the `(Issue #N)` suffixes from worker-authored text that is posted in a
target repository, where GitHub resolves a bare `#N` against that repository.
Covers the two builders the issue names and the five sibling strings its
comments list, plus the strings the sweep found: the planning hand-off message
in `execute_claude_phase.ts`, `buildRefusalFailureReason`,
`formatStaleClaimComment`, the timeout diagnostics in `failure_message.ts`, and
the host-fault, milestone-branch release and merged-PR sweep comments.
Provenance stays in the code comments beside each string. Closes #4641.

## Spec

### Intent and Rationale

- A run in a target repo posted `#1859`, `#3683`, `#2682`, `#4158`, `#148`,
  `#534`, `#2809`, `#3177`, `#3761` and `#4298` as links to unrelated
  target-repo issues. #4585 fixed the failure comment's one-line cause and
  detail bullets; these are the reasons and comments quoted beside them.
- The fix is the same as #4585's: drop the suffix, keep the provenance in code
  comments. No message loses a sentence that carried meaning.

### Essential Design Decisions

- A regression test per string asserts the output has no `#<digits>` except the
  target repo's own number, so a future suffix fails the build.
- The stale-lineage refusal still contains `#531`, the target repo's merged PR
  quoted from `lineage.detail`; its test asserts that is the only `#N` left.
- `execute_claude_phase.ts` (the `Handed to planning to split it` message) was
  not listed in the issue; it is the same defect on the same path
  (`failureMessage` reaching the failure comment), so it is fixed here.

### Undiscoverable Facts

- The sibling strings (`claim_issue.ts`, `completion_phase.ts`,
  `label_question_failure.ts`, `missing_criterion_close_guard.ts`,
  `independent_review_gate.ts`) come from the issue's comments.

## Evidence

Backend text only; no UI file changed. Issue numbers cited as provenance in the
diff, each looked up with `gh issue view`:

- `#148`: Preserve a timed-out run's WIP: commit + push the dirty tree to the
  issue branch, and size the claim to the budget (Issue #47 follow-up)
- `#4158`: Never park an assigned issue: drop the terminal `failed` label and
  the repeated-failure needs-human hand-off
- `#4585`: Unmet-criteria note, draft-continuation PR bodies, drift-check reply
  and failure comment still cite VibeCoder issue numbers in target repos
  (NEAT-AI#4131)
- `#4641`: this issue

Docs: grepped `README.md`, `docs/` (excluding `docs/archive/`) and `prompts/`
for the removed wording (`half-done PR (`, `Handed to planning to split it (`,
`trim or split the issue (`, `never parks it (`, `fix to the scanner (`,
`remains queued to finish the unmet criteria (`, `never parked (Issue`); no hit,
so no doc changed. `docs/USAGE.md:273` states the never-parked rule for readers
and is not text the worker posts.

Other worker-authored failure reasons: the first sweep matched only `reason:` /
`failureMessage` / `failureReason` literals and missed builder functions, so it
is redone over every exported `format*` / `build*` / `compose*` / `render*`
function whose name ends in Comment, Reason, Message, Note or Body (160
functions). Each hit was classed by where the text goes. Fixed here because the
text is posted in a target repo: `buildRefusalFailureReason` (the run's failure
reason), `formatStaleClaimComment`, the timeout diagnostics in
`formatDetailedFailureMessage`, `buildHostFaultReleaseComment`,
`buildRefusalReleaseComment` and `buildSweepCloseComment`. Left alone, because
the text goes to the worker's own repo (the
`Auto-filed by the Vibe Coder
(Issue #N)` reports in
`bump_script_failure_streak.ts`, `idle_starvation_escalation.ts`,
`pr_branch_update_failure_streak.ts`, `hard_kill_report.ts`,
`audit_failure_notifier.ts`), to `logger.*`, or is a code comment. Not checked:
a posted string built by a function whose name does not match those patterns.

## Test Plan

- New `worker/deno/tests/reasons_no_vibecoder_numbers_4641_test.ts` (gate
  message with and without a PR, prompt-too-long with and without a snippet,
  context-budget hand-off) and
  `worker/deno/tests/comments_no_vibecoder_numbers_4641_test.ts` (churn comment,
  repeat question failure, missing-criteria PR note, independent-review comment
  on both paths). Each went red on the unfixed code (stray `#1859`, `#3683`,
  `#2682`, `#4298`, `#4158`, `#3177`, `#3761`) and is green after the fix. The
  first-failure question comment and the criteria-stated review comment have no
  defect; their tests are positive controls and cannot go red.
- Edited `worker/deno/tests/completion_wip_only_gate_test.ts` and
  `worker/deno/tests/completion_phase_stale_lineage_test.ts`, and added a test
  to `worker/deno/tests/completion_phase_branch_conflict_test.ts` (a refused
  PR-raise sync reason), each asserting the reason carries no VibeCoder number;
  these went red on the unfixed code (`#148`, `#534`, `#2809`).
- Removed from `worker/deno/tests/completion_phase_stale_lineage_test.ts`:
  `assertStringIncludes(run.reason ?? "", "Issue #534")`
  - Required by: "Drop the `(Issue #N)` suffixes from these reason strings"
  - Replaced by: `assertStringIncludes(run.reason ?? "", "Refusing to push")`
    and the exact-token assertion `["#531"]`.
- New `worker/deno/tests/posted_text_no_vibecoder_numbers_4641_test.ts` covers
  the second-sweep builders (both `buildRefusalFailureReason` branches,
  `formatStaleClaimComment`, the late-watchdog and incomplete-kill diagnostics,
  and the three release/close comments), asserting no `#<digits>` token other
  than the PR it names. Each went red on the unfixed code (`#3406`, `#344`,
  `#4254`, `#2890`, `#2220`, `#504`).
- Removed from `worker/deno/tests/haiku_refusal_retry_test.ts`:
  `assertStringIncludes(text, "Issue #3406")`
  - Required by: "Drop the `(Issue #N)` suffixes from these reason strings"
  - Replaced by: `assert(!/#\d+/.test(text), ...)` on both refusal reasons.
- Removed from `worker/deno/tests/host_fault_release_test.ts`:
  `assertStringIncludes(single, "Issue #2890")`
  - Required by: the same issue, applied to the host-fault release comment
  - Replaced by: `assertStringIncludes(single, "back in the queue")`.
- Removed from `worker/deno/tests/merged_pr_issue_sweep_test.ts`:
  `assertStringIncludes(comment, "504")`
  - Required by: the same issue, applied to the sweep close comment
  - Replaced by:
    `assertStringIncludes(comment, "merged-PR issue sweep closed it")` and
    `assertEquals(comment.match(/#\d+/g), ["#49"])`.
- `deno task test:unit` over the seven touched and related files
  (`completion_phase_stale_lineage_test.ts`, `completion_wip_only_gate_test.ts`,
  `completion_phase_branch_conflict_test.ts`, both new files,
  `failure_diagnosis_test.ts`, `completion_phase_workflow_gate_pr_test.ts`): 129
  passed, 0 failed.
- Callers of the changed builders checked: `detectFailureCategory` keys off
  `WORKFLOW_GATE_MARKER` and `PROMPT_TOO_LONG_MARKER`, both unchanged; the
  WIP-only reason keeps the "without making any changes" marker. The refusal
  reason keeps its wording apart from the suffix, so it still avoids the
  infrastructure words `detectFailureCategory` keys off (asserted in
  `haiku_refusal_retry_test.ts`).
- `quote` at `.claude/skills/review-fleet-prs/scripts/auto_release.ts:29` is
  unchanged: that line is the `quote` parameter of `quoteFound` in
  `auto_release.ts`; the changed `quote` in `missing_criterion_close_guard.ts`
  is a private, unexported function and cannot be called from there.
- Existing tests whose fixtures still hold the old suffixes
  (`tests/failure_diagnosis_test.ts`, `tests/run_outcome_classifier_test.ts`,
  `tests/run_outcome_test.ts`) feed them as inputs and are unaffected.
- Duplicated harness: the context-budget test carries a small copy of the mock
  deps because `tests/execute_claude_phase_test.ts` keeps them private.

- `deno fmt --check`, `deno lint` and `deno check` on the touched files: clean.
- `./quality.sh` was started on the final head and hit the 595 s command cap
  (exit 124) before it finished, so the full gate did not complete.

<!-- vibe-quality-gate-skipped: ./quality.sh did not finish within the 595 s command cap on the final head; targeted tests, fmt, lint, type check and pr-summary-check passed; CI runs the full gate -->
