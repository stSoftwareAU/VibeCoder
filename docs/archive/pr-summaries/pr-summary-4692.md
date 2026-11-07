## Summary

The `cargo-upgrade` and `deno-outdated` templates now render
`persist-credentials: false` on their `actions/checkout`, and the
checkout-persist-credentials pre-filer no longer treats
`peter-evans/create-pull-request` as a reason to skip a job. The two docs that
repeated the false premise are corrected. Closes #4692.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- `peter-evans/create-pull-request` configures its own HTTPS credential from its
  `token` / `branch-token` input (default `github.token`) before it touches the
  remote, and both templates already pass `token:`. The checkout credential was
  therefore left in `.git/config` for later third-party steps (including
  `cargo install cargo-edit`) with no purpose.
- The repository's own `.github/workflows/cargo-upgrade.yml` already carries
  `persist-credentials: false` (PR #4686); the templates now match it.

### Essential Design Decisions

- Only `peter-evans/create-pull-request` is removed from
  `CREDENTIAL_USING_ACTIONS`. The other entries (`ad-m/github-push-action`,
  `stefanzweifel/git-auto-commit-action`, …) are untouched: the issue gives
  evidence for this action only, and I did not verify the others.
- The templates reuse the shared `CHECKOUT_NO_CREDENTIALS` block. Its comment
  now describes the unused checkout credential rather than claiming nothing
  pushes, which also holds for the dependency-update jobs.
- The gate label, issue and workflow-setup prompts, audit documentation and
  finding text describe the need for the checkout credential, not pushing in
  general. `create-pull-request` uses its own token and is not an exemption.

### Undiscoverable Facts

- The claim about `create-pull-request` comes from the issue (its
  `src/create-pull-request.ts`, `configureToken(inputs.branchToken)` at the
  pinned SHA); I did not re-read the action source in this run.

## Evidence

Backend templates, scanner and docs only; no UI. Changed:
`worker/deno/lib/workflow_definitions.ts`,
`worker/deno/lib/checkout_persist_credentials_scanner.ts`, `docs/EXTENDING.md`,
`docs/GITHUB-ACTIONS-AUDIT-SCAN.md`, `worker/deno/lib/workflow_file_checks.ts`,
`prompts/issue/prompt.md` and `prompts/workflow_setup/prompt.md`. Doc section read in full: EXTENDING "Every
emitted template now carries" list and the audit-scan
"checkout-persist-credentials" signal table.

## Test Plan

- Added to `worker/deno/tests/checkout_persist_credentials_scanner_test.ts`:
  "scan - a job using create-pull-request with a persisting checkout is
  flagged", "scan - a job using create-pull-request with persist-credentials:
  false is not flagged", and "jobNeedsCheckoutCredentials - create-pull-request
  alone is not a credential signal" (with an `ad-m/github-push-action` positive
  control). Red with `peter-evans/create-pull-request` re-added to
  `CREDENTIAL_USING_ACTIONS`: the flagged and the not-a-signal tests fail.
- Added to `worker/deno/tests/workflow_definitions_test.ts`: "dependency-update
  templates do not persist the checkout credential (Issue #4692)" — parses the
  `cargo-upgrade` and `deno-outdated` templates, asserts the checkout's
  `persist-credentials` is `false` and the create-pull-request step still has a
  `token:`, and neither rendered template says nothing pushes. Red with the `${CHECKOUT_NO_CREDENTIALS}` line removed from
  `cargo-upgrade`; the existing conformance test
  `worker/deno/tests/workflow_template_audit_conformance_test.ts` ("every
  `actions/checkout` sets `persist-credentials: false` unless the job needs the checkout credential")
  also goes red there, reporting `BP-PERSIST-CREDS-cargo-upgrade-upgrade-0`.
- No existing assertion was removed or edited.
- Review fix: the new comment assertion failed before the shared comment was
  reworded. The workflow definitions, scanner and template conformance suites
  passed together (117 tests); the scanner test also checks finding wording.
- The review replaced the obsolete claim that all pushing jobs need checkout
  credentials; jobs that use that credential remain exempt. Coverage:
  `worker/deno/tests/checkout_persist_credentials_scanner_test.ts::scan - a job using create-pull-request with a persisting checkout is flagged`
  and `worker/deno/tests/workflow_definitions_test.ts::workflow_definitions - dependency-update templates do not persist the checkout credential (Issue #4692)`.
- Run: `deno task test:unit` over the 34 test files that reference the scanner,
  `workflow_definitions`, `workflow_file_checks` or the audit template — 794
  passed, 0 failed. `deno fmt --check` and `deno lint` clean on the four changed
  `.ts` files.
- `./quality.sh` ran 500 s in the foreground and was stopped by `timeout` after
  the markdownlint, mermaid, semgrep and release-tag ruleset stages had passed;
  it gave no overall verdict.

<!-- vibe-quality-gate-skipped required="186s" remaining="n/a" -->

The full gate gave no verdict (timed out); the targeted checks above were run
instead and the worker runs the gate again before the PR is raised.
