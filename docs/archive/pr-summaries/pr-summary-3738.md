## Summary

Closes #3738.

Worker failures declare their existing category at the source and retain it
through infrastructure retry, failure bookkeeping and the existing outcome and
callback. A typed pre-push network failure stays infrastructure. Source-declared
worker gate/verifier verdicts resist contrary quotations. Raw quality-output
diagnosis retains its existing compatibility behaviour.

Verifier diagnostics distinguish evidence-contract failures from substantive
implementation/test findings and retain simultaneous causes. Known execution,
handover and host diagnostics remain visible without inventing missing causes.
The accepted role configuration and merge protections are unchanged.

## Spec

### Intent and Rationale

Stop transport failures consuming coding-failure attempts solely because a new
worker wrapper chose different prose. Preserve the opposite protection too:
quoted outage, billing and timeout text must not exempt a substantive defect.

### Essential Design Decisions

- Require the existing `FailureCategory` on phase failure/early-exit results and
  unsuccessful work results. Migrate existing literal causes and carry them
  through the orchestrator and production failure handler.
- Reuse the existing pre-push error classes with discriminating kinds. Completion
  maps infrastructure and verdict cases exhaustively. Both still block the push.
  Declared hand-off push/token failures retain their actual source category.
- Keep raw/legacy text diagnosis as an explicit adapter. The classifier requires
  callers to choose raw or declared provenance; optional existing classification
  and runner termination fields travel through existing results and callbacks.
  The raw external quality-output adapter is captured once and its existing
  infrastructure retry behaviour is retained.
  Declared timeout diagnostics retain the established error-shaped disk-evidence
  refinement, while billing quotations cannot replace an execution timeout.
- Accept only evidence or quality tags on verifier findings; omissions and
  unsupported tags are treated as substantive when consumed. Every finding
  blocks. Folding keeps all causes and chooses quality when present. Existing-PR
  holds and blocked-PR callbacks retain the same diagnostics.
- Preserve stored summary/quality verdicts in label-release sweeps before
  examining quoted evidence. Do not falsely mark verifier prose as repository
  quality-gate output. Existing milestone protection is retained through the
  shared renamed predicate; its real writer already includes quality diagnosis.
- Reuse the existing language-aware source lexer in the phase source-scan test.
  No second parser, failure taxonomy, telemetry store or model invocation is added.
  Semantic already-landed reconciliation remains #3977's responsibility.

### Undiscoverable Facts

None. Live fleet improvement and deployed-build adoption are not established by
these deterministic fixtures; #3980 owns that measurement.

```mermaid
flowchart LR
  Source[Source category and known diagnostics] --> Retry[Bounded retry and failure decision]
  Retry --> Labels[Existing failure handler]
  Source --> Outcome[Existing outcome and callback]
  Findings[Evidence and substantive findings] --> Outcome
```

## Evidence

- #3738: Fleet PRs add failure paths whose git or network errors classify as the branch's fault, so an outage uses a ladder attempt (VibeCoder#3095, #3716).
- #3977: Reconcile already-merged work before push recovery and failure labelling.
- #3980: Measure stabilization by default-branch delivery and full rework cost using the existing lifecycle ledger.

- #3738 supplies both public failure paths and the four stabilisation criteria.
- The pre-push source-to-decision regression failed before categories were
  carried. Typed-error, verifier-tag, known-host, stored-record, timeout-billing,
  blocked-PR and source-scan edge regressions each produced assertion failures
  during development, then passed after repair.
- The original twenty-two changed test suites pass: 627 tests, no failures. Their imports
  and fixtures type-check.
- Thirty-nine retained production mutations each fail a named regression
  assertion. An unobservable secondary category-selection branch was removed;
  no surviving mutation is represented as red.
- Integration with main `ec79d58b` retains already-landed reconciliation before failure bookkeeping and preserves source categories on failures. The new already-landed phase result declares the existing `unknown` category while retaining its expected-skip outcome; both sides' reconciliation and source-cause assertions remain. Nine focused completion/quality/orchestration/failure suites pass with type checking: 291 tests, no failures. The assertion ledger still accounts for all 22 earlier replacements, and no assertion is removed by this integration. Branch-outcome citations are mapped to the integrated source. The subsequent main `3b6cc28f` summary integration also passes the body-sync, summary-loader and facts suites with type checking. Required hosted checks validate the pushed head.
- Final integrated production and test files match the source exercised by 897 targeted unit tests across 29 suites, 791 manifest tests (one existing ignored), and type checking of all 25 changed test files. The seven 15-second retry-path timing warnings remain visible; no budget or assertion changed. Worker formatting and lint passed. The quality-label source citation now points to the category forwarded to failure bookkeeping, and the facts renderer regenerates the Branch outcomes block. Final-head hosted CI and valid independent review remain required.
- Foreground `./quality.sh --sequential < /dev/null` passed at implementation head `74bdb230dbac4e26bace51fd98254cdcb5f305f3`: both unit passes, completeness, lint, type check, format, Markdown/Mermaid, Semgrep and the repository static/security checks. Optional local configuration integration was skipped because `.config.json` is absent. Required CI and merge protections remain in force.
- Independent Spec and Standards source reviews found no remaining material
  findings. Their earlier findings drove the source-provenance, callback and
  lexer fixes described here.
- Docs sweep — grep: `FailureCategory`, `detectFailureCategory`,
  `isSummaryGateFailureRecord`, `pre_push_gate`; updated `CODING-STANDARDS.md`,
  `docs/INTERNALS.md`, `docs/workflows/issue-processing.md` and
  `prompts/pr_review_brief/prompt.md`; section:
  `docs/workflows/issue-processing.md` → "Source-declared failure causes";
  siblings: existing `summary_incomplete`, `quality_check`, `push_failure`,
  `token_scope`, `scheduled_release`, `timeout`, `killed`, `internal_error` and
  `clone_corrupt` retain their existing enum ownership; no enum member is added.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The same git/network fault retains its infrastructure cause through the final failure handler and does not spend a coding-failure attempt merely because a gate wrapper caught it. — evidence: typed pre-push and declared-hand-off source → retry/ladder → callback fixtures, plus production forwarding. — reviewer: met
- **met** — Evidence-only, substantive and mixed verifier findings remain distinguishable in the existing diagnostic/event output; real defects still block. — evidence: completion, existing-PR and blocked-PR fixtures assert primary/all causes and retained holds. — reviewer: met
- **met** — Known handover/host causes are not presented as code defects, while unknown and genuine execution failures remain visible. — evidence: runner provenance, genuine disk diagnostics, legacy/unknown controls and a quoted billing timeout that still uses the ladder. — reviewer: met
- **met** — Tests exercise source result → retry/label decision → emitted outcome, including quoted output that resembles another category. — evidence: completion and hand-off composed production paths, real failure-record writers and callback regressions. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Source host and stop diagnostics were initially lost at a category-only boundary. — evidence: `worker/deno/lib/phases/execute_phase.ts:1444` — reason: fixed in this diff by carrying the existing classification and runner fields; the disk regression failed before the repair.
- **violation** — Existing-PR and blocked-PR callbacks initially lost selected or simultaneous verifier causes. — evidence: `worker/deno/lib/run_callback_context.ts:179` — reason: fixed in this diff in the existing outcome/callback contracts with assertion-sensitive regressions.
- **violation** — A duplicate source lexer missed computed keys/type assertions and rejected a legal regex. — evidence: `worker/deno/tests/failure_diagnosis_test.ts:937` — reason: fixed in this diff by removing the duplicate in favour of the shared source lexer and edge/legal controls.
- **violation** — A raw timeout refinement allowed quoted billing text to skip the ladder. — evidence: `worker/deno/lib/run_outcome_classifier.ts:349` — reason: fixed in this diff by declared provenance plus the narrow existing disk refinement; the source-to-callback billing regression failed before repair.
- **clean** — Independent source review checked Result contracts, shared ownership, explicit provenance, assertion preservation, blocking findings and unchanged role/merge controls. Full quality evidence is recorded after the required gate completes.

## Test Plan

The current source tests include the source → failure decision → emitted outcome
path, contrary quoted categories, valid legacy/raw controls and real posted
failure records. Type checking enforces required category/provenance contracts.
No test, skip, threshold or meaningful existing expectation is weakened.

- `worker/deno/tests/completion_phase_head_reconcile_test.ts` preserves typed divergence refusal and the opposite bounded infrastructure retry.
- `worker/deno/tests/quality_gate_attempt_report_test.ts` preserves the terminal turn-limit stop despite quoted rate-limit prose.

- `worker/deno/tests/coding_failure_ladder_test.ts` checks declared-cause precedence and retains raw/legacy controls.
- `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` checks evidence/substantive/mixed causes and retained blockers.
- `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` checks source git faults through retry, failure decisions and emitted outcomes.
- `worker/deno/tests/declared_handoff_phase_3088_test.ts` checks source git faults through retry, failure decisions and emitted outcomes.
- `worker/deno/tests/execute_phase_scheduled_release_424_test.ts` checks stop provenance, known disk diagnostics and quoted billing controls.
- `worker/deno/tests/failure_diagnosis_test.ts` checks the shared-lexer phase guard and preserves legacy diagnosis.
- `worker/deno/tests/git_push_preflight_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/haiku_refusal_retry_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/host_fault_release_test.ts` checks real posted substantive records retain their failure labels.
- `worker/deno/tests/host_fault_test.ts` checks declared-cause precedence and retains raw/legacy controls.
- `worker/deno/tests/issue_worker_infra_retry_test.ts` checks declared-cause precedence and retains raw/legacy controls.
- `worker/deno/tests/label_manager_test.ts` checks declared-cause precedence and retains raw/legacy controls.
- `worker/deno/tests/merged_pr_precheck_phase_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/merged_pr_precheck_reapproval_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/milestone_branch_refusal_release_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/pre_pr_verifier_3395_test.ts` checks evidence/substantive/mixed causes and retained blockers.
- `worker/deno/tests/pre_push_gate_failure_category_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/run_callback_context_test.ts` checks all causes survive a blocked PR callback.
- `worker/deno/tests/run_outcome_classifier_test.ts` checks declared worker diagnostics and explicit legacy raw-text provenance.
- `worker/deno/tests/security_fix_gate_retry_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/work_on_issue_command_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.
- `worker/deno/tests/work_on_issue_idle_task_routing_test.ts` retains existing behaviour with the typed result/error or explicit provenance contract.

The source-scan corpus is the 13 existing direct `.ts` members of
`worker/deno/lib/phases/`; it does not scan other directories or classify live
run prose. The reviewed current phase corpus has no prohibited result-literal
calls and produces zero false positives. It contains no independent real
positive examples, so real-world false negatives/recall are unknown. Eight
synthetic prohibited shapes and eight legal/comment/literal controls all pass
the regression's expected decisions; those fixtures are not fleet measurements.

The replacement ledger below accounts for the required category field in four
whole-result expectations and explicit raw provenance in legacy classifier calls.
Their existing payload and classification expectations remain intact.

- Removed from `worker/deno/tests/haiku_refusal_retry_test.ts`: `assertEquals(h.result, { status: "early_exit", reason: "no_changes" });`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(h.result, {
    status: "early_exit",
    category: "unknown",
    reason: "no_changes",
  });`

- Removed from `worker/deno/tests/merged_pr_precheck_phase_test.ts`: `assertEquals(result, { status: "early_exit", reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON, });`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(result, {
      status: "early_exit",
      category: "unknown",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    });`

- Removed from `worker/deno/tests/merged_pr_precheck_reapproval_test.ts`: `assertEquals(result, { status: "early_exit", reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON, });`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(result, {
      status: "early_exit",
      category: "unknown",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    });`

- Removed from `worker/deno/tests/pre_push_gate_failure_category_test.ts`: `assertEquals( classifyRunFailure("pre_push_gate", gateReason).failureClass, "agent-outcome", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("pre_push_gate", gateReason, false).failureClass,
    "agent-outcome",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("rate_limit", "rate limit reached").failureClass, "usage-limit", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("rate_limit", "rate limit reached", false).failureClass,
    "usage-limit",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", "OUT OF CREDIT — Payment Required") .failureClass, "out-of-credit", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", "OUT OF CREDIT — Payment Required", false)
      .failureClass,
    "out-of-credit",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("killed", "KILLED PROCESS 4211 (claude) OUT OF MEMORY") .failureClass, "oom", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure(
      "killed",
      "KILLED PROCESS 4211 (claude) OUT OF MEMORY",
      false,
    )
      .failureClass,
    "oom",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", "No Space Left On Device").failureClass, "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", "No Space Left On Device", false)
      .failureClass,
    "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", "Disk Full while writing checkpoint") .failureClass, "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", "Disk Full while writing checkpoint", false)
      .failureClass,
    "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", "UNHANDLED EXCEPTION in worker").failureClass, "worker-crash", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", "UNHANDLED EXCEPTION in worker", false)
      .failureClass,
    "worker-crash",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals(classifyRunFailure("unknown", ""), { fixability: "unknown", failureClass: "unknown", rationale: "No signal in the category or message decides fixability.", });`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(classifyRunFailure("unknown", "", false), {
    fixability: "unknown",
    failureClass: "unknown",
    rationale: "No signal in the category or message decides fixability.",
  });`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure(detectFailureCategory(""), "").fixability, "unknown", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure(detectFailureCategory(""), "", false).fixability,
    "unknown",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", message).failureClass, "worker-crash", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", message, false).failureClass,
    "worker-crash",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: ``assertEquals( classifyRunFailure("timeout", message).failureClass, "timeout", `agent prose must not classify as a crash: ${prose}`, );``
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: ``assertEquals(
      classifyRunFailure("timeout", message, false).failureClass,
      "timeout",
      `agent prose must not classify as a crash: ${prose}`,
    );``

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("timeout", message).failureClass, "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("timeout", message, false).failureClass,
    "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assert( classifyRunFailure("unknown", "see /var/log/ENOSPC/notes.txt") .failureClass !== "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assert(
    classifyRunFailure("unknown", "see /var/log/ENOSPC/notes.txt", false)
      .failureClass !==
      "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assert( classifyRunFailure("unknown", "https://example.test/ENOSPC-handling") .failureClass !== "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assert(
    classifyRunFailure("unknown", "https://example.test/ENOSPC-handling", false)
      .failureClass !== "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals(classifyRunFailure("unknown", m).failureClass, "disk-full", m);`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
      classifyRunFailure("unknown", m, false).failureClass,
      "disk-full",
      m,
    );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("unknown", "got enospc: no space left on device") .failureClass, "disk-full", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("unknown", "got enospc: no space left on device", false)
      .failureClass,
    "disk-full",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure( "killed", "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM)", ).failureClass, "oom", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure(
      "killed",
      "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM)",
      false,
    ).failureClass,
    "oom",
  );`

- Removed from `worker/deno/tests/run_outcome_classifier_test.ts`: `assertEquals( classifyRunFailure("security_fix_gate", message).failureClass, "agent-outcome", );`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(
    classifyRunFailure("security_fix_gate", message, false).failureClass,
    "agent-outcome",
  );`

<!-- vibe-branch-outcomes -->
**Branch outcomes:**

- `worker/deno/lib/infra_retry.ts:130` — `retry declaration preserves the declared cause or diagnostic contract` — test `worker/deno/tests/issue_worker_infra_retry_test.ts` (`infra retry honours a declared cause over a contradictory wrapper (Issue #3738)`) — flip: `retry-declaration mutation failed the named assertion`
- `worker/deno/lib/coding_failure_ladder.ts:163` — `ladder declaration preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `ladder-declaration mutation failed the named assertion`
- `worker/deno/lib/coding_failure_ladder.ts:207` — `ladder infrastructure preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `ladder-infrastructure mutation failed the named assertion`
- `worker/deno/lib/coding_failure_ladder.ts:194` — `ladder deadline preserves the declared cause or diagnostic contract` — test `worker/deno/tests/coding_failure_ladder_test.ts` (`declared failure causes outrank quoted deadline and timeout wording (Issue #3738)`) — flip: `ladder-deadline mutation failed the named assertion`
- `worker/deno/lib/coding_failure_ladder.ts:223` — `ladder timeout kind preserves the declared cause or diagnostic contract` — test `worker/deno/tests/coding_failure_ladder_test.ts` (`declared failure causes outrank quoted deadline and timeout wording (Issue #3738)`) — flip: `ladder-timeout-kind mutation failed the named assertion`
- `worker/deno/lib/host_fault.ts:99` — `host clone declaration preserves the declared cause or diagnostic contract` — test `worker/deno/tests/host_fault_test.ts` (`host diagnosis honours declared causes and retains raw internal diagnostics (Issue #3738)`) — flip: `host-clone-declaration mutation failed the named assertion`
- `worker/deno/lib/host_fault.ts:100` — `host declared verdict preserves the declared cause or diagnostic contract` — test `worker/deno/tests/host_fault_test.ts` (`host diagnosis honours declared causes and retains raw internal diagnostics (Issue #3738)`) — flip: `host-declared-verdict mutation failed the named assertion`
- `worker/deno/lib/host_fault.ts:100` — `host raw diagnostics preserves the declared cause or diagnostic contract` — test `worker/deno/tests/host_fault_test.ts` (`host diagnosis honours declared causes and retains raw internal diagnostics (Issue #3738)`) — flip: `host-raw-diagnostics mutation failed the named assertion`
- `worker/deno/lib/label_failure.ts:490` — `label handler declaration preserves the declared cause or diagnostic contract` — test `worker/deno/tests/label_manager_test.ts` (`failure label handler retains declared substantive cause despite quoted host and rate text (Issue #3738)`) — flip: `label-handler-declaration mutation failed the named assertion`
- `worker/deno/lib/failure_diagnosis.ts:287` — `host record category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/host_fault_release_test.ts` (`declared substantive verifier records survive the host-fault release sweep (Issue #3738)`) — flip: `host-record-category mutation failed the named assertion`
- `worker/deno/lib/phases/declared_handoff.ts:131` — `handoff network category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/declared_handoff_phase_3088_test.ts` (`declared handoff retains network and token causes through the failure decision and callback (Issue #3738)`) — flip: `handoff-network-category mutation failed the named assertion`
- `worker/deno/lib/phases/declared_handoff.ts:125` — `handoff token category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/declared_handoff_phase_3088_test.ts` (`declared handoff retains network and token causes through the failure decision and callback (Issue #3738)`) — flip: `handoff-token-category mutation failed the named assertion`
- `worker/deno/lib/git_push.ts:553` — `gate error verdict kind preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `gate-error-verdict-kind mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:2154` — `gate infrastructure map preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `gate-infrastructure-map mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:2156` — `gate verdict map preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `gate-verdict-map mutation failed the named assertion`
- `worker/deno/lib/pre_pr_verifier.ts:225` — `verifier evidence tag preserves the declared cause or diagnostic contract` — test `worker/deno/tests/pre_pr_verifier_3395_test.ts` (`verifier findings preserve evidence and substantive causes without accepting infrastructure claims (Issue #3738)`) — flip: `verifier-evidence-tag mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:732` — `mixed primary quality preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`completion retains evidence, substantive and mixed verifier causes without hiding blockers (Issue #3738)`) — flip: `mixed-primary-quality mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:3408` — `verifier default substantive preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`completion retains evidence, substantive and mixed verifier causes without hiding blockers (Issue #3738)`) — flip: `verifier-default-substantive mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:909` — `summary existing pr causes preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`existing PR outcomes retain evidence and substantive verifier causes through callbacks (Issue #3738)`) — flip: `summary-existing-pr-causes mutation failed the named assertion`
- `worker/deno/lib/run_outcome.ts:389` — `summary outcome category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`existing PR outcomes retain evidence and substantive verifier causes through callbacks (Issue #3738)`) — flip: `summary-outcome-category mutation failed the named assertion`
- `worker/deno/lib/run_outcome.ts:399` — `summary outcome causes preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`existing PR outcomes retain evidence and substantive verifier causes through callbacks (Issue #3738)`) — flip: `summary-outcome-causes mutation failed the named assertion`
- `worker/deno/lib/run_callback_context.ts:157` — `callback primary category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts` (`existing PR outcomes retain evidence and substantive verifier causes through callbacks (Issue #3738)`) — flip: `callback-primary-category mutation failed the named assertion`
- `worker/deno/lib/run_callback_context.ts:179` — `callback blocked causes preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_callback_context_test.ts` (`callback context retains all declared causes after a PR exists (Issue #3738)`) — flip: `callback-blocked-causes mutation failed the named assertion`
- `worker/deno/lib/run_outcome.ts:292` — `outcome blocked causes preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_callback_context_test.ts` (`callback context retains all declared causes after a PR exists (Issue #3738)`) — flip: `outcome-blocked-causes mutation failed the named assertion`
- `worker/deno/lib/run_outcome.ts:314` — `outcome declared category preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (`completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)`) — flip: `outcome-declared-category mutation failed the named assertion`
- `worker/deno/lib/phases/execute_phase.ts:1451` — `execute source classification preserves the declared cause or diagnostic contract` — test `worker/deno/tests/execute_phase_scheduled_release_424_test.ts` (`execute timeout keeps its known cause when agent output quotes billing text (Issue #3738)`) — flip: `execute-source-classification mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:250` — `classifier declared provenance preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_outcome_classifier_test.ts` (`declared causes retain worker diagnosis without accepting quoted billing or crash text (Issue #3738)`) — flip: `classifier-declared-provenance mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:251` — `classifier kill refinement preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_outcome_classifier_test.ts` (`declared causes retain worker diagnosis without accepting quoted billing or crash text (Issue #3738)`) — flip: `classifier-kill-refinement mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:251` — `classifier rate refinement preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_outcome_classifier_test.ts` (`declared causes retain worker diagnosis without accepting quoted billing or crash text (Issue #3738)`) — flip: `classifier-rate-refinement mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:253` — `classifier agent mask preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_outcome_classifier_test.ts` (`declared causes retain worker diagnosis without accepting quoted billing or crash text (Issue #3738)`) — flip: `classifier-agent-mask mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:349` — `classifier disk preservation preserves the declared cause or diagnostic contract` — test `worker/deno/tests/execute_phase_scheduled_release_424_test.ts` (`execute retains a known disk fault from the CLI boundary through failure bookkeeping (Issue #3738)`) — flip: `classifier-disk-preservation mutation failed the named assertion`
- `worker/deno/lib/coding_failure_ladder.ts:224` — `ladder quoted timeout preserves the declared cause or diagnostic contract` — test `worker/deno/tests/coding_failure_ladder_test.ts` (`declared failure causes outrank quoted deadline and timeout wording (Issue #3738)`) — flip: `ladder-quoted-timeout mutation failed the named assertion`
- `worker/deno/lib/run_outcome_classifier.ts:252` — `classifier internal refinement preserves the declared cause or diagnostic contract` — test `worker/deno/tests/run_outcome_classifier_test.ts` (`declared causes retain worker diagnosis without accepting quoted billing or crash text (Issue #3738)`) — flip: `classifier-internal-refinement mutation failed the named assertion`
- `worker/deno/lib/pre_pr_verifier.ts:225` — `verifier quality tag preserves the declared cause or diagnostic contract` — test `worker/deno/tests/pre_pr_verifier_3395_test.ts` (`verifier findings preserve evidence and substantive causes without accepting infrastructure claims (Issue #3738)`) — flip: `verifier-quality-tag mutation failed the named assertion`
- `worker/deno/lib/phases/quality_gate_remediation_phase.ts:692` — `quality raw infrastructure preserves the declared cause or diagnostic contract` — test `worker/deno/tests/issue_worker_infra_retry_test.ts` (`qualityGate - zero_output failure then success on retry does NOT call handleIssueFailure`) — flip: `quality-raw-infrastructure mutation failed the named assertion`
- `worker/deno/lib/phases/quality_gate_remediation_phase.ts:235` — `quality label provenance preserves the declared cause or diagnostic contract` — test `worker/deno/tests/issue_worker_infra_retry_test.ts` (`qualityGate - zero_output failure on both attempts invokes handleIssueFailure exactly once`) — flip: `quality-label-provenance mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:1884` — `reconcile declared divergence preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_head_reconcile_test.ts` (`completion - diverged agent/worker branches fail with the explicit reason, never reaching gh pr create (Issue #4286)`) — flip: `reconcile-declared-divergence mutation failed the named assertion`
- `worker/deno/lib/phases/completion_phase.ts:1884` — `reconcile declared infrastructure preserves the declared cause or diagnostic contract` — test `worker/deno/tests/completion_phase_head_reconcile_test.ts` (`completion keeps unreadable reconciliation infrastructure even when its prose mentions divergence (Issue #3738)`) — flip: `reconcile-declared-infrastructure mutation failed the named assertion`
- `worker/deno/lib/phases/quality_gate_remediation_phase.ts:737` — `quality turn cap declaration preserves the declared cause or diagnostic contract` — test `worker/deno/tests/quality_gate_attempt_report_test.ts` (`quality gate - turn limit stops remediation before a passing retry or bump audit (Issue #3701)`) — flip: `quality-turn-cap-declaration mutation failed the named assertion`
<!-- /vibe-branch-outcomes -->

- Removed from `worker/deno/tests/quality_gate_attempt_report_test.ts`: `assertEquals(result, { status: "failure", reason: message });`
  Required by: "Migrate mechanically, then stop the fallback spreading."
  Replaced by: `assertEquals(result, { category: "interrupted", status: "failure", reason: message });`
