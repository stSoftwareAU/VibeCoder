# PR Summary — Issue #3933

Closes #3933

## Summary

Completes the two partial acceptance criteria left by #3641 in `docs/MANAGER-WORKER-CONTRACT.md`, against the merged code. Documentation only — no runtime behaviour or default changes. The two outstanding gaps were checked against the head first, as the issue asked: the fail-loud invariant that #3641 recorded as "target, not implemented" is now implemented on the opt-in external orchestration path (#3642/#3643/#3646), so section 8 is corrected from "Invariant (target)" to "Invariant (delivered)", and the review gates that #3641 recorded as "not audited" now get their own subsection. The native `issue_executor_split` path's silent drop remains a known, test-pinned gap and is recorded as such rather than hidden.

## Spec

### Intent and Rationale

#3641 audited the advisor/executor path and drafted the provider-neutral contract, but left two criteria partial: the review gates were covered only as the reviewer sub-agents and the `issue_reviewer_agents` flag (the PR-level review lease was not audited), and the fail-loud invariant was documented as a target rather than delivered. Since then #3642/#3643/#3646 shipped external orchestration, which implemented that invariant. This PR brings the contract doc in line with the merged code without re-auditing the areas #3641 already finished.

### Essential Design Decisions

- Documentation only. No code, test or config change; no new defaults.
- The two paths are now separated explicitly. The native `--agents` split runs only when `external_orchestration` is off; the external path never sets `--agents` and refuses an unsupported provider fail-closed before paid work.
- The remaining native-path silent drop is recorded, not fixed. `manager_worker_contract_3641_test.ts` still pins it, and the doc says closing it is a separate behaviour change (already #3641's follow-up item 1).
- Every new line citation was re-read against the head (`config_defaults.ts`, `config.ts`, `issue_executor_agents.ts`, `pr_review_claim_lease.ts`, `pr_feedback_processor.ts`, `orchestration/{capabilities,preflight,issue_run_gate}.ts`, `execute_claude_phase.ts`, `phases/execute_phase.ts`); the stale #3641 citations in the replaced paragraph (`config_defaults.ts:1222-1239`, `:968`, `:1094-1096`, `config.ts:596`, `pr_feedback_processor.ts:764`) were corrected, not carried over.

### Undiscoverable Facts

- The native split is gated on `!externalOrchestration` at both phase call sites (`execute_claude_phase.ts:1338`, `phases/execute_phase.ts:796`); `claudeOptionsFor` sets `agents: undefined` (`issue_run_gate.ts:112`) and never falls back to `--agents` or a metered API.
- `assertRoleSupported` (`capabilities.ts:130`) special-cases Codex: bounded fresh calls use read-only/workspace-write sandboxes with `features.multi_agent=false`, and a requested tool outside the bounded set is refused. Gemini drops denials so cannot carry a tool-denying role; DeepSeek is refused by the preflight (`preflight.ts:11`) for having no proved fixed-price subscription, not by the capability probe.
- `PR_REVIEW_CLAIM_LEASE_MS` (`pr_review_claim_lease.ts:29`) is the fleet heartbeat live window, and `PR_REVIEW_CLAIM_RENEW_MS` (`:33`) is five minutes; the lease's liveness reads the comment `updated_at` that the renewer bumps.
- `PHASE_MODEL_DEFAULTS` has no `pr_review` key (`config_defaults.ts:1236`); post-PR review uses the host `claude_model` defaulting to `DEFAULT_CLAUDE_MODEL = "opus"` (`:982`), and the comment above `DEFAULT_CLAUDE_MODEL_ISSUE` (`:1110-1113`) records that Opus review keeps merged quality high.

## Evidence

**Docs sweep** — grep: `external_orchestration`, `issue_executor_split`, `issue_reviewer_agents`, `pr_review`, `fail-loud`, `fail closed`, `silently`, `Invariant (target)`; section: `docs/MANAGER-WORKER-CONTRACT.md` (sections 3, 7, 8), `docs/ROLE-CONFIGURATION.md`, `docs/CONFIGURATION.md`; siblings: `external_orchestration_settings`, `issue_sub_agent_tier` (the switch set section 8 now names; no new switch is added). Updated: `docs/MANAGER-WORKER-CONTRACT.md` only. Hits read and left unchanged because they hold at the head: `docs/CONFIGURATION.md:491-496` (the native-key rows and the `external_orchestration`/`external_orchestration_settings` rows the doc points at), `docs/ROLE-CONFIGURATION.md:70-78`, `:92-95` (the fail-closed and rollback wording this PR quotes). No non-archive doc claims the invariant is unimplemented, so no other surface needed a change. Hits under `docs/archive/**` are historical.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Audit current provider adapters, prompts, tools, hooks, session persistence, review gates and per-host configuration. — evidence: the review-gates gap from #3641 is closed by the new "### Review gates" subsection in `docs/MANAGER-WORKER-CONTRACT.md` section 3, which audits the reviewer sub-agents (`issue_executor_agents.ts:296`, `:208`, `:214`), the issue-reviewer switch (`config.ts:1013-1014`), the PR review claim lease (`pr_review_claim_lease.ts:29`, `:33`, `:70`, `:102`), the post-PR reviewer model (`pr_feedback_processor.ts:803`, `config_defaults.ts:982`) and the external review gate (`issue_run_gate.ts:178`, `capabilities.ts:130`, `preflight.ts:11`). The adapters, prompts, tools, hooks, session persistence and per-host configuration were already audited by #3641 and are left as delivered. — reviewer: met
- **met** — Define feature-flagged rollout, compatibility matrix and rollback; no unsupported provider silently gets Claude `--agents`. — evidence: `docs/MANAGER-WORKER-CONTRACT.md` sections 7 and 8. Section 7 adds the two-path note (`execute_claude_phase.ts:1338`, `phases/execute_phase.ts:796`, `issue_run_gate.ts:112`, `capabilities.ts:130`, `preflight.ts:11`); section 8 renames the invariant to "delivered" for the external path, adds the `external_orchestration` flag, records the native path's remaining silent drop as a separate behaviour change, and documents rollback for both paths. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Verdict: approve. Documentation-only diff; no code, test, config or workflow change, so no added branch, no changed call site, no new persisted shape. Australian English throughout (behaviour, recognised, colour-free prose). No secrets or hidden files staged. Deno repo respected — no Node tooling touched. The new table is three columns throughout and the new H3 sits directly under an H2, so the markdownlint structural rules (MD001, MD055, MD056) hold.

## Test Plan

- No code path changed, so no new test is added and no red check applies.
- `markdownlint-cli2` over `docs/MANAGER-WORKER-CONTRACT.md`: expected 0 issues (structural rules only; line length is disabled).
- The existing `worker/deno/tests/manager_worker_contract_3641_test.ts` (10 tests) is untouched and continues to pin the native Codex/Gemini silent drop, which this PR documents rather than changes.
- <!-- vibe-branch-outcomes -->

**Pre-PR security self-check.** The change is a single Markdown file. No secrets, no `.env`/`.config*.json`, no private-key material, no dependency changes (`deno.json` and `deno.lock` are untouched).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
