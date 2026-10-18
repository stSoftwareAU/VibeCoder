## Summary

Closes #3643.

Add opt-in independent manager, executor and reviewer selection to both issue
execution paths. Host settings and repository overrides select provider, model,
effort and a registered CLI adapter. Preserve native Claude dispatch by default;
a repository or host boolean restores it without changing deployment code.

The prerequisite orchestration implementation is included because #3642 was
cancelled without merging its code. Codex role calls use enforced CLI sandboxes;
subscription, CLI and observed quota failures stop external dispatch.

## Spec

### Intent and Rationale

- Let hosts use different subscription providers while retaining existing issue
  discovery, quality gates and merge policy.

### Essential Design Decisions

- Repository fields override individual host fields; changing provider clears
  inherited model, effort and adapter values from the previous provider.
- Keep sequential dispatch, isolated role contexts, durable checkpoints and
  explicit lifecycle role attribution. Named providers must be provisioned.
- Keep the existing native defaults and post-PR reviewer. External dispatch is
  off unless explicitly enabled; no subscriptions or metered access are bought.

### Undiscoverable Facts

- The owner clarified that the incumbent is Sonnet/high manager with Haiku
  sub-agents and an Opus post-PR reviewer.
- #3642 was closed as not planned; its branch supplied the orchestration
  foundation, with production main-loop wiring and subscription safeguards
  completed here for the currently requested configuration work.

## Evidence

- Focused configuration, handoff, checkpoint, standalone execution, main-loop
  assignment and native-Claude regression suites pass with type checking.
- The main-loop integration test observes the selected executor and reviewer,
  recorded treatment, and repository rollback to native dispatch.
- The full local gate passed completeness, type checking, lint and formatting.
  Its parallel test pass had 29,241 passes and three host-related failures:
  two process-tree cleanup assertions and PowerShell startup under the
  sanitised test environment. The process-tree failures also reproduce on the
  base; a cache-directory wrapper resolves PowerShell startup. A separate
  serial pass was stopped after an existing signal fixture stalled.
  All required CI and additional integration checks passed on PR #4007.
  Local markdownlint and semgrep are unavailable; CI passed both. No live subscription-model turn
  was purchased or used to claim host entitlement.
- #3643: Configure manager, executor and reviewer independently per host and repository.
- #3642: Implement external provider-neutral orchestration behind an opt-in feature flag.
- Docs sweep — grep: "issue_executor_split", "external_orchestration", "provider-neutral"; updated `docs/CONFIGURATION.md`, `docs/MANAGER-WORKER-CONTRACT.md`, `docs/ROLE-CONFIGURATION.md`; section: CONFIGURATION issue-executor settings and MANAGER-WORKER-CONTRACT target contract; siblings: "issue_sub_agent_tier", "issue_reviewer_agents", "agent_providers" retain their native behaviour.

## Test Plan

- `worker/deno/tests/role_configuration_3643_test.ts` exercises configuration
  precedence, provider changes, invalid settings, adapter flags, all four
  Claude/Codex pairings, independent review, context isolation, subscription
  refusal, setup preservation, main-loop treatment recording and rollback.
- Recovered orchestration suites exercise checkpoints, interruption, retries,
  authentication/quota refusal, limits and standalone production dispatch.
- Existing native executor and lifecycle-assignment suites pass unchanged.
- No assertion was removed from an existing test.

## Branch outcomes

- Host defaults, repository field overrides, invalid settings and rollback — `worker/deno/tests/role_configuration_3643_test.ts`.
- Same-provider and mixed-provider dispatch, independent reviewer and context separation — `worker/deno/tests/role_configuration_3643_test.ts`.
- Native dispatch when external orchestration is off and refused missing external wiring when on — `worker/deno/tests/external_orchestration_3642_phase_test.ts`.
- Missing CLI or unproved subscription refuses before paid work — `worker/deno/tests/role_configuration_3643_test.ts`.
- Checkpoint absent, malformed, old-schema, resumed and completed states — `worker/deno/tests/orchestration_3642_contracts_test.ts`, `worker/deno/tests/orchestration_3642_orchestrator_test.ts`.
- Authentication, exhausted quota, unsupported tools, cancellation, timeouts and bounded retries — `worker/deno/tests/orchestration_3642_orchestrator_test.ts`, `worker/deno/tests/orchestration_3642_gate_test.ts`.

## Merge verification

PR #4007 merged into the milestone branch with all CI checks successful.
Live subscription entitlements and
sandbox support require each operator-selected host; unavailable combinations
fail closed.
