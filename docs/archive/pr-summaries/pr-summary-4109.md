# PR Summary — Issue #4109

## Summary

Runs were releasing with no PR because an `issue` run on a provider that cannot
carry `--agents` (Codex, Gemini, DeepSeek) with the executor split or reviewer
sub-agents on was refused before spawn by the Issue #4010 guard in
`runClaudeWithTimeoutBody`. The worker now settles the provider before spawn
through a new planner, `planIssueRunProvider`
(`worker/deno/lib/issue_run_provider_agents.ts`):

- the provider's own argv decides whether it carries sub-agents
  (`probeDescriptorInvocationCapabilities`), so no provider-id table;
- **rerouted-to-claude** — Claude is enabled and installed: the run, its
  CodeGraph / RTK / graft sinks and the recorded assignment all use Claude;
- **agents-stripped** — Claude is not usable: the run starts on its own provider
  with the split, reviewers and tier switches off, and a warning says so;
- **unchanged** — no sub-agents wanted, or the provider carries them.

Both issue-run call sites use it (`lib/phases/execute_phase.ts`,
`lib/execute_claude_phase.ts`); external orchestration is never planned. The #4010
refusal stays as a backstop for callers that bypass the planner. Docs that said
such a run "is refused before spawn" now say it is rerouted or stripped.

## Reproduction

- **symptom** — an `issue` run on `codex` (also `gemini`, `deepseek`) with sub-agents on is refused before spawn with "Refused to start the agent: Codex CLI cannot carry the issue run's sub-agent definitions (--agents)…" and releases its claim with no PR
- **status** — `verified` — `issue_4109_callsite_test.ts` was run against the branch with `lib/phases/execute_phase.ts` and `lib/execute_claude_phase.ts` restored to the merge-base: 7 of 9 tests failed (reroute, assignment, strip and all four execute_claude_phase sink tests); on the branch all 9 pass
- **regression test** — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - a run asked for sub-agents on codex is rerouted to claude at the runner (Issue #4109)`

## Test Plan

No assertion was removed from any existing test. The diff to existing test files
is additive (`worker/deno/tests/agent_provider_test.ts` gains one test) plus one
comment re-worded in `worker/deno/tests/manager_worker_contract_3641_test.ts`
(it now says the planner reroutes or strips, with the #4010 refusal a backstop).
`worker/deno/tests/issue_4109_callsite_test.ts` and
`worker/deno/tests/issue_run_provider_agents_test.ts` are new files.

## Docs sweep

**Docs sweep** — grep: `refused before spawn`, `refuses loudly before spawn`, `Issue #4010`, `planIssueRunProvider`, `plannedActiveAgentProvider`; section: `docs/MANAGER-WORKER-CONTRACT.md` (provider table, "Two paths now", rollback), `docs/MODEL-AND-CACHING.md` (advisor/executor split, reviewer sub-agents, Haiku tier, pilot counters), `docs/PROVIDER-FEASIBILITY.md` (`--agents` carried row, fail-loud refusal), `docs/CONFIGURATION.md` (`agent_provider`, `issue_executor_split`, `issue_sub_agent_tier`, `issue_reviewer_agents`); siblings: the Codex, Gemini and DeepSeek rows of each provider table (all three updated together) and the three sub-agent feature rows (split, reviewers, tier); updated: `docs/MANAGER-WORKER-CONTRACT.md`, `docs/MODEL-AND-CACHING.md`, `docs/PROVIDER-FEASIBILITY.md`, `docs/CONFIGURATION.md`; remaining `#4010` hits re-read and kept (they describe the runner refusal as the backstop)

## Branch outcomes

**Branch outcomes:**
- `worker/deno/lib/issue_run_provider_agents.ts:88` — absent (no sub-agents wanted) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - a run asking for no sub-agent switches is left unchanged (Issue #4109)` — flipped guard off, test went red
- `worker/deno/lib/issue_run_provider_agents.ts:91` — success (provider carries `--agents`) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - a provider whose argv carries --agents is left unchanged even without Claude (Issue #4109)` — forced to not-carrying, test went red
- `worker/deno/lib/issue_run_provider_agents.ts:98` — reroute (Claude usable) and strip (Claude not usable) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - a non-Claude provider with Claude enabled is rerouted to Claude (Issue #4109)` and `…::issue run provider - a non-Claude provider with Claude not enabled has its sub-agents stripped (Issue #4109)` — inverted condition, 8 tests went red
- `worker/deno/lib/issue_run_provider_agents.ts:65` — fail-closed (image stamp lacks Claude) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - Claude enabled but the image stamp lacks Claude strips the run (Issue #4109)` — removed the stamp check, test went red
- `worker/deno/lib/issue_run_provider_agents.ts:68` — error/absent (Claude not in the enabled set) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - Claude not enabled strips sub-agents with no image stamp (Issue #4109)` — forced to true, test went red
- `worker/deno/lib/provider_feasibility.ts:226` — success (quiet probe prints nothing) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - planning probes the argv without printing the provider's own warning (Issue #4109)` — ignored `quiet`, test went red
- `worker/deno/lib/provider_feasibility.ts:246` — success (console.warn restored) — `worker/deno/tests/issue_run_provider_agents_test.ts::issue run provider - planning probes the argv without printing the provider's own warning (Issue #4109)` — removed the restore, test went red
- `worker/deno/lib/agent_provider.ts:1543` — success (uninstalled provider is not thrown at during planning) — `worker/deno/tests/agent_provider_test.ts::agent provider - pre-spawn planning reads an uninstalled provider without the install assert (Issue #4109)` — swapped to the asserting resolver, test went red
- `worker/deno/lib/phases/execute_phase.ts:823` — absent (external orchestration is not planned) — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - an external-orchestration run is not planned, so nothing is rerouted (Issue #4109)` — always planned, test went red
- `worker/deno/lib/phases/execute_phase.ts:828` — success (non-external allocation plans Claude) — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - a non-external allocation plans the claude provider (Issue #4109)` — planned the active provider instead, test went red
- `worker/deno/lib/phases/execute_phase.ts:1229` — reroute reaches the runner — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - a run asked for sub-agents on codex is rerouted to claude at the runner (Issue #4109)` — dropped the override, test went red
- `worker/deno/lib/phases/execute_phase.ts:564` and `:1297` — reroute reaches the recorded assignment — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - the rerouted provider is recorded on the run assignment (Issue #4109)` — dropped the planned provider, test went red
- `worker/deno/lib/phases/execute_phase.ts:838` — strip reaches the runner (no `agents`) — `worker/deno/tests/issue_4109_callsite_test.ts::execute_phase - with claude not enabled the run starts on codex without sub-agents (Issue #4109)` — built agents from the requested switches, test went red
- `worker/deno/lib/execute_claude_phase.ts:1272` — absent (external orchestration is not planned) — `worker/deno/tests/external_orchestration_3642_phase_test.ts::external orchestration - the switch on builds no --agents even with the split and reviewers on (Issue #3642)` — always planned, test went red
- `worker/deno/lib/execute_claude_phase.ts:1294` — reroute reaches the CodeGraph, RTK, graft sinks and the runner — `worker/deno/tests/issue_4109_callsite_test.ts::execute_claude_phase - the rtk sink receives the rerouted provider (Issue #4109)`, `…::the codegraph sink…`, `…::the graft sink…`, `…::the runner receives the rerouted provider (Issue #4109)` — fell back to the invocation provider, all four went red
