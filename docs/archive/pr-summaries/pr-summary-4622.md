# Babysitter shift-left pass scans only repositories its App can reach

## Summary

Closes #4622

PR #4618 scoped the babysitter's write token to the configured repositories
its App installation can reach, and repair discovery iterates that list. The
shift-left pass from PR #4612 landed alongside it and still iterated every
configured repository, so a host whose App covers one owner made failing API
calls for the other owner's repositories on every pass. The shift-left pass
now takes the same accessible list.

## Spec

### Intent and Rationale

- One list of repositories per pass, the one the token can reach, for every
  lane the babysitter runs.

### Essential Design Decisions

- Reuse the `repositories` argument `pass()` already receives rather than a
  second filter.

### Undiscoverable Facts

- The two PRs merged within minutes of each other without a textual conflict,
  so neither PR's CI saw the combination.

## Evidence

Manual read: `docs/workflows/fleet-pr-babysitter.md` already says the
babysitter monitors only the accessible subset; no change needed. Visual
evidence is not applicable; this is a background service with no UI.

- `deno check commands/fleet_pr_babysitter.ts`: clean.
- `fleet_pr_babysitter_test.ts` and `shift_left_failures_test.ts`: 39 passed,
  0 failed.

## Test Plan

- Existing: the two test files above. `pass()` is not exported, so the call
  site has no direct test.
- Wide suite: CI.

## Merge verification

- CI: pending on this PR.
