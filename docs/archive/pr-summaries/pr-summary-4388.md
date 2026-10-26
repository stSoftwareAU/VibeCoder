# PR Summary — Issue #4388

## Summary

A host below its disk floor was tallied as a fast failure of
`stSoftwareAU/VibeCoder`. The recorded run died in `execute` after 182
seconds because the manager stopped on `host disk below its floor`. That
sentence did not match the disk-fault pattern unless it also carried the
park note, and a recognised host-disk stop was still counted as a
repository fast failure whenever it was a setup fault or `zero_output`.

The floor sentence is now a disk fault. `isFastFailure` refuses it for
`internal_error` and `zero_output` before either of those rules, and the
release path passes the failure message through. A security-fix gate that
only quotes the sentence stays the issue's failure. The issue is still not
labelled for the host stop: `isSetupFault` stays true.

Closes #4388.

## Spec

### Intent and Rationale

- Issue #4388 is the fleet tally for this repository. Its one marker is the
  disk-floor stop on #4051, not a setup crash in the repository.
- Three such tallies in a day back the repository off on every host. The
  disk is the host's condition, the same class as `rate_limit`.
- The issue ladder still treats the stop as a host fault, so the issue is
  not given `failed-once`.

### Essential Design Decisions

- The exclusion runs only for `internal_error` and `zero_output`, and only
  when `isHostDiskFaultText` matches and the message has no worker-gate
  marker. A `security_fix_gate` that quotes the floor stays countable.
- The release path passes `outcome.message` and `outcome.category` into
  both decisions. `isFastFailure` cannot see the disk text without the
  message.
- `judgeHostDiskForBuild`'s sentence is matched on its own. Callers that
  also append `Parked as infrastructure (Issue #4360)` already matched.

### Undiscoverable Facts

- The tally comment on #4388 is truncated at 400 characters, so the visible
  text ends in `so it wai`. The full manager reason is the floor sentence
  from `judgeHostDiskForBuild`, which does not include the park note.
- The run's category on that path is `internal_error` (`execute_phase`
  returns that when the agent call fails). Elapsed time was 182 seconds,
  above the 60-second fast-failure window, so it counted only because a
  host fault sets `setupFault`.

## Evidence

Backend-only change. No UI.

The regression test failed on the unfixed tree: `isSetupFault` was false
for the floor sentence, so the first assertion failed. After the pattern
and the exclusion, the same test passed. `deno test` of
`repo_fast_failure_tracker_test.ts` filtered to `isFastFailure` was 12
passed. `host_fault_test.ts` and `host_disk_inflight_4360_test.ts` were 46
passed. `deno lint` on the touched TypeScript files was clean. The full
`quality.sh` gate was not run.

**Docs sweep** — section: `docs/CONTAINER.md` "In-flight builds stop at the
same floor (Issue #4360)"; the new sentences say a host-disk stop is not a
repository fast failure. No other operator page describes this tally.

## Reproduction

- Symptom: a host-disk stop during execute (`host disk below its floor`,
  182 seconds, no park note) was posted as a fast-failure tally on this
  repository's diagnostic issue.
- Status: verified. The regression test failed against the unfixed code
  and passed after the fix.
- Regression test: `worker/deno/tests/repo_fast_failure_tracker_test.ts`
  "isFastFailure - a host-disk stop is not a repository fast failure (Issue #4388)".

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no material departures from `CODING-STANDARDS.md`.

## Test Plan

- [x] `isFastFailure` tests, including the new disk-floor cases and the
  gate that only quotes the floor
- [x] `host_fault_test.ts` and `host_disk_inflight_4360_test.ts`
- [ ] Full `quality.sh` (not run locally; CI runs it)
