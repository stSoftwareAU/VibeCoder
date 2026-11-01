# Babysitter: skip repositories outside the App installation

## Summary

Keep one fleet configuration containing all monitored repositories. Setup and
runtime now use the selected App installation's complete repository list to
monitor its accessible subset, logging other repositories as skipped. An App
installed only on stSoftwareAU can therefore run while private TitlePage
repositories remain in the shared configuration.

## Spec

### Intent and Rationale

- The owner's App is installed only on stSoftwareAU. Removing TitlePage from
  fleet monitoring or maintaining a second configuration is not acceptable.

### Essential Design Decisions

- Share access discovery and full-name filtering between setup and runtime.
  Retain one selected installation; require an installation ID if ambiguous.
- Discover runtime access with a metadata-only token each pass, then scope the
  runner's write token to accessible configured repositories. Never pass the
  discovery credential to gh or Codex.
- Preserve explicit failure for inaccessible targeted repositories, no accessible
  configured repositories, incomplete discovery, and API/authentication errors.
- Retain existing App metadata format and fleet configuration. Access changes
  within a pass remain errors and are rediscovered on the next pass.

### Undiscoverable Facts

- The remote has main but no Develop branch, despite CONTRIBUTING naming Develop.

## Evidence

- Read and updated the babysitter workflow manual and the GitHub App manual's
  Before using it section: docs/workflows/fleet-pr-babysitter.md and
  docs/workflows/fleet-pr-babysitter-github-app.md.
- Targeted tests: 33 passed, including type checking, with Deno 2.9.5 and an
  external import map pointing to a local denoland/std checkout. JSR downloads
  are unavailable here. This is supplemental validation, not a pinned-dependency
  CI pass. Two pre-existing noImplicitReturns errors in that external source
  checkout were excluded from checking; repository checks were not weakened.
- The existing agent-launch test was run in its child mode with its fake runner
  token, because its subprocess does not inherit the external import map.
- The normal quality gate was attempted: lint, formatting, Mermaid and source
  guards passed. Tests, type checking and completeness checks could not load
  JSR dependencies. Markdownlint, Semgrep, Checkov and ruleset checks were
  unavailable. The full gate is not green.
- No UI change; no screenshots needed. No live App credentials were available
  for an end-to-end GitHub installation test.

## Test Plan

- fleet_babysitter_repositories_test.ts covers mixed owners, full-name matching,
  preserving configuration, explicit inaccessible targets, no access, ambiguous
  installation selection, pagination, malformed responses and API failures.
- Negative control: temporarily bypassed the access filter; the mixed-owner
  regression failed. Restored the filter and reran all targeted tests green.
- fleet_babysitter_app_test.ts covers metadata-only discovery and rediscovery
  after access changes; setup trust updates now also assert repos are preserved.
- Existing runner and setup tests passed in the targeted run. No existing test
  assertions were removed or weakened.
- Twinned rule: removed the single-owner rejection in both setup and runtime;
  both now use the same repository-selection helper.

## Merge verification

- Pinned-dependency CI and independent review are pending. This PR is a draft
  until those checks establish readiness.
