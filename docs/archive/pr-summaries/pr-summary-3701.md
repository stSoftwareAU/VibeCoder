## Summary

Apply a configurable positive `claude_max_turns` limit (default 100) to each
Claude Code and Claude-compatible DeepSeek invocation. Log the limit beside
`claude_timeout` and classify `error_max_turns` as a distinct terminal failure.
Issue, PR-feedback and CI-fix workflows hold partial work when an initial,
recovery or verifier invocation reaches the cap.

Closes #3701. This is the turn-limit portion of milestone 121; transcript and
runbook changes are recorded in [pr-summary-3700.md](pr-summary-3700.md).

## Spec

### Intent and Rationale

- Bound each CLI invocation independently of the wall-clock watchdog.
- Preserve a distinct terminal reason through every supported publication path.

### Essential Design Decisions

- Configuration accepts positive safe integers. The shared Claude-compatible
  argument builder always passes `--max-turns`; Codex/Gemini are unaffected.
- Worker, standalone command and shell bootstrap settle internal transport from
  config, overriding stale inherited `VIBE_CLAUDE_MAX_TURNS` values.
- The shared low-level runner logs the structured cause even without a caller
  logger. The retry API returns a typed `AgentTurnLimitError` with its structured
  execution diagnostics, so callers checking only `Result.ok` also stop.
- Feedback retains a terminal latch across helper callbacks, including later
  verifier and push-recovery boundaries. Planning and quality-remediation loops
  distinguish this terminal error from their existing recoverable failures.

### Undiscoverable Facts

- Installed Claude Code 2.1.302 does not advertise `--max-turns` in `--help`.
  An isolated credential-free invocation accepted the flag and stopped at
  authentication. Official CLI/SDK documentation supplies the flag and
  `error_max_turns` contract. No authenticated live cap-exhaustion was observed.
- Stub process output and provider schema fixtures are synthetic test evidence;
  they are not represented as captured production output.

## Evidence

[Validation record](../../evidence/milestone121-validation.md) distinguishes
observed CLI behaviour, documentation and test fixtures. There is no UI change.

Docs sweep — grep: "claude_max_turns", "agent-incident runbook"; updated
SECURITY.md and docs/CONFIGURATION.md; section: Operational Defaults and
Agent-incident runbook; siblings: "claude_timeout" was checked in operational
limits and existing timeout guidance. Unchanged timeout references remain about
wall-clock limits, which this change does not replace.

## Test Plan

- Argument builders, config defaults/validation and structured output adapter.
- Real stub child processes verify one invocation, distinct cause, cap logging
  and direct callers without the retry wrapper.
- Standalone `mod.ts` child-process integration and actual shell evaluation
  verify configured/default caps override stale internal transport.
- Issue phase, initial/quality-retry CI and initial/placeholder/drift/verifier/
  correction/second-verifier/push-recovery/retry-push feedback regressions verify
  no capped partial work reaches publication.
- Planning draft, publish, retry and self-repair regressions plus quality-loop
  retries verify the typed terminal error stops further automated work.
- Each listed mutation was applied independently and its named test failed,
  then production source was restored. Complete-gate status is reported by the
  immutable-head validation check; no full local pass is claimed.

<!-- vibe-branch-outcomes -->

## Acceptance Criteria

| Criterion | Evidence and status |
| --- | --- |
| Built args contain the CLI turn-limit flag; args-builder unit test | Implemented; agent_containment_limits_3701_test.ts and agent_provider_test.ts |
| Reaching the cap ends the run with a distinct logged reason | Implemented and exercised using structured result fixtures and real stub processes, including direct runner and production workflow callers |
| Confirm flag with CLI help first | Help inspected; flag omitted there. Parser accepted it in a credential-free probe; official documentation confirms spelling. Live authenticated exhaustion remains unobserved |
