## Summary

Removed `googleapis/release-please-action` and its old name `google-github-actions/release-please-action` from `CREDENTIAL_USING_ACTIONS`, so a release-please job whose `actions/checkout` persists credentials is now flagged (`BP-PERSIST-CREDS-…`). Closes #4869.

## Spec

### Intent and Rationale

- release-please-action works through the GitHub API with its own `token` input and never runs git, so it does not use the checkout credential; treating it as a credential signal hid a real hardening gap (same premise #4692 fixed for `create-pull-request`).

### Essential Design Decisions

- Only the two release-please coordinates were removed. The other entries were not re-audited and `ad-m/github-push-action` (raised in an issue comment from an untrusted author, with a different fix: signal only when `ssh: true`) is left as is, to stay in scope.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. Behaviour is covered by `worker/deno/tests/checkout_persist_credentials_scanner_test.ts`. The release-please behaviour is taken from the issue's description of the action's `src/index.ts`; I did not re-read the upstream source.

## Test Plan

- Added `scan - a job using release-please-action with a persisting checkout is flagged` (both coordinates) and `scan - a job using release-please-action with persist-credentials: false is not flagged` in `worker/deno/tests/checkout_persist_credentials_scanner_test.ts`.
- Extended `jobNeedsCheckoutCredentials - create-pull-request alone is not a credential signal` with `false` assertions for both release-please coordinates (existing assertions kept).
- Red check: with the scanner restored to the base version, the flagged test and the extended test fail (26 passed, 2 failed); with the fix, all 28 pass.
- Docs: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` now names release-please beside `create-pull-request` as not a signal.
- `deno fmt`, `deno lint` and the scanner unit test file passed.
- <!-- vibe-quality-gate-skipped reason="full ./quality.sh did not complete within bounded time in an earlier run on this repo; targeted checks passed; the worker re-runs the gate before the PR" -->
