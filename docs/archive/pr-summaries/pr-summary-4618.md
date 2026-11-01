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

- The owner's App is installed on stSoftwareAU only, while the shared fleet
  configuration also lists private TitlePage repositories.

## Evidence

- Read and updated the babysitter workflow manual and the GitHub App manual's
  Before using it section: docs/workflows/fleet-pr-babysitter.md and
  docs/workflows/fleet-pr-babysitter-github-app.md.
- Pinned-dependency run on a fleet Mac after merging main:
  - `fleet_babysitter_repositories_test.ts`, `fleet_babysitter_app_test.ts`,
    `fleet_pr_babysitter_test.ts`, `fleet_pr_babysitter_setup_test.ts`: 34
    passed, 0 failed.
  - `deno check` on both commands, `deno lint`, `deno fmt --check`: clean.
  - `deno task check:manifests`: passed once the new module gained its sweep
    slice (`docs/audits/lib-sweep-coverage/top-up-4618.json`).
  - markdownlint-cli2 on the changed docs: 0 errors.
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

- CI: pending on this PR.
