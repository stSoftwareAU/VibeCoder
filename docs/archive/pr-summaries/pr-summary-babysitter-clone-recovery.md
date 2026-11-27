# Babysitter: one unremovable interrupted clone no longer aborts every pass

## Summary

On Mac-Ultra-M2, every `au.com.stsoftware.fleet-pr-babysitter` pass from about
7 to 27 November 2026 exited 1 within seconds, before reaching any PR:

```text
PermissionDenied: Permission denied (os error 13): remove '/var/folders/.../T//fleet-pr-babysitter-94613-4eff95a74bfc4c63'
    at async recoverTemporaryClones (worker/deno/commands/fleet_pr_babysitter.ts:936:7)
```

The clone of a dead pass held a `credentials/` directory with mode 000. A
recursive remove cannot list it, and `recoverTemporaryClones` rethrew every
error except `NotFound`, so the whole pass aborted. #4710 relies on this
recovery to clear the clones `fix()` could not remove, so one stuck clone
stopped all babysitting on the host.

`recoverTemporaryClones` now restores owner access to every real directory in an
abandoned clone before removing it. A clone that still cannot be removed is a
`WARNING` naming the path, retried by the next pass, and the pass carries on.

## Spec

### Intent and Rationale

- Recovery exists so a later pass can tidy up after an interrupted one. It must
  never become a reason for every later pass to fail.

### Essential Design Decisions

- The permission repair uses `lstat` and only descends into real directories,
  so a symbolic link planted in a clone cannot make the host change the mode of
  a directory outside it.
- Only directories are changed (to 0700). Removing a file needs write access to
  its parent directory, not to the file itself.
- The liveness-probe errors still throw. They say nothing about one clone, and
  continuing could remove a live pass's clone.

### Undiscoverable Facts

- The plist sends stdout and stderr to `/dev/null` on purpose. The supervisor
  writes each pass's own log under `~/.vibe-coder/fleet-pr-babysitter/logs`,
  and the error was recorded there.
- What set the 000 mode is unknown. The directory was named `credentials`
  inside a repair scratch directory, which points to something the agent ran in
  the container.

## Evidence

- Read and updated `docs/workflows/fleet-pr-babysitter.md` (the clone-recovery
  paragraph under logs and clones).
- The two new behaviour tests failed before the change (an `EACCES` throw and no
  warning) and pass after it. The full `tests/fleet_pr_babysitter_test.ts`
  passes (125 tests).
- On Mac-Ultra-M2, removing the stuck clone by hand let the next pass run; it
  went on to repair stSoftwareAU/GRQ-www#113.

## Test Plan

- `cleanup removes an abandoned clone holding an inaccessible directory`
- `cleanup never changes the mode of a directory a clone links to`
- `cleanup that cannot remove an abandoned clone warns and does not throw`
- The existing `cleanup removes abandoned clones but preserves live and
  unrelated directories` still passes, unchanged.
