## Summary

Workflow-sync issues for the Dependabot-config specs (`npm-dependency-updates`,
`java-dependency-updates`, `java-gradle-dependency-updates`) now name
`.github/dependabot.yml` instead of `.github/workflows/<file>`. The auditor also
reads that file, so a correctly configured repository is detected as present.

Closes #4904.

## Spec

### Intent and Rationale

- Dependabot reads its config from `.github/dependabot.yml` (or `.yaml`); the
  old body sent implementers to `.github/workflows/`, where it is an invalid
  workflow and never runs.
- A `dependabotConfig` flag on `WorkflowSpec` marks the three specs, matching
  the conformance test's `NON_WORKFLOW_SPEC_IDS`.

### Essential Design Decisions

- For a `dependabotConfig` spec, `foundIn` in `WorkflowMatch` / `PartialMatch`
  is a full repo-relative path (a workflow file or the Dependabot config); every
  other spec keeps the bare workflow filename. The purge step reads only spec
  ids, so it is unchanged.
- The Dependabot config is fetched only when a required spec is a Dependabot
  config. A 404 means absent; any other failure fails the audit (the #1829
  rule), so a transient fault cannot raise a spurious request.
- The body names both accepted config paths — `.github/dependabot.yml` and the
  `.github/dependabot.yaml` fallback (via the shared `DEPENDABOT_CONFIG_YAML_PATH`
  constant the auditor also uses) — in its merge instruction, so an implementer
  with an existing `.yaml` file merges into it rather than creating a second
  config.
- A `dependabotConfig` spec carries `dependabotConfigPatternGroups`, used in
  place of `detectionPatternGroups` when matching `.github/dependabot.yml`
  (workflow files keep the tool-name patterns). The config is matched only on
  its `package-ecosystem: <name>` entry (plain, double- and single-quoted), so a
  header comment, docs URL or default-template text saying "Dependabot" cannot
  satisfy the npm spec for a config that covers only `github-actions`, `pip` or
  `docker`. The npm spec's old tool-name group is unchanged. This also keeps
  `purge_stale_workflow_issues.ts`, which closes a request when its spec id is
  in `audit.present`, from closing a genuinely missing npm request.

### Undiscoverable Facts

- None.

## Evidence

Backend only; no UI. Tests: `worker/deno/tests/setup_workflow_sync_test.ts`,
`worker/deno/tests/workflow_auditor_test.ts`,
`worker/deno/tests/workflow_template_audit_conformance_test.ts`.

## Test Plan

- `setup_workflow_sync_test.ts`: the flagged ids are exactly the three; each
  Dependabot body asserts the code-generated path (the **Suggested filename:**
  line and the *save the template as* line both use `DEPENDABOT_CONFIG_PATH`, so
  the template's own header comment can no longer satisfy the check), names
  `.github/dependabot.yaml` in the merge instruction, has no
  `.github/workflows/`, says to merge into that file's existing `updates` list,
  and carries neither the workflow-file checks nor the pins rule; a normal
  workflow spec body still names `.github/workflows/<file>`.
- `workflow_template_audit_conformance_test.ts`: the `dependabotConfig` ids
  equal `NON_WORKFLOW_SPEC_IDS`.
- `workflow_auditor_test.ts`: config present, hand-written npm config with no
  tool-name mention, both names 404 (missing), non-404 failure (`ok: false`),
  local-path read from a temp dir, and no config fetch for a repo with no
  Dependabot spec.
- Mutation and verifier follow-ups in `workflow_auditor_test.ts`: the exact
  `gh api … -H Accept: application/vnd.github.raw+json` command; the non-404
  error text; a thrown `Error` and a thrown string; `dependabot.yaml` fallback;
  the config not satisfying a non-Dependabot spec (`gitleaks` in the file); a
  `github-actions`-only config that says "Dependabot" leaves
  `npm-dependency-updates` missing; quoted `"npm"` / `'npm'` entries; a workflow
  naming `renovate` still satisfies npm with `foundIn`
  `.github/workflows/deps.yml`; and `foundIn` pinned on a partial match. Red
  checks: config applied to every spec, 1 failed; `-H` dropped, 1 failed; config
  patterns falling back to the tool-name group, 4 failed.
- Maven and Gradle config coverage in `workflow_auditor_test.ts`, pinning the
  `dependabotConfigPatternGroups` of `java-dependency-updates` and
  `java-gradle-dependency-updates`: a `package-ecosystem: maven`-only
  `.github/dependabot.yml` for a Node+Java repo (`package.json` + `pom.xml`)
  makes `java-dependency-updates` present with `foundIn` `.github/dependabot.yml`
  and leaves `npm-dependency-updates` missing; the reverse (npm-only) leaves
  Maven missing; with `rootFiles: ["build.gradle"]`, a maven-only config leaves
  `java-gradle-dependency-updates` missing and a `package-ecosystem: gradle`
  entry makes it present; quoted `"maven"` / `'maven'` and `"gradle"` /
  `'gradle'` entries are also present. These kill the three surviving
  `workflow_definitions.ts` mutations (each deleted `package-ecosystem: maven`
  array element in its quote form). The one remaining survivor is recorded
  exempt below.
- Mutation exempt (untestable): `worker/deno/lib/workflow_auditor.ts:316` —
  deleted object property `ok` — exempt (untestable): `auditRepoWorkflows`
  re-wraps a failed `fetchDependabotConfig` as `{ ok: false, error:
  configResult.error }`, so deleting the inner `ok: false` still leaves
  `!configResult.ok` true and the public `Result` identical; no output-level
  test can tell it apart.
- Red checks: `issueBody` ignoring the flag, 3 failed; auditor skipping the
  config fetch, 4 failed; flag dropped from the Gradle spec, 3 failed; npm
  patterns removed, the hand-written-config test failed. Each was restored.
- Existing tests: the shared `mockRunner` returns a 404 for
  `contents/.github/dependabot.*`; no assertion was removed or weakened.
- Callers of the changed `foundIn` / `issueBodyPartial`: `workflow_sync.ts`
  (`issueBodyPartial` via `partialFilePath`) and
  `purge_stale_workflow_issues.ts` (spec ids only). The three specs have one
  detection group, so a partial match is unreachable for them.
- Seven workflow test files (the three changed plus `workflow_definitions_test.ts`,
  `workflow_file_checks_test.ts`, `workflow_auditor_local_path_test.ts` and
  `workflow_auditor_local_path_fallback_test.ts`): 245 passed, 0 failed.
- Docs updated: `docs/EXTENDING.md` (workflow-sync section — the
  Dependabot-config body carries neither the pins rule nor the workflow-file
  checks, the verbatim/pins/checks bullets now name workflow bodies only, and
  the `How to apply` diagram label matches) and the `workflow-sync` row in
  `docs/SETUP.md` (the Dependabot-config sentence now says these specs carry
  neither the pins rule nor the workflow-file checks). The
  `workflowCheckSection` doc comment in `workflow_sync.ts` now says a check
  reaches every *workflow* issue body.
- `./quality.sh`: lint, type check, fmt, markdownlint and semgrep passed. The
  deno unit step failed on one test, `merge_fallback_issue_test.ts` ("routes the
  label creation through the caller's gh"), which fails identically on a clean
  `origin/main`. It is unrelated to this change and was left alone.

## Not done

- The partial-match prose for Dependabot specs still says "workflow" (only the
  path and the pins/checks omissions changed); it is unreachable today.
