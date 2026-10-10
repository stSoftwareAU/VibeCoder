## Summary

Adds a plumbing-ahead-of-consumer clause to **Behaviour another issue
delivers is not described as present**, in both `CODING-STANDARDS.md`
(§ PR Summary and Evidence) and `prompts/issue/prompt.md` (Instructions,
step 3). When a diff adds a setting, flag, field, hook or API, the author now
greps the head for its **reader**. If nothing reads it yet, every doc row,
prompt line and code comment that describes its effect says it is "accepted
but not read yet" and names the open issue that will read it. Closes #3437.

## Spec

### Intent and Rationale

- The existing rule fires only on sentences that name a sibling's `#N`. Docs
  for a new key describe the key's effect and never name the consumer issue,
  so that grep cannot find them (VibeCoder#3434). The trigger is now the
  missing reader, not the issue number.
- The rule's wording is the fix, so a documentation-drift test pins the new
  phrases in both places.

### Essential Design Decisions

- The clause sits inside the existing paragraph and step as an extension, not
  as a separate rule, so the two cannot contradict each other.
- The optional `reader:` entry on the Docs sweep line was left out. The worker
  parses that line (`docs_sweep_hits.ts` re-runs its quoted terms), so new
  structure there needs its own change.

### Undiscoverable Facts

- VibeCoder#3434's author ran the sibling `#N` check and recorded that the
  tier had no consumer yet, but did not apply that to the PR's own new
  `docs/CONFIGURATION.md` rows (issue body).

## Evidence

This is a documentation and prompt change only: there is no UI and no runtime
code.

- `worker/deno/tests/plumbing_reader_rule_3437_docs_test.ts` pins the new
  clause in CODING-STANDARDS.md § PR Summary and Evidence and in the issue
  prompt's § Instructions.
- Issue numbers this diff adds: #3437: Plumbing PRs document a new config key
  as working before any code reads it (this issue); VibeCoder#3252: the
  `timing_assertion_policy_test.ts` drift-test PR (Issue #3242), cited as a
  sent-back example; VibeCoder#3434: Add issue_sub_agent_tier config key
  (Issue #3401), cited as a sent-back example. `#3240` appears only inside the
  quotation of #3252's comment.
- Related existing rules checked: **Behaviour another issue delivers is not
  described as present** (extended), **Prose about the PR's own change**,
  **An issue number cited as provenance is one you looked up**, **A Code
  Change Owes a Docs Change**, **Apply a new rule to your own diff**, and the
  issue prompt's step 3 restatements. None conflict: the new clause only
  narrows how present-tense prose about an unread setting may be written.
- I applied the new rule to this PR's own diff. The diff adds no setting,
  flag, field, hook or API, so the rule finds nothing in it.

**Docs sweep** — grep: "Behaviour another issue delivers", "sibling's",
"not read yet", "config key"; section:
`CODING-STANDARDS.md#pr-summary-and-evidence`; updated: `CODING-STANDARDS.md`,
`prompts/issue/prompt.md`. `CODING-STANDARDS.md:246` is still true because it
covers drift-test constants, not settings documentation.

## Test Plan

- Added `worker/deno/tests/plumbing_reader_rule_3437_docs_test.ts` (two
  tests). `deno task test:unit tests/plumbing_reader_rule_3437_docs_test.ts
  tests/forward_reference_rule_3223_docs_test.ts`: 4 passed, 0 failed.
- `deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts …`
  printed `absent on base:` for every pinned phrase. CODING-STANDARDS.md
  § PR Summary and Evidence has five pins: "until something reads it", "Grep
  the head for its **reader**", "accepted but not read yet", "names the open
  issue that will read it" and "VibeCoder#3434". The issue prompt's
  § Instructions has four: the same set without "VibeCoder#3434" and with
  "grep the head for its reader" in lower case.
- No existing test was edited, and no assertion was removed.
- `./quality.sh`: passed on the final head (`config integration` skipped: no
  `.config.json` on this host). The first run failed
  `coding_standards_model_agnostic_test.ts` because the #3434 example named
  model generations; the example now says "the hard-coded one".

**Branch outcomes:** none added
