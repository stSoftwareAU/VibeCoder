# Create the feature branch with `checkout -B` so a leftover branch cannot wedge the claim

## Summary

The idle-decision census was right and the claim scan was not refusing
anything. `stSoftwareAU/VibeCoder` did hold one claimable `work-on` issue —
Issue #356 itself — and the scan claimed it, ten times in nine hours. Every
claim died in phase `setup` with:

```text
Failed to create feature branch: Failed to create feature branch
'issue-356-fix-stsoftwareau-vibecoder-has-claimable-work-the' from 'main'
```

and released with no PR. The census kept reporting claimable work nobody was
doing because nobody *was* doing it — the claim was being taken and thrown
away each cycle.

### The wedge

Two functions disagree about what "the branch already exists" means:

1. `resumeIssueBranch` (Issue #220) lists the remote `issue-<N>-*` branches
   and, for each candidate, calls `resumeFeatureBranchFromRemote` — which
   **checks the branch out** — and only then counts how far ahead of base it
   is. The first attempt on #356 had pushed `issue-356-…` at exactly `main`,
   so the candidate is 0 commits ahead, is passed over as unusable, and the
   lookup returns `branch: null` ("start fresh from base") **with HEAD still
   on the branch it just rejected**.
2. `createFeatureBranchFromBase` then removes any existing local branch with
   `branch -D` before `checkout -b`. Git refuses to delete the branch HEAD is
   on, that failure was unchecked, and all three `checkout -b` fallbacks then
   hit `fatal: a branch named '…' already exists`.

Reproduced exactly:

```console
$ git branch -D issue-356-x
error: cannot delete branch 'issue-356-x' used by worktree at '…/work'
$ git checkout -b issue-356-x --end-of-options origin/main
fatal: a branch named 'issue-356-x' already exists
```

Because it is a pure function of the repository's state, it failed identically
on every re-claim. Nothing degraded, nothing escalated: the issue was simply
claimed and released once an hour, for ever.

### The fix

`createFeatureBranchFromBase` now uses `checkout -B` — create-or-reset — for
every start point instead of `branch -D` followed by `checkout -b`. `-B`
succeeds whether the branch is absent, present, or the one currently checked
out. It is no more destructive than the delete it replaces: both discard
whatever the local branch pointed at, and the remote branch is untouched.

`resumeFeatureBranchFromRemote` carried the same `branch -D` + `checkout -b`
pair and is switched to `-B` for the same reason. Its failure mode was worse
than a wedge — with HEAD on the branch, the collision made it return "could
not be checked out", and the caller then reported *no resumable prior work*
over a pushed WIP commit. That is the data loss Issue #220 exists to prevent.

The failure message now carries git's own words. The release comment on #356
read `Likely cause: could not be automatically determined` across all ten
attempts because `createFeatureBranchFromBase` discarded every stderr it saw
and returned a fixed string. It now names each command tried and what git
said, so this class is diagnosable from the release comment alone.

Closes #356.

## Not in scope, filed separately

Ten identical failed claims produced no escalation of their own; the only
alarm that fired was the idle-census inversion, which named the wrong culprit
("the claim scan keeps refusing"). A worker that re-claims the same issue and
dies in the same phase every cycle should say so rather than rely on a
neighbouring detector noticing the silence — filed as a follow-up.

## Evidence

Backend change only — no web surface to screenshot. Both new tests were run
against the unfixed code first and fail with the production error, then pass
after the fix:

```text
$ deno test --allow-all --filter "Issue #356" tests/git_branch_test.ts    # before
createFeatureBranchFromBase - recreates the feature branch even when it is the
  checked-out branch (Issue #356) ... FAILED
  => AssertionError: expected ok, got: Failed to create feature branch
     'issue-4-wedged' from 'main'
createFeatureBranchFromBase - failure names the git command and its output
  (Issue #356) ... FAILED
  => Expected actual: "Failed to create feature branch 'issue-5-no-base' from
     'no-such-base'" to contain: "git checkout".
FAILED | 0 passed | 2 failed
```

```text
$ deno test --allow-all tests/git_branch_test.ts                          # after
ok | 32 passed | 0 failed (5s)
```

Both tests drive real git against a real bare remote through the existing
`setupRemoteAndClone` fixture in that file — the first reconstructs the exact
starting state the resume lookup leaves behind (remote branch at base, checked
out locally, 0 commits ahead).

The resume and worker-wiring suites that exercise these two functions are
unchanged and green:

```text
$ deno test --allow-all tests/setup_branch_resume_test.ts \
    tests/issue_worker_test.ts tests/issue_worker_wiring_test.ts \
    tests/shallow_clone_feature_workflow_test.ts \
    tests/git_issue_branch_resume_test.ts tests/issue_branch_resume_test.ts
ok | 164 passed | 0 failed (22s)
```
