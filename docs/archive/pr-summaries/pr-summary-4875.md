## Summary

`docs/TROUBLESHOOTING.md` no longer says CI's copy on the PR covered a
budget-skipped quality gate. The passage on the
`<!-- vibe-quality-gate-skipped … -->` note now says the full gate did not run
in that agent session, that the note does not by itself prove any other check
ran, that the agent's prompt — not the note — names the path's checks and asks
the agent to name, in the note, the checks it ran, and that coverage depends on
the path (as `docs/CONFIGURATION.md` already states). Closes #4875.

## Spec

### Intent and Rationale

- Issue #4777 removed the false "CI covers it" guarantee from the agent text,
  `CODING-STANDARDS.md` and `docs/CONFIGURATION.md` but missed this operator
  doc, so it contradicted `docs/CONFIGURATION.md`. This is a documentation
  correction only; no gate or code changes.

### Essential Design Decisions

- The passage points at the per-path guarantee in `docs/CONFIGURATION.md` ("The
  full gate is conditional on the budget left") and restates only the naming
  split: the agent's prompt names the path's checks and asks the agent to name,
  in the note, the checks it ran — matching `docs/CONFIGURATION.md` ("The skip
  record names that path's checks and tells the agent to name the checks it
  ran") and `buildQualityGateBudgetLines`. It does not claim a worker-run full
  gate for every repair: only issue completion is named as running one, a CI
  fix is described as attempting it only when Claude leaves uncommitted changes
  (then configured pre-flight, possibly nothing), PR feedback and spelling
  fixes as running no full gate, and a custom PR prompt as relying on the
  agent's pre-push hook.

### Undiscoverable Facts

- None.

## Evidence

Documentation-only change. Sources read to check the new wording:
`docs/CONFIGURATION.md` (section "The full gate is conditional on the budget
left", the paragraph beginning "The push guarantee follows the flow") for the
per-path guarantee and its "skip record names that path's checks" sentence, and
`worker/deno/lib/quality_gate_budget.ts` (`formatQualityGateSkipNote` for the
note the PR carries, `buildQualityGateBudgetLines` for the prompt record that
names the path's checks and asks the agent to name what it ran). Greps for
`CI's copy` and `covered it` across `docs/` (excluding `docs/archive/`),
`README.md`, `CODING-STANDARDS.md` and `prompts/` found no other stale claim.
The only other files mentioning the skip note (`docs/CONFIGURATION.md`,
`CODING-STANDARDS.md`) were read and are consistent.

## Test Plan

- No test added: a prose correction that pins no code behaviour, and the issue
  asks for no new gate.
- `deno task test:unit tests/cross_file_anchors_test.ts tests/deno_path_docs_test.ts tests/deadline_model_docs_check_test.ts`
  passed — 41 tests, 0 failed (the new relative link and its anchor resolve).
- `./quality.sh` passes end-to-end: `deno fmt --check`, `deno lint`, `deno type
  check`, the full `deno tests` unit suite, `markdownlint` (0 issues across 244
  files), `mermaid` and `semgrep`. `config integration` is SKIPPED (no
  `.config.json`) and `checkov` is SKIPPED (no checkov binary or container
  runtime); result PASSED (with skipped checks). The five
  `pr_maintenance_command_test.ts` failures the earlier
  revision recorded (merge-queue and #4613 base-owner cases) no longer
  reproduce on the merged tree — that file passes 28 tests.
- Docs sweep — grep: `CI's copy`, `covered it`, `vibe-quality-gate-skipped`;
  section: TROUBLESHOOTING.md run-budget notice passage and CONFIGURATION.md
  "The full gate is conditional on the budget left" read; siblings: none — no
  set gained a member.
