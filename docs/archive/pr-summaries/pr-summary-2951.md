# PR Summary — Issue #2951

## Summary

Closes #2951

Fleet PRs kept treating "the label is present" or "my add call succeeded" as
proof that automation owned a label. They then removed labels that a human or
another lane had applied (#2938, #2949, #2866). This PR adds that rule to the
standards and to the injected guidelines, so the code-writing worker sees it
on every run.

- **Standards:** `CODING-STANDARDS.md` gains a new
  `## Automation and Shared GitHub State` section (after "Never Fail Silently").
  It contains:
  - the **Remove only what you can prove you added** rule;
  - how to record provenance when the label is added;
  - a test requirement: the label already exists before the add, and the test
    asserts it is never removed;
  - the three past regressions as examples.
- **Prompt template:** `prompts/coding_guidelines/prompt.md` is injected into
  every run (issue, PR feedback, CI fix) that can touch labels. The end of its
  **Human Escalation** section, which already governs labels, gains a short
  copy of the rule plus a pointer to the full section.

- [x] Add the rule to `CODING-STANDARDS.md`
- [x] Reference it from the label-touching prompt template
- [x] Targeted prompt and standards drift tests green
- [x] Full quality gate

## Spec

### Intent and Rationale

- Automation must only remove or release shared GitHub state (labels) that it
  can prove it added. An idempotent add succeeding is not proof.
- The goal is that future review rounds stop raising "removed a label it did
  not apply" findings.

### Essential Design Decisions

- The full rule lives in `CODING-STANDARDS.md`, the single source of truth
  that `AGENTS.md` points to.
- The injected guidelines get a short inline copy rather than a bare link,
  because that template is also copied into other repositories, which have no
  `CODING-STANDARDS.md`.
- It goes in the **Human Escalation** section because that section already
  holds the label rules.

### Undiscoverable Facts

- `gh issue edit --add-label` and `gh pr edit --add-label` succeed whether or
  not the label was already present. That is why a successful add proves
  nothing about ownership.

## Evidence

This change only touches docs and prompts; there is no runtime or visual
surface. I checked it as follows:

- I read the final diff of both files. The rule text matches the wording the
  issue proposed, in Australian English.
- `deno task test:unit` passed for `coding_guidelines_twin_drift_test.ts`,
  `coding_guidelines_layers_2574_test.ts`, `coding_guidelines_overlay_test.ts`,
  `reserved_label_prompt_drift_test.ts`, `prompt_hash_test.ts`,
  `prompt_stable_prefix_test.ts`, `prompt_manager_test.ts`,
  `label_denylist_union_test.ts`, `question_escalation_carveout_test.ts` and
  `agents_md_pointer_anchors_test.ts` (143 passed, 0 failed).

## Test Plan

- [x] Targeted prompt and standards drift tests (above)
- [x] `./quality.sh < /dev/null`

No new test was added. The change is guidance text, and the issue's
verification is behavioural: later review rounds stop raising these findings.

## Final branch state

The branch contains two changes: the new standards section and the short copy
in `prompts/coding_guidelines/prompt.md`, plus this summary. No code, tests or
configuration changed.
