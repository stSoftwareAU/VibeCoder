# PR Summary — Issue #4346

## Summary

The main-loop issue run (`executeClaudeBody` in
`worker/deno/lib/phases/execute_phase.ts`) resolves
`resolveInvocationAgentProvider(undefined, config.repoConfig?.[repo])` once
and passes that selection to the agent runner, the CodeGraph, Graft and RTK
sinks, the auth classifier and the run assignment. A non-external subscription
allocation names Claude for the invocation and wins. A repository pin is the
invocation's provider: when that pin cannot carry `--agents`,
`planIssueRunProvider` keeps it and takes the existing agents-stripped shape
(no executor split, no reviewer agents, the sonnet tier, no `--agents`), even
when Claude is installed and enabled. The #4109 reroute is a later
substitution for an unpinned provider. It does not replace a pin. With no pin
and no allocation, the runner is handed no `agentProvider` and keeps the
host's active provider.

The standalone command path (`worker/deno/lib/execute_claude_phase.ts`) used
the same planner and still rerouted a pin when the host's split, reviewers
and haiku tier were on. It now passes the same pin flag, so a pin-only
invocation is stripped and kept there too. An explicit `options.agentProvider`
is still the invocation's named provider and can still be rerouted.

Closes #4346.

## Spec

### Intent and Rationale

- On the fleet path the pin was read only to decide external orchestration, so
  `runClaudeWithRetry` spawned the host's active provider.
- Passing the pin through was not enough. The host defaults
  (`issue_executor_split`, `issue_reviewer_agents`, and the `haiku` sub-agent
  tier) ask for `--agents`, and `planIssueRunProvider` then returned
  `rerouted-to-claude` for a `deepseek` or `codex` pin whenever Claude was
  usable.
- The pin is what `resolveInvocationAgentProvider` returns when the invocation
  names no provider of its own. The reroute is a later substitution, so it
  must not become `explicitInvocationProvider`.

### Essential Design Decisions

- `planIssueRunProvider` takes `pinned`. When that flag is set and the
  provider cannot carry `--agents`, the plan is the existing
  `agents-stripped` shape and the provider stays the pin. An unpinned
  provider is still rerouted when Claude is usable and the health gate has
  not moved the run.
- The main loop sets `pinned` only when there is no allocation and the
  resolver returned a provider. A non-external allocation still plans and
  spawns Claude. The standalone path sets `pinned` only when
  `options.agentProvider` is unset and the resolver returned a provider.
- `buildIssueRunAgents` on that stripped shape returns undefined, so the
  runner is not given `agents` or `issueExecutorSplit`. The #4010 guard
  therefore has nothing to refuse.
- Both copies call the existing resolver and the existing planner. They are
  named in the test plan.

### Undiscoverable Facts

- Stripping a pin uses the same switches as a strip when Claude cannot take
  the run: executor split off, reviewer agents off, sub-agent tier `sonnet`.
  The haiku tier would still build an explorer, so the tier has to move.
- `claudeOptionsFor` in `worker/deno/lib/orchestration/issue_run_gate.ts`
  copies the shared options and then sets `agentProvider` from the role
  envelope, so an externally orchestrated run still spawns each role's
  provider. External orchestration skips the planner.
- With the effective id omitted, `createDefaultDeps` classifies auth with the
  active provider (`agentProviderById` falling back to `activeAgentProvider`).
- The command entry point
  `worker/deno/commands/execute_claude_phase.ts` passes the host's split,
  reviewers and tier into `runExecuteClaudePhase`. The pin decision lives in
  the library function, which is the copy changed here.

## Evidence

Backend change. No UI.

Tests, from `worker/deno`, with
`deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname`:
`tests/execute_phase_agent_provider_pin_4346_test.ts`,
`tests/issue_run_provider_agents_test.ts`,
`tests/issue_4109_callsite_test.ts` and
`tests/execute_claude_phase_test.ts`. Result: `ok | 96 passed | 0 failed`.

The default-config case is
`execute_phase - a default host pinned to deepseek keeps the pin and strips sub-agents`.
It builds `buildDefaultWorkerConfig()` with `repo_config` `agent_provider:
deepseek` and requires the runner, `rtkProviderId` and the assignment to
receive `deepseek`, with `agents` and `issueExecutorSplit` absent. The
non-external allocation case still requires `claude` on those three. The
planner case
`issue run provider - a pinned non-Claude provider is stripped even when Claude is usable`
requires `agents-stripped` for `deepseek`, `codex` and `gemini` while Claude
is enabled. The standalone case
`runExecuteClaudePhase - a pin with sub-agents on is kept and stripped, not rerouted`
turns the split, the reviewers and the haiku tier on and requires the runner's
`agentProvider` to be `deepseek` with `agents` and `issueExecutorSplit` absent.

Docs: read `docs/CONFIGURATION.md`, the per-repository `agent_provider` row
under "Per-repository model/effort routing", and the global `agent_provider`
row. The per-repo row still says the pin binds when an invocation carries no
explicit provider of its own and wins over the global key and over `auto`
ranking. That sentence stays. The global row, and the same claim on
`issue_executor_split`, `issue_sub_agent_tier` and `issue_reviewer_agents`,
said an issue run on `codex`, `gemini` or `deepseek` is rerouted to Claude
whenever Claude is enabled. That became false for a repository pin, so each
of those sentences now says a repository pin is stripped and kept. The same
sentence in `docs/MODEL-AND-CACHING.md` (the provider matrix and the split,
reviewer and haiku sections) was updated the same way.
`docs/PROVIDER-FEASIBILITY.md` says an issue run carrying `--agents` on a
non-Claude provider is rerouted to Claude or stripped; both outcomes still
exist, so that sentence stays.

## Test Plan

- [x] `buildDefaultWorkerConfig()` pinned to `deepseek` on a Claude host:
  runner, RTK selector and assignment receive `deepseek`, and the runner is
  given neither `agents` nor `issueExecutorSplit`
- [x] The same pin with the executor split, reviewer agents and the haiku
  explorer off still reaches those three with `deepseek`
- [x] A non-external allocation still names `claude` on the runner, the RTK
  sink and the assignment when the repo is pinned to `deepseek`
- [x] No pin: `agentProvider` and the RTK selector stay unset, and the
  assignment records the host provider (`claude`)
- [x] `planIssueRunProvider({ pinned: true })` for `deepseek`, `codex` and
  `gemini`, with Claude enabled and sub-agents on, returns `agents-stripped`
  and keeps the pin
- [x] Unpinned #4109 call sites still reroute to `claude`
  (`tests/issue_4109_callsite_test.ts`)

Both copies pass `pinned` into `planIssueRunProvider`:

- `worker/deno/lib/phases/execute_phase.ts` — the resolver is called with
  `undefined`. `pinned` is set when there is no allocation and the resolver
  returned a provider. `effectiveAgentProvider` is Claude for a non-external
  allocation, the reroute id when the plan rerouted, or the resolver result.
- `worker/deno/lib/execute_claude_phase.ts` — the resolver is called with
  `options.agentProvider`. `pinned` is set when that argument is unset and
  the resolver returned a provider. `effectiveAgentProvider` is the reroute
  id or the resolver result, so a stripped pin stays the pin.

No third production copy of the planner was found. The command module only
forwards the host switches into `runExecuteClaudePhase`.
