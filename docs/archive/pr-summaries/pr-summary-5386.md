# PR Summary — Issue #5386

## Summary

Shortened the **Observe the real tool before you rely on it** rule (#3082),
which recurred on 24 PRs after #3952 closed with no change. It now asks for the
test's input to come from the tool: run the tool in the test where the suite has
it, in the environment production gives it, or use output copied from a real
run. Removed from all three surfaces:

- "in a particular case" and its bracketed list of example behaviours;
- "run the real tool on that case first" as a step separate from the test;
- the PR-summary sentence, in both the rule and the issue prompt's
  Bugs/Enhancements restatement.

The heading, the scope (git, `gh`, the GitHub API or another external tool),
real examples from the issue, the fall-back to documentation or source, and the
issue prompt's blocking self-review sentence all stay.

Closes #5386.

## Spec

### Intent and Rationale

- The old rule put the observation before the test and asked for a PR-summary
  line, and neither stopped a typed fixture. Taking the test's input from the
  tool removes the separate step to remember.

### Essential Design Decisions

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` carry the
  issue's proposed paragraph word for word, identical in both files.
- The issue said to leave out "in the environment production gives it" if it
  read as an extension. I kept it: it stands in for the retired "in a particular
  case", and it is the cause in #3533 and #4888.
- The restatement in `prompts/issue/prompt.md` keeps the fall-back to
  documentation or source, because the issue asked for "the same content", and
  it keeps the back-reference and the blocking self-review sentence.

### Undiscoverable Facts

- No manual under `docs/` restates this rule. A grep for
  `Observe the real tool`, `run the real tool on that case` and
  `command you ran and the part of the
  output` outside `docs/archive/` and
  `docs/audits/` found it only on the three surfaces above, plus tests that
  locate the unchanged heading.

## Evidence

Docs and prompt change only; no runtime code changed.

- I checked the rules that overlap this one:
  - The failure-reason cause bullet still says "Observe the real tool's output
    for each failure class" and points at the unchanged heading.
  - **A failure-reason test asserts the cause** still accepts "a fake built from
    its observed output".
  - The neighbouring fake-mirrors and third-party-semantics paragraphs do not
    restate this rule.

  None of them conflicts with the new wording.
- I applied the rule to this PR's own diff and found nothing to flag: the diff
  reads no external tool's output.
- The only issue number this diff adds is #5386, in the drift test's doc comment
  and messages. It is this issue: "Shorten the #3082 observe-the-real-tool rule
  after recurrence". `gh issue view` hit the GitHub API rate limit at the end of
  this run, so the title is quoted from the issue as the run received it.

## Test Plan

- I edited `worker/deno/tests/observe_real_tool_3082_test.ts`.
  - **Unchanged:** the check that both surfaces carry the same paragraph, and
    the check that the paragraph sits between the stub-contract and
    workflow-validator paragraphs.
  - **Retired by the issue:** the phrase pins for "run the real tool on that
    case first", "Build the fake's fixture from the observed output", "give the
    command you ran …" and "cite the tool's documentation or source".
  - **New pins on both surfaces:** "prints or returns", "take the test's input
    from the tool, not from what you expect it to be", "run the tool in the test
    where the suite has it", "in the environment production gives it", "or use
    output copied from a real run" and "take it from the tool's documentation or
    source". "If the issue names real examples, use them" is still pinned.
  - **New absence check:** four phrases from the old rule must not appear in the
    located paragraph: "run the real tool on that case first", "in a particular
    case", "give the command you ran and the part of the output the code depends
    on" and "Build the fake's fixture from the observed output". This set is not
    the same as the retired pins above. "cite the tool's documentation or
    source" is not in it, and "in a particular case" was never pinned. Locating
    the paragraph is the positive control.
  - **Issue-prompt test:** it now pins "take the test's input from the tool" and
    "run the tool in the test where the suite has it". It still pins the
    back-reference and the blocking self-review sentence, and it asserts that
    "The PR summary's Evidence gives the command you ran" is absent.
- **Red on base:** I ran the new test file against the unedited base docs in a
  temporary worktree: `FAILED | 1 passed | 2 failed`. The two phrase tests
  failed; the ordering test passed, as expected.
- **Head:** these tests passed on the final head:
  - `observe_real_tool_3082_test.ts`, `failure_reason_cause_3429_test.ts`,
    `fake_mirrors_production_3224_test.ts` and
    `third_party_tool_semantics_3235_test.ts`;
  - `quality_gate_budget_test.ts`, `prompt_builder_test.ts`,
    `coding_guidelines_*_test.ts`, `existing_rule_conflicts_3077_test.ts` and
    `issue_prompt_comments_1910_test.ts`.
- **`./quality.sh`:** I gave it a 900s timeout, and it hit that timeout after
  every stage up to and including `deno tests` (845s) and `deno lint` had
  passed; config integration and checkov were skipped by the gate itself. I then
  ran the two stages still left, the way the gate runs them, from `worker/deno`:
  `deno check '**/*.ts'` exited 0, and `deno fmt --check` exited 0 ("Checked
  3905 files").
- **`deno task pr-summary-check`:** 0 gates blocked. It ran without
  `--issue-body-file`, because `gh issue view` hit the API rate limit, so the
  closure and two-axis review gates are reported as not checked. The issue has
  no acceptance-criteria or definition-of-done heading, so no reviewers were
  dispatched and no closure block is needed.

Not done or not checked: the closure and two-axis review gates were not run with
the issue body, and the full gate was not re-run from the start after its
timeout; I ran its two remaining stages on their own instead.
