# PR Summary — Issue #2893

## Summary

Closes #2893.

The test "security sweep #2839 - the recorded sweptAt is an ancestor of HEAD"
in `worker/deno/tests/security_sweep_2839_ledger_test.ts` was guarded only by
`git cat-file -e <sweptAt>^{commit}`, which proves the object exists but not
that `git merge-base --is-ancestor` can walk to it. In PR #2887's worktree
(shallow, grafted at `427a8fc`) the sweptAt `42c876e` was the graft's
grandparent: the object existed, the walk failed, and `./quality.sh` reported
1 failure. The guard now reuses `isShallowRepo` from
`worker/deno/lib/git_history.ts` and skips the test when the repository is
shallow or the object is missing; a failing shallow check throws rather than
silently skipping.

## Checklist

- [x] Guard matches the `--is-ancestor` condition
- [x] Touched test run
- [ ] Quality gate

## Evidence

Backend only, no UI. In this (shallow) worktree:

```
deno test -A tests/security_sweep_2839_ledger_test.ts
```

→ `ok | 2 passed | 0 failed | 1 ignored`, where previously the ancestor test
was eligible to run and fail in a grafted clone. No new test was added: the
change is to a test's own skip guard, and `isShallowRepo` already has coverage
in `worker/deno/tests/git_history_test.ts`.

## Test Plan

- Run the touched test file
- In a full clone the ancestor test still runs
- Run `./quality.sh`
