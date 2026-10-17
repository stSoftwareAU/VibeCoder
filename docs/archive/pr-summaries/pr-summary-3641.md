# PR Summary — Issue #3641

Closes #3641

## Summary

Documents the current manager-worker path and a provider-neutral target contract in `docs/MANAGER-WORKER-CONTRACT.md`, and adds a contract test that pins what the worker hands the Claude CLI today. No runtime behaviour or default changes. The branch also carries two WIP checkpoint commits (`80b7d4fb`, `c2b926dd`): their code hunks are comment-only, and their other hunks are cross-links to the new contract doc.

## Spec

### Intent and Rationale

The issue asks for an audit of the current advisor/executor path and a target manager-worker contract before any provider-neutral refactor. The aim is that a refactor cannot change the Claude `--agents` path, the default behaviour or unattended self-healing without a test failing.

### Essential Design Decisions

- Documentation first, no behaviour change. The target contract (sections 4, 5 and 6 of the doc) is marked as target and is not implemented here.
- The current path is pinned by tests that call the real functions (`worker/deno/tests/manager_worker_contract_3641_test.ts`), not by greps of source text.
- The known gap is recorded, not fixed: Codex, Gemini and DeepSeek do not carry `agents` or `settingsJson`, and the fail-loud invariant is a follow-up.
- Astra and Sol availability is a per-host prerequisite (CLI installed, account entitled), checked before use and never assumed (doc section 2).

### Undiscoverable Facts

- The advisor/executor block is not gated on provider. `isIssueExecutorSplitEnabled` takes the phase, repo and host config only (`worker/deno/lib/issue_executor_split.ts:42-59`). Its only provider gate is the Claude `PreToolUse` hook (`worker/deno/lib/claude_runner.ts:1211`). So the split prompt block renders on Codex, Gemini and DeepSeek, while those providers drop `agents` (Codex, Gemini) or `settingsJson` (DeepSeek) without an error (`worker/deno/lib/agent_provider.ts:1120-1132` for DeepSeek).
- Setting `issue_executor_split: false` and `issue_reviewer_agents: false` does not remove `--agents`. The explorer definition is still added on the default `haiku` tier (`worker/deno/lib/issue_executor_agents.ts:420-434`). A full rollback also needs `issue_sub_agent_tier: "sonnet"`.
- Session resume is filtered by provider (`worker/deno/lib/session_resume.ts:233-247`): a record tagged with another `providerId` is dropped. Legacy records with no `providerId` are accepted only for claude and deepseek.

## Evidence

Rollout order from the contract (section 9):

```mermaid
flowchart TD
  S1["1. Freeze current path with tests"] --> S2["2. Add types, no behaviour change"]
  S2 --> S3["3. Explicit provider capability record"]
  S3 --> S4["4. Fail loud for unsupported providers"]
  S4 --> S5["5. Structured result parser, Claude first"]
  S5 --> S6["6. Provider-neutral edit guard"]
  S6 --> S7["7. Non-Claude host behind a flag"]
```

Step 1 is this PR. Steps 2 to 7 are not started.

**Docs sweep** — section: `docs/MANAGER-WORKER-CONTRACT.md` (section 3 audit, section 7 compatibility matrix, section 8 rollout); siblings: `issueExecutorSplit`, `issueReviewerAgents`, `issueSubAgentTier` (the three existing switches the contract documents; no new switch is added). Hits under `docs/archive/pr-summaries/*` and `docs/audits/*` are historical and are left unchanged. `docs/MODEL-AND-CACHING.md:600` and `:838` also describe these switches; this PR does not edit them, and they are a follow-up.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Audit current provider adapters, prompts, tools, hooks, session persistence, review gates and per-host configuration. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 3 (adapters, tools, hooks, prompt templates), section 5 (session persistence), section 6 (credentials), section 8 (per-host flags) — reviewer: met (after follow-up: prompt-template audit, session persistence and per-host config added)
- **met** — Specify role contracts (manager, executor, reviewer), the task envelope and structured result, with retries, cancellation, timeouts, leases and recovery. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 4, "Role contracts" and "Task envelope and structured result" — reviewer: met
- **partial** — Define permissions: manager read-only, executor scoped workspace, no recursive delegation, no credential leakage between providers. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 6 (manager read-only; credentials scrubbed per provider) — reason: section 6 does not state the no-recursive-delegation rule as a target; the current sub-agent denial is pinned only by `manager_worker_contract_3641_test.ts` — reviewer: partial
- **partial** — Define feature-flagged rollout, compatibility matrix and rollback; no unsupported provider silently gets Claude `--agents`. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` sections 7 and 8 — reason: the matrix and rollback are documented, but Codex, Gemini and DeepSeek drop `agents` or `settingsJson` silently, and the fail-loud invariant is a target, not implemented (section 8) — reviewer: partial
- **met** — Explicitly distinguish vendor, provider CLI, model and subscription entitlement; Astra and Sol availability is a prerequisite to validate, not an assumption. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 2, "Host-validated prerequisite" — reviewer: met
- **met** — Document existing vs target behaviour and incremental implementation order. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 3 (existing), sections 4 and 5 (target), section 9 (order) — reviewer: met
- **met** — Contract fixtures and compatibility tests protect the current Claude path. — evidence: `worker/deno/tests/manager_worker_contract_3641_test.ts` (10 tests, all passing) — reviewer: met
- **met** — No default routing changes; no disruption to running hosts. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` section 8, "No default change"; the code hunks are comment-only — reviewer: met
- **unrequested** — README docs-table row and see-also lines in `docs/MODEL-AND-CACHING.md` and `docs/PROVIDER-PARITY.md`. — reviewer: unrequested — reason: justified; these link the new contract doc from the README index and the two manuals it relates to
- **unrequested** — Comment-only stale-wording fixes in `worker/deno/lib/agent_provider.ts`, `worker/deno/lib/claude_runner.ts`, `worker/deno/lib/config_defaults.ts`, `worker/deno/lib/issue_sub_agent_tier.ts`, `worker/deno/lib/execute_claude_phase.ts`, `worker/deno/lib/phases/execute_phase.ts` and `worker/deno/commands/execute_claude_phase.ts`, carried by commits `80b7d4fb` and `c2b926dd`. — reviewer: unrequested — reason: justified; the comments described the split as opt-in, but it has been on by default since Issue #2812, and no code path changes

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Verdict: approve. Australian English in the new doc and test; the code hunks are comments only, so no added branch; no workflow change; the test calls real functions and reads no source text; no new dependency files in the diff. Part A corrected the contract doc's stale line citations to the current code before this PR.

## Test Plan

- `worker/deno/tests/manager_worker_contract_3641_test.ts`: 10 `Deno.test` cases, all named `#3641 contract — ...`. They call the real `resolveAgentProvider`, `buildIssueRunAgents` and `OPERATIONAL_DEFAULTS`, and cover the Claude `--agents` and `--settings` argv, the DeepSeek strip with one warning, the silent Codex and Gemini drop (the known gap), the provider registry and the issue-phase defaults. Run with `deno test --allow-all tests/manager_worker_contract_3641_test.ts`: 10 passed, 0 failed.
- Not red-checked in this run: no break was applied to the guarded code, so the tests have not been shown to go red against a regression.
- `markdownlint-cli2` on `docs/MANAGER-WORKER-CONTRACT.md`: 0 issues.
- <!-- vibe-branch-outcomes -->

## Follow-ups (out of scope)

1. Fail loud when the split is on for a provider that cannot carry the field: Codex and Gemini (`agents`) and DeepSeek (`settingsJson`). This is the section 8 invariant.
2. Remove the duplicate `--settings` emit in `buildClaudeCliArgs` (`worker/deno/lib/agent_provider.ts:622-623` and `:638-639`).
3. Remove the `?? "sonnet"` fallback at `worker/deno/lib/execute_claude_phase.ts:1287`.
4. Gate the advisor block on provider capability. `isIssueExecutorSplitEnabled` takes no provider argument, so the block renders on Codex, Gemini and DeepSeek.
5. Review `docs/MODEL-AND-CACHING.md:600` and `:838`.

**Pre-PR security self-check.** The change touches documentation, comments and one test file; the code hunks are comment-only. No secrets are added and no new dependencies are introduced (the diff has no `deno.json`, `deno.lock` or package changes).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
