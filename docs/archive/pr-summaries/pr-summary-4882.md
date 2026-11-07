## Summary

The `java-dependency-updates` spec was handed to Gradle-only repositories but its Dependabot template only carried `package-ecosystem: maven`, which reads `pom.xml` only. The spec is now split by build system, so a Gradle-only repository is given a `gradle` entry. Closes #4882.

## Spec

### Intent and Rationale

- Dependabot's `maven` ecosystem never reads `build.gradle`/`build.gradle.kts`, so one template cannot serve both; two specs let each key to its own root file (the issue's first suggested option).
- Detection patterns are ecosystem-specific (`package-ecosystem: maven|gradle`) rather than the bare word `dependabot`, so a Maven-only config can no longer count the Gradle spec as present.

### Essential Design Decisions

- `java-dependency-updates` keeps its id and becomes the Maven variant (root `pom.xml`), so existing dedup tags stay stable; only its display name changes to "Java Maven Dependency Updates".
- New `java-gradle-dependency-updates` requires a root `build.gradle` or `build.gradle.kts`. A repository with both build files is offered both specs, and the docs say both `updates` entries belong in the one `.github/dependabot.yml`.
- Gradle-only repositories with an open "Java Dependency Updates" request for the old id are reconciled as not applicable by the existing root-marker closure; the new Gradle spec is filed for them.

### Undiscoverable Facts

- `auditRepoWorkflows` reads only `.github/workflows/*.yml`, never `.github/dependabot.yml`, so detection patterns match only when Dependabot text appears in a workflow file. That is existing behaviour and is unchanged here.

## Evidence

Backend-only change; no UI files. Tests below were run on the head.

## Test Plan

- `worker/deno/tests/workflow_definitions_test.ts` — Java specs include the Gradle id; new test "Java dependency update specs are split by ecosystem" checks each template's ecosystem, the exact root markers and detection groups.
- `worker/deno/tests/workflow_auditor_test.ts` — new tests for `build.gradle` only, `build.gradle.kts` only, `pom.xml` only, and a workflow containing only `package-ecosystem: maven` not satisfying the Gradle spec; two existing expectations updated for the split (notApplicable lists now include both Java update ids where no root file exists).
- `worker/deno/tests/workflow_template_audit_conformance_test.ts` — the Gradle id added to `NON_WORKFLOW_SPEC_IDS` (it is a Dependabot config with no `jobs:`).
- Result: `deno test` on the definitions, auditor and conformance files: 125 passed, 0 failed.
- Red checks: adding `pom.xml` to the Gradle root markers made 2 tests fail ("Maven pom.xml alone files only the Maven Dependabot spec", "split by ecosystem"); changing the Gradle template to `maven` made "split by ecosystem" fail. Both restored.
- Docs: `docs/EXTENDING.md` (section on root markers for templates) updated; README and `docs/` (excluding archive) grepped for "Java dependency updates"/`java-dependency-updates` with no other stale hit.
- Callers checked: `getWorkflowsForLanguagesAndVisibility`/`auditRepoWorkflows` filter by `appliesTo` and `rootProjectMarkers` generically, so the new spec needs no caller change.
- Full `./quality.sh` result: see the final message of this run.
