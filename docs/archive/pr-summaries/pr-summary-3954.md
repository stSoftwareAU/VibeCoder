## Summary

Closes #3954.

Generated summaries use durable project-version wording. The existing loader
also normalises unambiguous standalone root-manifest version pairs before the
existing PR-body reconciliation. The wording survives later workflow bumps
without predicting a final version or assuming a patch policy.

Dependencies, nested manifest ownership, migration and release evidence,
historical sections, code examples and release continuations retain their
exact values. Archived history is not rewritten on read.

## Spec

### Intent and Rationale

Avoid repeat review rounds caused solely by stale version pairs after a base
merge or workflow bump, while preserving meaningful exact release evidence.

### Essential Design Decisions

- Reuse the summary renderer, loader and body sync. The pure helper lives in
  `worker/deno/lib/pr_summary_facts.ts`; its production reader is the loader.
- New summaries state that the manifest was updated and the merged commit
  records the final version. Exact release evidence must name its final
  commit/release provenance. This does not infer a repository bump policy.
- Legacy normalisation recognises standalone stable-triplet pairs for root
  `VERSION`, `Cargo.toml`, `package.json` and `deno.json(c)` in Summary/Test Plan
  or unheaded prose. Ambiguous nested manifests and historical ancestors are
  preserved. The shared Markdown logical units protect wrapped statements.
- No additional refusal gate or model call is introduced.

### Undiscoverable Facts

None.

```mermaid
flowchart LR
  A[Archived summary] --> B[Existing loader: durable version wording]
  B --> C[Existing facts rendering and body reconciliation]
```

## Evidence

- #3954: Generate version-bump summaries that stay correct after CI auto-bumps.
- #3979: Render Branch outcomes once from existing facts and remove duplicate summary evidence maintenance.
- The loader regression failed against base production code. Preservation and
  heading-growth regressions also failed against the initial implementation.
- After integration with main `7bd0d619`, the three loader/facts/body-sync
  suites pass 101 tests with type checking enabled. The sole full gate passed
  at `6ed14e5b119e35e35a6de0e60d47cc0417e0171b` on 2026-10-18: parallel and
  serial unit passes, type checking, formatting, lint, completeness, documentation
  and security checks all passed. Optional local configuration integration was
  skipped because this workspace has no `.config.json`. Sixteen actual mutations of
  scope, ownership, logical units, heading growth and loader integration fail
  their named regression assertions.
- Independent corpus: 1,044 existing archived summaries; zero changes and zero
  non-idempotent results. None contains the supported literal pair, so this
  establishes preservation rather than rewrite recall. Synthetic positive
  fixtures cover root manifests and patch/minor/major values.
- Docs sweep — grep: "Project version wording", "Durable project-version";
  updated `CODING-STANDARDS.md`, `prompts/issue/prompt.md`,
  `prompts/pr_feedback/prompt.md` and `docs/workflows/issue-processing.md`;
  section: `docs/workflows/issue-processing.md` → "Durable project-version
  wording"; siblings: none — no existing set gained a member; Branch-outcomes ownership remains in #3979.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — After a base update and CI auto-bump, generated version wording remains accurate without a full implementation/review retry just to rewrite a literal pair. — evidence: loader and body-sync workflow-bump regressions. — reviewer: met
- **met** — Re-running generation/body sync is idempotent and preserves unrelated prose and meaningful version values. — evidence: repeat rendering, release/dependency and historical preservation fixtures. — reviewer: met
- **met** — Fixtures cover auto-bump, a different/no automatic bump policy, dependency pins and exact release evidence. — evidence: policy-neutral root-manifest fixtures, dependency pins and labelled release evidence. — reviewer: met
- **met** — No new general-purpose refusal gate, extra model call or parallel renderer is introduced for this fix. — evidence: existing loader and body sync reuse the existing summary renderer. — reviewer: met
- **met** — Required CI, release-version validation and independent review remain enforced. — evidence: existing gates and release validation are unchanged; separate Spec and Standards reviews completed. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Physical-line matching altered wrapped release provenance — evidence: `worker/deno/lib/pr_summary_facts.ts:82` — reason: fixed by matching complete logical statements.
- **violation** — Historical ancestors, indented code and nested dependencies could be rewritten — evidence: `worker/deno/lib/pr_summary_facts.ts:52` — reason: fixed with bounded heading ancestry, code exclusion and root-manifest ownership.
- **violation** — Heading whitespace matching was superlinear — evidence: `worker/deno/lib/pr_summary_facts.ts:56` — reason: fixed with separate linear scans; the old pattern fails the growth regression.
- **violation** — A redundant local-check caller had no observable regression — evidence: `worker/deno/lib/pr_summary_loader.ts:54` — reason: fixed in this diff by removing the redundant caller; the loader is the sole production reader.
- **violation** — Closing ATX markers and the PR Summary wrapper lacked regression sensitivity — evidence: `worker/deno/lib/pr_summary_facts.ts:62` — reason: fixed in this diff with positive heading fixtures and individually failing mutations, including quoted/thematic-break/sibling-heading controls.
- **clean** — Independent recheck found no remaining material code/test violation. Shared Markdown logic, Result contracts, assertion preservation, Australian English and existing merge protections were checked. Unrelated documentation formatting was reverted.

## Test Plan

- `worker/deno/tests/pr_summary_loader_test.ts` checks durable loading,
  idempotence, manifest/policy shapes and preservation of meaningful versions,
  indented/fenced/inline examples, historical ancestors and release continuations.
- `worker/deno/tests/pr_body_sync_test.ts` exercises the production body-sync
  path across simulated workflow version changes without another body edit.
- `worker/deno/tests/summary_facts_3396_test.ts` checks linear growth for hostile
  long heading whitespace in the existing serial timing suite.
- No existing assertion or expected value was removed or weakened.

<!-- vibe-branch-outcomes -->
