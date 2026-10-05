## Summary

Adds the rule **A test of a third-party tool's input uses that tool's
semantics** to `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`.
The two copies are word for word the same, and on both surfaces the rule sits
directly after the #3224 fake-mirrors rule. The workflow-validator rule on
both surfaces now points to it. The operator manual
(`docs/workflows/issue-processing.md`) records why. Closes #3235.

## Spec

### Intent and Rationale

- TagsTS#93 and TagsTS#98 both tested config read by an external tool against an in-repo copy of that tool's engine, and the copy behaved differently from the real tool:
  - TagsTS#93 used a hand-written glob matcher.
  - TagsTS#98 used JavaScript `RegExp` where Renovate uses RE2.
- The fake-mirrors rule covers only the repository's own ports, and "observe the real tool" covers runtime behaviour. Neither one covered this case.
- The new rule asks for the tool's own validator or engine where the repository's CI can run it. Where it cannot, the in-repo copy must be tested against cases from the tool's documentation, including one input the tool rejects or does not match.

### Essential Design Decisions

- The rule text follows the issue's proposed wording. Its opening sentence separates it from the fake-mirrors rule, and it includes the issue's two examples.
- The rule sits between the fake-mirrors and observe-real-tool paragraphs. This keeps the stub → fake → observe → workflow-validator order that existing drift tests check.
- The link from the workflow-validator rule is a single appended sentence, so the existing wording that the #3021 tests pin stays unchanged.

### Undiscoverable Facts

- Documentation behind the examples:
  - GitHub's [filter pattern cheat sheet](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet): `*` matches any characters except `/`, so `*/*` matches `milestone/foo`.
  - RE2's [syntax page](https://github.com/google/re2/wiki/Syntax) lists `(?!re)` as "NOT SUPPORTED".
- The issue's "How future reviews can verify it worked" is measured over later fleet reviews (`review-fleet-prs` `log.jsonl`), so this PR cannot show it.

## Evidence

This change touches documentation and prompts only. Nothing in the runtime changed.

**Related existing rules checked** (CODING-STANDARDS.md and the coding_guidelines prompt):

- **"A stub mirrors the real callee's contract".** That rule covers another repository's binary. The new rule covers config read by an external tool. They do not overlap and do not conflict.
- **"A fake mirrors the production implementation it stands in for".** That rule covers the repository's own ports, and the new rule's opening sentence says so.
- **"Observe the real tool before you rely on it".** That rule covers runtime behaviour. The new rule extends it to a test's copy of a tool's pattern engine.
- **"A workflow behaviour change extends the workflow validator".** It now links to the new rule.
- **The Bugs/Enhancements requirement in `prompts/issue/prompt.md` (the stub, fake and observe checks).** Unchanged; see the Docs sweep.

None of these conflicts with the new rule.

**Docs sweep:**

- grep: `stand-?in`, `third-party tool`, `workflow validator`, `emulat\w* GitHub`
- updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `docs/workflows/issue-processing.md`
- Hits left in place:
  - `prompts/issue/prompt.md:558`: still true. Its workflow-validator section governs `.github/workflows` changes and is unchanged. The issue asks only for CODING-STANDARDS.md and the coding_guidelines prompt, and the same run receives both of them.
  - `docs/workflows/issue-processing.md:1108`: still true. It lists the Standards reviewer's always-violation departures, and this issue does not extend that list.
  - `worker/deno/lib/issue_executor_agents.ts:199`: still true, for the same reason.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- Paragraph added next to the #3224 rule in `CODING-STANDARDS.md`. reviewer: met. See `CODING-STANDARDS.md:520`.
- Paragraph mirrored in `prompts/coding_guidelines/prompt.md`. reviewer: met. The text is byte-identical, and the drift test checks that.
- Workflow-validator rule links to the new paragraph. reviewer: met. See `CODING-STANDARDS.md:552-554` and the prompt equivalent.
- Doc-sourced examples (`*/*` matching `milestone/foo`, and the RE2 look-ahead). reviewer: met.
- Two-week `log.jsonl` verification. reviewer: missing. This is a process measure over later fleet reviews, and no diff can deliver it.
- `docs/workflows/issue-processing.md` rationale paragraph. reviewer: unrequested. It follows the repository's convention of recording each rule change in the operator manual.
- `worker/deno/tests/third_party_tool_semantics_3235_test.ts`. reviewer: unrequested. It is a documentation-drift test, following the repository's convention for rule text that is mirrored across surfaces.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

violation: none found

clean:

- The new rule's placement and its agreement with the stub, fake, observe and workflow-validator rules.
- The two surfaces are word for word the same.
- The test uses the real `worker/deno/tests/support/markdown_docs.ts` helpers.
- Australian English throughout.

## Test Plan

- Added `worker/deno/tests/third_party_tool_semantics_3235_test.ts` with three checks:
  - Both surfaces carry the rule's key phrases, and the two copies are identical once line wrapping is ignored.
  - The rule sits after fake-mirrors and before observe-real-tool.
  - The workflow-validator paragraph on both surfaces carries the link.
- Red without the change: removing the appended link sentence from `prompts/coding_guidelines/prompt.md` made the link test fail (2 passed, 1 failed). The file was then restored byte-identical.
- Pins checked against base: `deno task drift-pins-on-base origin/main <doc> <section> <phrase>...` ran on each of the 6 pinned phrases on both surfaces. Every phrase was reported `absent on base` (exit 0).
- `deno task test:unit` on the new test, `fake_mirrors_production_3224_test.ts` and `workflow_validator_contract_3021_test.ts`: 11 passed, 0 failed.
- `./quality.sh < /dev/null` on the code commit passed. The only check not run was config integration, which the gate skipped.
- No existing test was edited.

Branch outcomes: none added
