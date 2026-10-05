## Summary

Widened **Prose about the PR's own change** so it covers sentences about
**which inputs** a scan, check, guardrail or test list handles. Before, it
covered only **when** the change's behaviour happens and **what it costs**.
Item 2 now counts "every", "all", "each", "no … is missed" and counted or
closed lists ("three things are …", "X, Y and Z are the …") as absolute
words. A claim about which inputs are covered must match the code that builds
the set (the candidate selection, filter or allow-list, or the `Branch
outcomes:` list), or be scoped to it. The three send-backs from the issue are
added as examples. The issue and pr_feedback prompts restate the rule with
the same wording, and the #3120 drift test now pins the new phrases.
Closes #3232.

## Spec

### Intent and Rationale

- All three send-backs made the same mistake: the set was written from intent
  or memory, not from the code that selects it. The rule already asked for
  head code behind absolute words. Adding the quantifiers and closed lists to
  that list, plus a "which inputs" scope, catches this pattern without a new
  rule.

### Essential Design Decisions

- The change extends the existing rule (item 2) and its two prompt
  restatements rather than adding a separate rule, so the three places stay
  one rule.
- The test-coverage case refers back to the existing coverage-claim rule
  (**A named test must exist**, Issue #3058) instead of restating it.

### Undiscoverable Facts

- I checked the VibeCoder#3231 example against
  `worker/deno/lib/milestone_not_planned_refs.ts`:
  `findNotPlannedDocReferences` scans milestone members, then looks up each
  declared dependency with `repos/${repo}/issues/${dep}`, which only covers
  same-repo targets.

## Evidence

Docs and prompt change only (no runtime code). The drift test
`worker/deno/tests/own_change_claims_3120_test.ts` pins the new phrases in
all three places.

**Docs sweep** — grep: `"any", "automatically"`, "what it costs", "Prose
about the PR", `exactly as before` in prompts and `worker/deno/lib`; section:
`CODING-STANDARDS.md#pr-summary-and-evidence` (**Prose about the PR's own
change**); updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`,
`prompts/pr_feedback/prompt.md`;
`worker/deno/lib/pr_feedback_drift_check.ts:278` — still true because it is a
different check (it finds sentences a push makes false), and its word list
only gives examples ("a dropped condition, an absolute word …"), not the
closed set this rule defines;
`docs/audits/security-sweep-1220-setup-cli.md:169` — still true because it is
an unrelated audit finding that happens to use the words "what it costs".

Related existing rules checked: `CODING-STANDARDS.md` **A named test must
exist** (coverage claim names the branches its tests exercise, #3058);
`prompts/issue/prompt.md` **Demonstrate a criterion; do not assert it**
("every branch", "all rejections"); the guidelines' **A broad rule names every
exception** (about rule text, not claims). Each one agrees with the new
wording, and none needed to change.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `CODING-STANDARDS.md`, **Prose about the PR's own change**, item 2: add "every", "all", "each", "no … is missed" and counted or closed lists to the absolute words; for a claim about which inputs a scan, check, guardrail or test list covers, open the code that builds the set and match it or scope the sentence to it; add the three examples — evidence: `CODING-STANDARDS.md` (PR Summary and Evidence), `worker/deno/tests/own_change_claims_3120_test.ts::CODING-STANDARDS.md PR Summary and Evidence holds every/all and closed-list claims to the code that builds the set (Issue #3232)` — reviewer: met
- **met** — Mirror the wording where the rule is summarised: `prompts/issue/prompt.md` and `prompts/pr_feedback/prompt.md` — evidence: `worker/deno/tests/own_change_claims_3120_test.ts::issue prompt docs-change step holds every/all and closed-list claims to the code that builds the set (Issue #3232)`, `worker/deno/tests/own_change_claims_3120_test.ts::pr_feedback prompt Making Changes holds every/all and closed-list claims to the code that builds the set (Issue #3232)` — reviewer: met
- **met** — Extend the existing drift test that pins this rule's phrases so the new words cannot drift out — evidence: `worker/deno/tests/own_change_claims_3120_test.ts` (three new tests) — reviewer: met
- **unrequested** — The sentence "A test-coverage claim is the same check: it names the branches its tests exercise (**A named test must exist** above)" in `CODING-STANDARDS.md` item 2 — reviewer: unrequested — reason: it links the new rule to the existing #3058 coverage-claim rule so the two cannot be read as different checks, and it covers the issue's own VibeCoder#3160 example

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no violations; documentation-drift tests are section-scoped and the headings exist; no assertions removed; no named test is missing; Australian English. Optional notes: the three new phrase lists repeat the same four phrases (minor DRY nit, not chased); pin provenance is recorded in the Test Plan below

## Test Plan

- Added three tests to `worker/deno/tests/own_change_claims_3120_test.ts`
  (one per place the rule appears). No existing assertion was removed or
  changed.
- Pin provenance: `deno task drift-pins-on-base HEAD <doc> <section> …` (run
  before the edit, from `worker/deno`) reported **absent on base** for each
  pinned phrase, in each section the tests read: `"every", "all"`, `a counted
  or closed list`, `which inputs`, `the code that builds the set`,
  `VibeCoder#3231`, `VibeCoder#3160`, `GRQ-AutoTrader#2479`, `(Issue #3232)`
  for `CODING-STANDARDS.md` § PR Summary and Evidence,
  `prompts/issue/prompt.md` § Instructions and `prompts/pr_feedback/prompt.md`
  § Making Changes. Each new test therefore goes red against the base docs.
- `deno test --allow-read tests/own_change_claims_3120_test.ts` (from
  `worker/deno`): 6 passed, 0 failed.
- `./quality.sh < /dev/null` on the final head: PASSED, with skipped checks
  (config integration skipped).

**Branch outcomes:** none added
