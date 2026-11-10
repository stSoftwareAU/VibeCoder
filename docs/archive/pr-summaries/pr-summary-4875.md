## Summary

`docs/TROUBLESHOOTING.md` no longer says CI's copy on the PR covered a
budget-skipped quality gate. The passage on the `<!-- vibe-quality-gate-skipped … -->`
note now says the full gate did not run in that agent session, that the note
does not by itself prove any other check ran, and that coverage depends on the
path (as `docs/CONFIGURATION.md` already states). Closes #4875.

## Spec

### Intent and Rationale

- Issue #4777 removed the false "CI covers it" guarantee from the agent text,
  `CODING-STANDARDS.md` and `docs/CONFIGURATION.md` but missed this operator
  doc, so it contradicted `docs/CONFIGURATION.md`. This is a documentation
  correction only; no gate or code changes.

### Essential Design Decisions

- The passage points at the per-path guarantee in `docs/CONFIGURATION.md`
  ("The full gate is conditional on the budget left") instead of restating it,
  so the two cannot drift. It does not claim a worker-run full gate for every
  repair: only issue completion is named as running one.

### Undiscoverable Facts

- None.

## Evidence

Documentation-only change. Sources read to check the new wording:
`docs/CONFIGURATION.md` (section "The full gate is conditional on the budget
left", the paragraph beginning "The push guarantee follows the flow") for the
per-path guarantee, and `worker/deno/lib/repo_config.ts` (`buildQualityInstructions`)
for the skip record naming each path's checks. Greps for `CI's copy` and
`covered it` across `docs/` (excluding `docs/archive/`), `README.md`,
`CODING-STANDARDS.md` and `prompts/` found no other stale claim. The only other
files mentioning the skip note (`docs/CONFIGURATION.md`, `CODING-STANDARDS.md`)
were read and are consistent.

## Test Plan

- No test added: a prose correction that pins no code behaviour, and the issue
  asks for no new gate.
- `deno task test:unit tests/cross_file_anchors_test.ts tests/deno_path_docs_test.ts tests/deadline_model_docs_check_test.ts`
  passed (the new relative link and its anchor resolve).
- Docs sweep — grep: `CI's copy`, `covered it`, `vibe-quality-gate-skipped`; section: TROUBLESHOOTING.md run-budget notice passage and CONFIGURATION.md "The full gate is conditional on the budget left" read; siblings: none — no set gained a member.
