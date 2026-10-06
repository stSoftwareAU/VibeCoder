## Summary

Adds the rule **A new argument or behaviour reaches every caller that needs
it** to `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, word
for word on both, placed straight after **Every changed call site needs a test
that goes red without it**. The issue prompt's Test Plan step now points at it.
Before changing a shared function or a router, the agent lists every caller and
sibling route. It then passes the new value on each one or says why a caller
does not need it. A parameter that carries the behaviour is made required
instead of defaulting to a value that switches the behaviour off. A caller left
on the old hard-coded value, or a test that hands the new value straight to the
helper, is a blocking self-review finding. Closes #3253.

## Spec

### Intent and Rationale

- VibeCoder#3251, GRQ-AutoTrader#2282 and VibeCoder#3095 were all sent back for
  a caller the diff should have changed but did not touch. The #3067 revert
  check cannot find a caller like that, because the diff left it unchanged and
  there is nothing to revert. The new rule covers that gap.
- Making the parameter required lets the compiler or type checker find the
  missed callers, which is more reliable than asking reviewers to spot them.

### Essential Design Decisions

- Same placement and mirroring as #3067 and #3100: one identical paragraph on
  both surfaces, enforced by a drift test.
- The rule allows a caller to go without the value when the PR summary gives
  the reason, so a genuinely uninvolved caller is not forced to pass it.

### Undiscoverable Facts

- The three send-backs cited are from the fleet PR reviewer, dated
  2026-10-02 to 2026-10-05 (see the issue body).

## Evidence

Documentation and prompt change only. No runtime code changed.

**Related rules checked:** **Every changed call site needs a test that goes red
without it** (#3067, the new rule covers callers outside that one's reach and
names it); **Narrowing a shared helper changes every caller** (#3100, deals
with a different case: rejecting values, not missing callers); **A new path to
an existing outcome keeps that outcome's guards** (#3087, about guards, not
arguments). None of them conflicts with the new rule.

**Docs sweep** — grep: "Every changed call site", "Narrowing a shared helper", "call site", "callers checked"; section: `docs/workflows/issue-processing.md#narrowing-a-shared-helper-changes-every-caller-issue-3100` (the guideline-history list); updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`; `CODING-STANDARDS.md:654` — still true because the Units bullet's back-reference to the changed-call-site rule is unchanged

## Test Plan

- Added `worker/deno/tests/caller_reach_3253_test.ts`. It checks that both
  surfaces carry the identical paragraph with its 8 key phrases, and that the
  issue prompt's PR Summary File section carries the pointer. It passed on the
  head.
- Went red without its change: deleting the paragraph from
  `CODING-STANDARDS.md` alone failed test (a), and deleting the sentence from
  the issue prompt failed test (b).
- Per-phrase base check: `deno task drift-pins-on-base origin/main <doc>
  <section> ...` reported every pinned phrase as `absent on base`. That covers
  all 8 phrases in `CODING-STANDARDS.md` "Test coverage expectations", the same
  8 in `prompts/coding_guidelines/prompt.md` "Test Coverage Expectations", and
  both phrases in `prompts/issue/prompt.md` "PR Summary File".
- `./quality.sh < /dev/null` passed on the head. Every stage passed except
  config integration, which was skipped because this run has no live config.
- No existing test was edited, and no assertion was removed.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
