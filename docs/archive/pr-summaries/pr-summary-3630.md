# Lane worktree creation heals a clone whose HEAD dangles (Issue #3630)

## Summary

The lane worktree (`worker/deno/lib/lane_worktree.ts`) creates its worktree
with `git worktree add --detach --force <path> HEAD`, so the operation
resolves through the shared clone's `HEAD` symref. Milestone sync checks the
milestone branch out of the main clone and leaves it there; when that branch
later goes — cleanup, a recreated clone, a sibling's sync — `HEAD` dangles,
and every worktree add fails with `fatal: invalid reference: HEAD` (newer git:
`warning: HEAD points to an invalid (or orphaned) reference`). Nothing
rewrites the symref on its own, so the lane wedged permanently: every cycle
died in phase `setup` inside a minute and released the claim with no PR — the
shape behind the stSoftwareAU/GRQ-AutoTrader#3184 fast-failure tally.

The fix mirrors the Issue #1561 orphan-directory repair:

- `isInvalidHeadReference(outcome)` recognises both git wordings for the
  dangling-HEAD refusal.
- On that refusal, `healDanglingHead(repoPath)` resolves the default branch
  from the clone itself (`git symbolic-ref refs/remotes/origin/HEAD`, the
  same local resolution `setupRepo()` relies on — inlined here because
  `git_push.ts` imports this module's root constant and an import would
  cycle) and rewrites `HEAD` to it — `git symbolic-ref HEAD
  refs/heads/<default>` when the local branch exists, otherwise
  `git checkout -B <default> origin/<default>` first.
- The worktree add is retried once. Any other failure keeps today's
  behaviour, and a failed heal names both faults.

## Tests

- `ensureLaneWorktree - heals a clone whose HEAD dangles and retries once`:
  real git — the symref is broken, the lane succeeds, and the clone's `HEAD`
  reads `refs/heads/main` afterwards.
- `ensureLaneWorktree - a worktree add failure that is not a dangling HEAD is
  not healed`: the failure reports as today, with no heal claimed.
- `isInvalidHeadReference - matches both git wordings`: the container's
  `fatal: invalid reference: HEAD` and newer git's `HEAD points to an invalid
  (or orphaned) reference`, and refuses an unrelated checkout error.

**Docs sweep** — grep: `isInvalidHeadReference`, `healDanglingHead`; section:
none — no manual documents the lane worktree heal (the #1561 repair it
mirrors is not documented either; lane-worktree mentions live only in
release notes and archived PR summaries); siblings: none — no existing set
gained a member
