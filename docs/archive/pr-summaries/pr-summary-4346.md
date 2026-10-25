# PR Summary — Issue #4346

## Summary

The main-loop issue run (`executeClaudeBody` in
`worker/deno/lib/phases/execute_phase.ts`) now resolves
`resolveInvocationAgentProvider(undefined, config.repoConfig?.[repo])` once
and passes that selection to the agent runner, the CodeGraph, Graft and RTK
sinks, the auth classifier and the run assignment, which is what the
standalone command path already did. A non-external subscription allocation
names Claude for the invocation, and a plan outcome of `rerouted-to-claude`
names that plan's provider; either of those is the provider the run spawns.
With neither, the repository pin is the provider. With no pin either, the
runner is handed no `agentProvider` and keeps the host's active provider.

Closes #4346.

## Spec

### Intent and Rationale

- On the fleet path the pin was read only to decide external orchestration, so
  `runClaudeWithRetry` spawned the host's active provider.
- `worker/deno/lib/execute_claude_phase.ts` already passed the same resolver's
  result through to the runner and the sinks.
- A repository pinned to `deepseek` or `codex` on a Claude host therefore
  resumed against the host provider and recorded that provider on the
  assignment.

### Essential Design Decisions

- One call to `resolveInvocationAgentProvider`. The planner receives Claude
  when `allocation` is set (that branch runs only for a non-external
  allocation), and otherwise the resolver's result, falling back to
  `plannedActiveAgentProvider()` when the resolver returns undefined.
- `effectiveAgentProvider` is `"claude"` when `allocation && !allocation.external`,
  the plan's provider id when `issueRunPlan?.outcome === "rerouted-to-claude"`,
  and otherwise the resolver result. That value is passed to
  `runClaudeWithRetry`, `prepareCodegraphRun`, `bindGraftRun`,
  `rtkProviderId` and `isClaudeAuthError`. It is omitted when undefined.
- `recordRunAssignment` receives `issueRunPlan?.provider`. External
  orchestration leaves the plan undefined, and the assignment then records
  the orchestration roles.
- The explicit-wins composition stays in two files, both calling the existing
  resolver. They are named in the test plan.

### Undiscoverable Facts

- The host defaults (`issue_executor_split`, `issue_reviewer_agents`, and the
  `haiku` sub-agent tier) ask for `--agents`. A `deepseek` or `codex` pin is
  then rerouted to Claude when Claude is enabled and installed and the health
  gate has not moved the run; the pin is what the runner receives when the
  plan outcome is `unchanged` or `agents-stripped`.
- `claudeOptionsFor` in `worker/deno/lib/orchestration/issue_run_gate.ts`
  copies the shared options and then sets `agentProvider` from the role
  envelope, so an externally orchestrated run still spawns each role's
  provider.
- With the effective id omitted, `createDefaultDeps` classifies auth with the
  active provider (`agentProviderById` falling back to `activeAgentProvider`).
- Production calls of `resolveInvocationAgentProvider` are the two files
  named below. The definition and its unit tests are the only other hits.

## Evidence

Backend change. No UI.

Tests: `worker/deno/tests/execute_phase_agent_provider_pin_4346_test.ts`.
Before the fix that file was `FAILED | 1 passed | 3 failed`. The pinned run's
runner `agentProvider` was `undefined` where the test requires `deepseek`.
The allocation run already handed the runner `claude` and failed on the RTK
selector, which was `undefined`. The reroute run's runner `agentProvider`
was `undefined` where the test requires `claude`. After the fix, that file
together with `tests/issue_4109_callsite_test.ts`,
`tests/execute_phase_assignment_3718_test.ts`,
`tests/subscription_allocation_phase_3646_test.ts` and
`tests/execute_phase_routing_test.ts` was `ok | 34 passed | 0 failed`.

Docs: read `docs/CONFIGURATION.md`, the per-repository `agent_provider` row
under "Per-repository model/effort routing", and the global `agent_provider`
row. Both say the pin binds when an invocation carries no explicit provider
of its own and wins over the global key and over `auto` ranking for that
repo. The code now does that on the main-loop path, so those sentences stay.
No documentation edit.

## Test Plan

- [x] Pinned-repo issue run, with the executor split, reviewer agents and the
  Haiku explorer off, reaches `runClaudeWithRetry`, `rtkProviderId` and the
  assignment with `deepseek`
- [x] A non-external allocation still names `claude` on the runner, the RTK
  sink and the assignment when the repo is pinned to `deepseek`
- [x] A plan outcome of `rerouted-to-claude` still names `claude` on those
  three when the repo is pinned to `deepseek` and sub-agents are on
- [x] No pin: `agentProvider` and the RTK selector stay unset, and the
  assignment records the host provider (`claude`)

Twin copies of the explicit-wins rule, both calling
`resolveInvocationAgentProvider`:

- `worker/deno/lib/execute_claude_phase.ts` — the explicit argument is
  `options.agentProvider`; `effectiveAgentProvider` is the reroute id or that
  result.
- `worker/deno/lib/phases/execute_phase.ts` — the explicit argument is
  `undefined`; `effectiveAgentProvider` is Claude for a non-external
  allocation, the reroute id, or that result.

No third production copy was found.
