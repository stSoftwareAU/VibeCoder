## Summary

Adds a rule that prompt and doc text must check a claim about another component against the code before stating it. The rule is in the Prompt Engineering Guidance section of `CODING-STANDARDS.md` and in the docs-change step (step 3) of `prompts/issue/prompt.md`. Before new text says how another part of the system behaves, the author finds the implementing code and cites it. This matters most for an exclusive or negative claim ("the only …", "never …", "the worker does not …"). A claim about a security control must agree with `SECURITY.md` and `docs/THREAT-MODEL.md`. A claim the rule does not need is left out. Closes #3072.

## Spec

### Intent and Rationale

- Two fleet PRs (#3068, #3071) were sent back for false claims about existing code outside their diff. Both justified a rule with a broad or negative claim about the system that nobody had checked.
- The rule goes in the canonical standard, and the issue prompt points to it, so agents meet it at the step where they write docs.

### Essential Design Decisions

- The issue prompt's wording is shorter than the standard's and links back to it. Only the standard names the two incidents.
- A documentation-drift test pins the key phrases on both surfaces, so a later edit cannot quietly drop the rule.

### Undiscoverable Facts

- I checked the two incidents named in the new bullet against the code, as the rule requires:
  - `worker/deno/lib/idle_task_templates/security_scan_template.ts:368,421` and `worker/deno/lib/security_tree_sweep.ts:2019` pass `knownOpenFindingIds: []`.
  - `worker/deno/lib/gh_guard_cli.ts:382` (`allowWithRedactedBody`) redacts the `gh` bodies the agent writes, as `docs/THREAT-MODEL.md` control C24 records.

## Evidence

This changes docs and prompts only, with no UI and no runtime code. Verification:

- `deno task test:unit tests/system_behaviour_claims_3072_test.ts` passes. With the new `CODING-STANDARDS.md` bullet removed it fails (`Prompt Engineering Guidance is missing "Verify a claim about another component before you write it"`), and it passes again once the bullet is restored.
- `./quality.sh` passed. "config integration" was skipped because the worktree has no `.config.json`.

**Docs sweep** — grep: "Prompt Engineering Guidance", "Docs sweep"; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`. No other surface describes this rule.

## Test Plan

- Added `worker/deno/tests/system_behaviour_claims_3072_test.ts`, which checks that both surfaces carry the rule's key phrases.
- No existing test changed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
