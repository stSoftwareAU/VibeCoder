## Summary

Closes #4121.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **missing** — Spike first, and record the result in the PR: one Codex exec turn in the container with a PreToolUse hook running rtk hook claude on Codex's shell tool. Quote the hook input Codex sends (tool name and command shape, string or argv array) and whether the rewritten command ran. If rtk hook claude cann — reviewer: missing — reason: no spike, hook-payload record or shim in the diff; the branch carries Issue #4109 work (rerouting sub-agent runs off codex/gemini/deepseek) and does not touch RTK for Codex
- **missing** — Codex invocations get the hook per spawn ( -c hooks config or a per-run CODEX HOME layer, so it never touches the operator's ~/.codex ). The run reports rtk: ok with the saved-token delta, as Claude runs do. — reviewer: missing — reason: no hooks config or per-run CODEX HOME layer is added to the Codex invocation in agent provider.ts; Codex runs still do not report rtk: ok
- **missing** — prepareRtkRun decides support from the provider's capability (a provider-seam flag), not from providerId !== CLAUDE PROVIDER ID . — reviewer: missing — reason: prepareRtkRun and its providerId check are unchanged; the only RTK edit swaps rtkProviderId(invocationAgentProvider, …) for rtkProviderId(effectiveAgentProvider, …) in execute claude phase.ts, which is #4109 plumbing and adds no capability flag
- **missing** — Tests: the Codex argv carries the hook config when RTK is enabled and omits it when disabled. A Codex run reports ok , not unsupported . The tests fail on today's code. — reviewer: missing — reason: no test asserts Codex hook argv or an ok RTK status; the new tests (issue 4109 callsite test.ts, issue run provider agents test.ts, agent provider test.ts) cover the #4109 reroute, and the RTK test there only checks that the sink receives the rerouted provider
- **missing** — docs/ RTK section lists Codex as supported. — reviewer: missing — reason: no RTK docs change; the docs edits (CONFIGURATION.md, MANAGER-WORKER-CONTRACT.md, MODEL-AND-CACHING.md, PROVIDER-FEASIBILITY.md) describe the #4109 reroute
- **unrequested** — Issue #4109 provider reroute for sub-agent issue runs (issue run provider agents.ts, execute claude phase.ts, execute phase.ts, provider feasibility.ts, deepseek executor.ts, claude runner.ts, issue worker wiring.ts) — evidence: `worker/deno/lib/issue run provider agents.ts` — reviewer: unrequested — reason: belongs to Issue #4109, not to #4121's RTK-for-Codex scope
- **unrequested** — #4109 tests, docs and audit file (issue 4109 callsite test.ts, issue run provider agents test.ts, agent provider test.ts, manager worker contract 3641 test.ts, docs/audits/lib-sweep-coverage/top-up-4109.json, docs edits) — evidence: `worker/deno/tests/issue 4109 callsite test.ts` — reviewer: unrequested — reason: supports the #4109 change and is not traceable to #4121

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — The branch is built on the Issue #4109 branch (merge 4578c0fb and #4109 commits), so the diff for #4121 holds unrelated work and no implementation of the issue. The diff also does not exercise the Standards review of any #4121 code, because there is none. — evidence: `worker/deno/lib/issue run provider agents.ts:1` — reason: not fixed in this diff — the #4121 work has to be done on a branch cut from main, which this turn cannot do
- **clean** — No standards review was run of the #4109 code. Nothing was checked for spelling, TDD, quality gates or error handling, because that code is out of scope for #4121.
