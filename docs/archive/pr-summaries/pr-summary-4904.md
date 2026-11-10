## Summary

Workflow-sync issues for the Dependabot-config specs (`npm-dependency-updates`,
`java-dependency-updates`, `java-gradle-dependency-updates`) now name
`.github/dependabot.yml` instead of `.github/workflows/<file>`. The auditor also
reads that file, so a correctly configured repository is detected as present.

Closes #4904.

## Spec

### Intent and Rationale

- Dependabot reads its config only from `.github/dependabot.yml`; the old body
  sent implementers to `.github/workflows/`, where it is an invalid workflow and
  never runs.
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
- A `dependabotConfig` spec carries `dependabotConfigPatternGroups`, used in
  place of `detectionPatternGroups` when matching `.github/dependabot.yml`
  (workflow files keep the tool-name patterns). The config is matched only on
  its `package-ecosystem: <name>` entry (plain, double- and single-quoted), so
  a header comment, docs URL or default-template text saying "Dependabot"
  cannot satisfy the npm spec for a config that covers only `github-actions`,
  `pip` or `docker`. The npm spec's old tool-name group is unchanged. This
  also keeps `purge_stale_workflow_issues.ts`, which closes a request when its
  spec id is in `audit.present`, from closing a genuinely missing npm request.

### Undiscoverable Facts

- None.

## Evidence

Backend only; no UI. Tests: `worker/deno/tests/setup_workflow_sync_test.ts`,
`worker/deno/tests/workflow_auditor_test.ts`,
`worker/deno/tests/workflow_template_audit_conformance_test.ts`.

## Test Plan

- `setup_workflow_sync_test.ts`: the flagged ids are exactly the three; each
  Dependabot body names `.github/dependabot.yml`, has no `.github/workflows/`,
  says to merge into an existing `updates` list, and carries neither the
  workflow-file checks nor the pins rule; a normal workflow spec body still
  names `.github/workflows/<file>`.
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
  `npm-dependency-updates` missing; quoted `"npm"` / `'npm'` entries; a
  workflow naming `renovate` still satisfies npm with `foundIn`
  `.github/workflows/deps.yml`; and `foundIn` pinned on a partial match.
  Red checks: config applied to every spec, 1 failed; `-H` dropped, 1 failed;
  config patterns falling back to the tool-name group, 4 failed.
- Red checks: `issueBody` ignoring the flag, 3 failed; auditor skipping the
  config fetch, 4 failed; flag dropped from the Gradle spec, 3 failed; npm
  patterns removed, the hand-written-config test failed. Each was restored.
- Existing tests: the shared `mockRunner` returns a 404 for
  `contents/.github/dependabot.*`; no assertion was removed or weakened.
- Callers of the changed `foundIn` / `issueBodyPartial`: `workflow_sync.ts`
  (`issueBodyPartial` via `partialFilePath`) and
  `purge_stale_workflow_issues.ts` (spec ids only). The three specs have one
  detection group, so a partial match is unreachable for them.
- Seven workflow test files: 245 passed, 0 failed.
- Docs updated: `docs/EXTENDING.md` (workflow-sync section) and the
  `workflow-sync` row in `docs/SETUP.md`.
- `./quality.sh`: lint, type check, fmt, markdownlint and semgrep passed. The
  deno unit step failed on one test, `merge_fallback_issue_test.ts` ("routes the
  label creation through the caller's gh"), which fails identically on a clean
  `origin/main`. It is unrelated to this change and was left alone.

## Not done

- The partial-match prose for Dependabot specs still says "workflow" (only the
  path and the pins/checks omissions changed); it is unreachable today.
