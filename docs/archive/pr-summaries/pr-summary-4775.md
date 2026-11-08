## Summary

The babysitter repair prompt now identifies the PR's archived summary from its
issue branch and explains that summaries brought in by a base merge belong to
the PRs that created them. Branches without an issue number get generic summary
guidance without an example filename. Closes #4775.

## Spec

### Intent and Rationale

- A base merge can make another PR's summary visible in the repair diff; naming
  the repair PR's summary prevents edits to that foreign record.

### Essential Design Decisions

- Use the existing `issueNumberFromBranch` helper. A `null` result keeps the
  summary guidance generic and omits a filename.
- Keep the existing instruction to rewrite stale claims, counts and results in
  the same repair rather than append a note.

### Undiscoverable Facts

- The 14-day review-log observation is post-merge verification and has not yet
  run.

## Evidence

- Backend prompt and documentation change; no visual surface, dependency or
  lockfile changed.
- The manual section read was “Repair flow” in
  `docs/workflows/fleet-pr-babysitter.md`; that file was updated. The matching
  PR summary rules in `CODING-STANDARDS.md` were checked and remain consistent.
- The known-issue and no-issue prompt outcomes are covered by
  `worker/deno/tests/fleet_pr_babysitter_test.ts`.
- Deno regression avoided: kept the test and validation path Deno-native; no
  Node tooling or dependencies were added.

## Test Plan

- `deno task test:unit tests/fleet_pr_babysitter_test.ts tests/fleet_pr_babysitter_single_push_test.ts`
  — passed (134 passed, 0 failed).
- `deno fmt --check` on the three changed TypeScript files — passed.
- `deno lint` on the three changed TypeScript files — passed.
- `deno check --frozen --lock=deno.lock` on the changed command and test files —
  passed.
- The new prompt tests failed against the previous wording. Reverting only the
  repair caller's issue-number argument made
  `repair caller passes the issue number parsed from the PR branch` fail because
  the captured prompt omitted `pr-summary-2453.md`; restoring
  `issueNumberFromBranch(pr.headRefName)` made it pass.
- No assertions were removed. The existing merged-base and unmerged prompt
  assertions in `worker/deno/tests/fleet_pr_babysitter_single_push_test.ts`
  remain and pass with the new required argument.
- `./quality.sh < /dev/null` — failed in the unrelated
  `spawnFastCheck: declared credentials ride the stdin channel, never argv, behind the sudo wrapper`
  test. Its expected argv included the six HTTP(S) proxy variables; the actual
  argv contained only `CARGO_TARGET_DIR`. The default-branch commit's changed
  files do not include that test or its implementation. This failure was not
  confirmed against a green base-branch CI run. The gate also reported config
  integration skipped because `.config.json` was unavailable and Checkov skipped
  because it was not installed or running in Docker/Podman.
- The 14-day review-log observation remains unperformed until after merge.
