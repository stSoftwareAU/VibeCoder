## Summary

Adds rule 5, **Reading the worker's own marker is a gate over text**, to the
**Writing a gate over text** checklist in `CODING-STANDARDS.md`, and restates
it in the issue prompt's gate-over-text bullet (`prompts/issue/prompt.md`).
When a body mixes worker-written text with agent, issue or comment text, the
worker's marker is read only where the worker writes it: the opening block,
the opening heading with the marker on the next line, or a `startsWith` on the
worker-written prefix. The other option is to read it after the agent text has
been neutralised. It is never read with `includes()` or a first-occurrence
match over the whole body. The look-alike tests must quote the marker in a
code span and in prose, and cover the body after the worker re-wraps it.
Closes #3696.

## Spec

### Intent and Rationale

- VibeCoder#3353, #3440 and #3676 each read a worker marker with `includes()` or a first-occurrence match over a body that also held the agent's summary. Their authors did not treat that read as a gate over text, so the #3149 look-alike rule never applied to it.
- I extended the existing numbered list instead of adding a parallel section, as the issue asks (Issue #3554).

### Essential Design Decisions

- The rule names existing anchored readers and neutralisers (`extractLeadingSection`, `hasFollowUpChainStop`, `SUMMARY_RULE_GATE_MARKER`'s `startsWith`, `neutraliseAgentMarkers`, `neutraliseSubAgentTierMarkers`), so a new marker reuses one of them rather than getting a new helper.
- The ban on `includes()` covers only a mixed body. A body the worker writes entirely is outside the rule.

### Undiscoverable Facts

- The issue places `neutraliseSubAgentTierMarkers` in `agent_marker_neutralisation.ts`. At the head it lives in `worker/deno/lib/pr_body.ts`, so the rule cites that path.
- `extractLeadingSection` is private to `pr_body_sync.ts`. The rule says to widen a private owner's export rather than copy it, which agrees with **Call the existing owner — never copy it** in the issue prompt.

## Evidence

This change is documentation and prompt text only, with drift tests. No production code changed.

- Cited code, checked at the head: `worker/deno/lib/missing_criterion_close_guard.ts` (`hasFollowUpChainStop` matches heading + marker with `startsWith` after `trimStart`), `worker/deno/lib/failure_diagnosis.ts` and `worker/deno/lib/host_fault.ts` (`startsWith(SUMMARY_RULE_GATE_MARKER)`), `worker/deno/lib/pr_body_sync.ts` (`extractLeadingSection`), `worker/deno/lib/agent_marker_neutralisation.ts` (`neutraliseAgentMarkers`), `worker/deno/lib/pr_body.ts` (`neutraliseSubAgentTierMarkers`). The neutralisation claim agrees with `SECURITY.md` ("passes the run's reason and output through `neutraliseAgentMarkers`, so agent text cannot forge a fleet marker").
- Related existing rules checked: **Writing a gate over text** rules 1–4 (rule 5 extends rule 1's look-alike table), and **Automation and Shared GitHub State** ("match a marker this code path wrote under its own heading"), which agrees with the new rule. `prompts/coding_guidelines/prompt.md` has no gate-over-text restatement, and the issue prompt bullet is the only one. No rule conflicts.
- Rule applied to this PR's own diff: the diff adds no marker reader. The drift tests use `includes()`/`assertPins` on documentation sections, and no worker marker is read there. Nothing to fix.
- Restatements give the same answer for the edge case (a marker quoted by agent text in a mixed body does not fire): CODING-STANDARDS rule 5, the issue prompt bullet, and the test file's doc comment.
- Provenance numbers cited: #3353: PR body re-sync skipped GRQ5175's summary-rewriting feedback pushes, and summary 'Refs #N' still gets 'Closes #N' appended, so the body finding loops (Issue #3315); #3440: fix(worker): classify summary-gate refusals as summary_incomplete, not worker-crash (#3431); #3676: A healthy run that closes out a criterion as partial or missing still closes the issue with no follow-up (three private fleet PRs) (Issue #3506); #3696: Fleet PRs read the worker's own marker anywhere in a body that embeds agent text, so a summary quoting the marker trips the control path.

**Docs sweep** — grep: "gate over text", "four-point", `neutraliseAgentMarkers`, `extractLeadingSection`; section: `CODING-STANDARDS.md#writing-a-gate-over-text`; siblings: "Compare like with like", "No silent pass on unread input"; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`, `worker/deno/tests/text_gate_matcher_3149_test.ts` (doc comment no longer says "four-point"); `worker/deno/lib/branch_outcomes_gate.ts:256` — still true because it cites rule 3, which is unchanged and not renumbered; `worker/deno/lib/removed_assertion_gate.ts:502` — still true because it quotes rule 1's source-code sentence, which is unchanged; `SECURITY.md:1715` — still true because the planning hand-off still neutralises agent text

## Test Plan

- Added two drift tests to `worker/deno/tests/text_gate_matcher_3149_test.ts`:
  - `CODING-STANDARDS.md Writing a gate over text treats reading the worker's own marker as a gate (Issue #3696)`
  - `issue prompt gate-over-text bullet covers reading the worker's own marker (Issue #3696)`
- Per-pin red check: `deno task drift-pins-on-base origin/milestone/failure-classification-worker-markers-and-declared <doc> <section> <pins…>` reported `absent on base` for all six CODING-STANDARDS pins (section "Writing a gate over text") and all four issue-prompt pins (section "Instructions").
- `deno task test:unit tests/claude_token_budget_test.ts tests/text_gate_matcher_3149_test.ts tests/own_restatements_agree_3554_docs_test.ts`: 37 passed, 0 failed.
- No existing assertion was removed or edited.
- `./quality.sh` result: see the line below.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
