## Summary

The `npm-dependency-updates` workflow detection group no longer matches text the
fleet's own templates carry. Bare `ncu` (a substring of `concurrency`) and bare
`dependabot` (in gitleaks template comments) are replaced by specific patterns,
so a Node repository with only fleet workflows is reported as missing NPM
Dependency Updates. Version bump: `VERSION` is not changed by this PR. Closes
#4903.

## Spec

### Intent and Rationale

- The auditor matches patterns as case-insensitive substrings of every workflow
  file; `ncu` and `dependabot` matched the `concurrency:` block and template
  comments, hiding the missing update automation.
- Following the Java spec's precedent (#4900), the group now lists invocation-
  or configuration-shaped patterns.

### Essential Design Decisions

- Workflow-file patterns are now `package-ecosystem: npm` (plain, double- and
  single-quoted), `renovate`, `npm-check-updates`, `npx ncu`, `ncu -u` and
  `ncu --upgrade`.
- `renovate` is kept unchanged: the issue does not name it as defective, no
  fleet template contains it, and the Java specs keep it. A bare mention in a
  workflow still counts, which an existing test pins.
- No config-file discovery was added; #4904 (closed) already reads
  `.github/dependabot.yml`, and `dependabotConfigPatternGroups` is untouched.

### Undiscoverable Facts

- #4904, which the issue depends on, is closed, so the dependency gate is clear.

## Evidence

Backend-only change; no UI files touched. Tests are in
`worker/deno/tests/workflow_auditor_test.ts` (eleven tests tagged `#4903`).

## Test Plan

- Added in `worker/deno/tests/workflow_auditor_test.ts`: the rendered gitleaks
  template alone leaves npm missing (fixture asserted to contain `concurrency`
  and `dependabot`); the eslint-quality template alone leaves it missing; an npm
  `dependabot.yml` plus the gitleaks workflow is present at
  `.github/dependabot.yml`; `npx npm-check-updates -u` in a workflow is present;
  `npx ncu`, `ncu -u`, `ncu --upgrade` are each present; a
  `# managed by dependabot` comment with a concurrency block stays missing.
- Mutation follow-up: three tests (one per quoting form) put a
  `# package-ecosystem: npm` / `"npm"` / `'npm'` line in a workflow file and
  assert npm is present, `foundIn` the workflow. Deleting each of the three
  `package-ecosystem` entries from `detectionPatternGroups`
  (`workflow_definitions.ts:738-740`) turns exactly that test red; the config
  tests alone could not, because `dependabotConfigPatternGroups` repeats them.
- Red check: restoring the old group turned the gitleaks, eslint,
  combined-config and `# managed by dependabot` tests red (4 failed, 61 passed).
  The `ncu` invocation tests stay green under the old group (bare `ncu` matched
  them), so they guard the new patterns rather than the fix.
- No existing assertion removed or edited. The existing renovate workflow test
  still passes.
- `deno task test:unit` on the workflow auditor, definitions and template
  conformance tests: 159 passed. `./quality.sh < /dev/null`: passed (config
  integration and checkov skipped by the gate itself).
- Callers checked: `auditRepoWorkflows` is the only consumer of
  `detectionPatternGroups`; the other specs are untouched. Twinned rule: the
  Java specs keep their own patterns (already fixed in #4900); no other npm-spec
  copy found.
- Docs: grep of README, `docs/` (excluding archive) and source for
  `npm-check-updates` and `ncu` found no prose naming these patterns.
