# PR Summary — Issue #2952

Closes #2952

## Summary

The issue prompt's docs step only said "if your changes affect usage", so
fleet PRs that removed or changed behaviour left `docs/` manuals stale. Step 3
of `prompts/issue/prompt.md` and the `pr_feedback` prompt now say that any
change which adds, changes or removes behaviour, a field, a UI element or a
setting owes a docs change. Before committing, the run greps `README.md`,
`docs/` (excluding `docs/archive/`) and every `*/README.md` for each removed or
changed name and for the removed user-visible wording, then fixes every hit.
Every PR summary now carries a one-line **Docs sweep** record.

- [x] Issue prompt step 3: broadened trigger, grep sweep, link to **A Code
      Change Owes a Docs Change**
- [x] Issue prompt PR Summary File: **Docs sweep** line under Evidence, with
      an example
- [x] `pr_feedback` prompt: the same sweep for fixes, and a refreshed
      **Docs sweep** line
- [x] `CODING-STANDARDS.md` and `docs/PROMPTS.md` describe the new contract
- [x] Prompt contract test

## Spec

### Intent and Rationale

- Behaviour that is removed leaves no new name to document, so the sweep greps
  for the **old** names and the old user-visible wording, not just new ones.
- The **Docs sweep** line makes the sweep auditable in review, and `no hits` is
  a valid record.

### Essential Design Decisions

- The standard is cited by section name ("in `CODING-STANDARDS.md`, restated in
  the `<coding_guidelines>`") rather than as a relative link. The prompt runs
  fleet-wide, and other repos may have no `CODING-STANDARDS.md`.
- `docs/archive/` is excluded from the sweep because historical PR summaries
  rightly describe old behaviour.
- The `pr_feedback` paragraph states that these docs are part of the fix. This
  keeps its existing "no unrelated documentation" scope rule from blocking the
  sweep.

### Undiscoverable Facts

None.

## Evidence

Prompt-only change, so there is no UI to screenshot. The new contract test pins
the wording in both prompts.

**Docs sweep** — grep: "if your changes affect usage", "Update README.md or
other documentation", "Docs sweep", "Undiscoverable Facts"; updated:
`docs/PROMPTS.md`, `CODING-STANDARDS.md`

## Test Plan

- New: `worker/deno/tests/prompt_docs_sweep_2952_test.ts` checks the issue
  prompt's step 3 sweep wording, its **Docs sweep** summary line, and the
  `pr_feedback` sweep paragraph.
- Regression tests: the issue prompt v38/v39 contract tests, the
  `pr_feedback_finding_resolution_2917` test, the `coding_guidelines` and
  twin-drift tests, and the docs-drift and standards tests. All pass.
- Full gate: `./quality.sh`.
