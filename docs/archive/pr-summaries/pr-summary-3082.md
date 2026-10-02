## Summary

Closes #3082. Fleet PRs relied on how an external tool behaves without
running it, and their fakes encoded the same guess, so the tests passed:

- PR #2939 assumed a broken ref makes `git for-each-ref` fail.
- PR #2949 compared `gh` labels by exact case.
- PR #3079's fake `gh` returned only the merge commit from `compare`.

The guidelines now require running the real tool on that case before relying
on its behaviour, building the fake's fixture from the observed output, and
quoting the command and output in the PR summary.

## Spec

### Intent and Rationale

- "A stub mirrors the real callee's contract" says the fake must match the
  real tool. It does not say how the author learns what the real tool does.
  The new paragraph fills that gap: observe first, then fake.
- The rule rides into every code-writing run through the injected guidelines.
  The issue prompt's Bugs/Enhancements requirement checks it again at
  self-review.

### Essential Design Decisions

- The paragraph is the issue's proposed text, verbatim. It sits directly after
  the stub-contract paragraph and is identical on both twin surfaces
  (`CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`). A drift
  test pins the wording and the position.
- The self-review check extends the Bugs/Enhancements bullet, which already
  carries the stub-contract check, so the two read together. It does not go
  in the Test Plan step.
- When the case cannot be observed safely, citing the tool's documentation or
  source is an acceptable substitute, as the issue proposes.

### Undiscoverable Facts

- The three motivating cases and the reviewer's finding on #3079 (three
  `gh api` calls against GRQ-AutoTrader #2213, #2210 and #2218) are recorded
  only in the issue body.

## Evidence

Following the new rule, the doc note's claims were checked against the real
tools rather than taken from the issue:

- Running `git for-each-ref` on a ref file holding `garbage` (git 2.47.3)
  printed `warning: ignoring broken ref refs/heads/broken` and exited 0.
  A ref that points at a missing object behaves differently: it prints
  `fatal: missing object …` and exits 128. So the #2939 example holds only
  for malformed refs.
- `gh api repos/stSoftwareAU/VibeCoder/labels/Needs-Human -q .name` returned
  `needs-human` and exited 0, so label lookup is case-insensitive.
- The #3079 `compare` behaviour comes from the issue's reviewer finding on
  GRQ-AutoTrader #2213/#2210/#2218; it was not re-run here.

Changes:

- `CODING-STANDARDS.md` › **Test coverage expectations** and its twin
  `prompts/coding_guidelines/prompt.md` › **Test Coverage Expectations**: the
  new **Observe the real tool before you rely on it** paragraph.
- `prompts/issue/prompt.md` › PR Raising Requirements › Bugs/Enhancements: a
  self-review check. A fake built from expected rather than observed behaviour
  is a blocking finding. Evidence must give the command and output, or cite
  the documentation or source.
- `docs/workflows/issue-processing.md`: a paragraph explaining the rule, next
  to the #3060/#3067 paragraphs.
- To check that the new drift test can fail, one sentence of the paragraph
  was removed from `CODING-STANDARDS.md` and the test was run. It went red,
  and passed again once the sentence was restored.

**Docs sweep** — grep: "A stub mirrors the real callee's contract", "stub
must mirror", "Fake the external service"; updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`docs/workflows/issue-processing.md` (remaining hits are tests and archived
summaries).

## Test Plan

- Added `worker/deno/tests/observe_real_tool_3082_test.ts`:
  - both surfaces carry the identical paragraph with its key phrases;
  - on both surfaces it sits between the stub-contract and
    workflow-validator paragraphs;
  - the issue prompt's PR Raising Requirements carry the self-review check.
- Existing `worker/deno/tests/phantom_test_and_stub_contract_3011_test.ts`
  and `worker/deno/tests/changed_call_site_red_3067_test.ts` still pass.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
