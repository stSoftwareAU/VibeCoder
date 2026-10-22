## Summary

Refs #4121.

This branch carries no #4121 implementation. Its tree is identical to `main` (`git diff main` is empty): the last commit reset the tree to `main` and dropped the #4109 reroute that the branch had picked up. None of the Codex RTK work (hook config, capability flag, tests, docs) has been done.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **missing** — Spike first, and record the result in the PR: one Codex exec turn with a PreToolUse hook running rtk hook claude, quoting the hook input shape and whether the rewritten command ran — reviewer: missing — reason: no spike record, hook-payload quote or shim; the diff is empty
- **missing** — Codex invocations get the hook per spawn (-c hooks config or per-run CODEX_HOME layer) and the run reports rtk: ok with the saved-token delta — reviewer: missing — reason: no hooks config or CODEX_HOME layer exists in `worker/deno/lib/agent_provider.ts`; Codex runs still report unsupported
- **missing** — prepareRtkRun decides support from a provider-seam capability flag, not providerId !== CLAUDE_PROVIDER_ID — reviewer: missing — reason: `worker/deno/lib/rtk_output.ts:235` still compares against CLAUDE_PROVIDER_ID
- **missing** — Tests: Codex argv carries the hook config when RTK is enabled and omits it when disabled; a Codex run reports ok, not unsupported — reviewer: missing — reason: no tests added
- **missing** — docs/ RTK section lists Codex as supported — reviewer: missing — reason: `docs/CONFIGURATION.md:1899` and `docs/RTK-OUTPUT-TRIAL.md` still list Codex as unsupported

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The diff against `main` is empty, so there is no code to breach CODING-STANDARDS.md; the reviewer found no violations, and also nothing implementing #4121.
