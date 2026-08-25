# Quarantine a damaged audit journal instead of letting it stop the trail

## Summary

Host `GRQ-23`, 2026-08-25. One torn line in the day's journal, and from that
point on every GitHub mutation the worker made went unrecorded:

```text
[SECURITY] [AUDIT_JOURNAL_REFUSED] issue-comment: audit journal rewritten: …/audit-worker-2026-08-25.jsonl entry 31 no longer carries the anchored head hash
[SECURITY] [AUDIT_JOURNAL_REFUSED] api-delete: …
[SECURITY] [AUDIT_JOURNAL_REFUSED] git-push: …
```

`reconcile` throws when a journal disagrees with its anchor, `recordMutation`
returns that error, and the chokepoint hook logs it and swallows it — by
design, so journalling never aborts the mutation it is recording. The
consequence was that the worker kept commenting, deleting, pushing and merging
on GitHub with **no audit trail at all**, permanently, and the only signal was
a line in a log nobody was watching.

That is the wrong failure direction. The damage is in the past; the mutations
it stops attesting are in the future. Refusing to write today's evidence does
nothing to protect yesterday's.

### The fix

A damaged journal is now **quarantined**, not written to and not stood on:

- it is left **exactly as found** — same bytes, same anchor — because it is
  evidence, and repairing or deleting it would destroy the thing the alarm
  exists to preserve;
- a fresh segment opens beside it, `audit-<worker>-<date>.s1.jsonl`, whose
  first chained entry (`audit-journal-quarantined`) records which file was
  displaced and why, so "why does this host have a `.s1` journal" is
  answerable from the trail rather than from whoever read the console;
- a `[SECURITY] [AUDIT_JOURNAL_QUARANTINED]` line names both files;
- recording continues, chained and anchored, in the segment.

Nothing is laundered. The damaged journal keeps its anchor, stays on the
roster, and keeps failing `audit-chain-verify` exactly as loudly as before —
it cannot be re-anchored because it is never appended to again. Each of the
three tests below asserts that directly, byte-for-byte.

Quarantine is deliberately **not** applied to a journal with no anchor at all.
That is the pre-#3712 case `audit-chain-verify --adopt` exists for, and
opening a segment beside it would strand the chain the operator is about to
adopt. `AuditChainAnchorError` now carries a `quarantinable` flag to keep that
distinction explicit rather than inferring it from message text.

Closes #361.

## Contract change — documented, not silently relaxed

Three existing tests asserted that `recordMutation` **fails** on a damaged
journal. Per CODING-STANDARDS they are modified, not removed, and the change
is stated here:

| Test | Was | Now |
| --- | --- | --- |
| `recordMutation refuses to extend a journal with unanchored tail entries (#3949)` | asserts the append fails | asserts the forged file and its anchor are byte-for-byte unchanged, the entry landed in `.s1`, and the sweep still fails on it |
| `a deleted journal is not treated as a fresh chain` | asserts the append fails | asserts the deleted name is **not** recreated, its anchor is unchanged, and the sweep still fails on it |
| `a truncated journal is not silently extended` | asserts the append fails | asserts the truncated file and anchor are unchanged and the sweep still fails on it |

The invariant each protects — *a damaged chain is never extended or
re-anchored* — is unchanged, and is now asserted more strictly than before:
previously they only checked that the call returned an error, which does not
by itself prove the file was left alone.

## Not fixed here

#361 also names the cause of the tear. `resolveWorkerId()` falls back to the
constant `"worker"` because `WORKER_UNIQUE_ID` is never set anywhere in the
repository and `WORKER_NAME` defaults to `""`, so the per-worker partition the
module documents as its cross-process safety property does not exist — every
process on the host appends to one file, serialised only by an in-process
mutex. This PR stops that damage from killing the trail; it does not stop the
damage. That needs the partition made real and the append made atomic, and is
a separate change.

## Evidence

Backend change only — no web surface to screenshot.

```text
$ deno test --allow-all tests/audit_journal_test.ts tests/audit_anchor_test.ts \
    tests/audit_chain_verify_command_test.ts tests/audit_hook_test.ts
ok | 47 passed | 0 failed (868ms)
```

Three new tests, each driving real files:

- **the host's exact failure** — three entries, the anchored head line torn in
  half, reproducing `entry N no longer carries the anchored head hash`. The
  mutation is still recorded; the torn file and its anchor are unchanged; the
  segment holds the quarantine note then the mutation, and verifies clean in
  its own right; the sweep still reports the torn journal broken and does
  **not** report the segment;
- **a second run appends to the existing segment** rather than opening `.s2`
  or repeating the quarantine note;
- **a journal awaiting `--adopt` is not quarantined** out from under the
  operator, and no segment is created.
