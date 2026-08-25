# Let an accounted-for audit-journal loss be signed for, so the alarm can go green again

## Summary

Issue #337 had the work-volume housekeeping tier `audit` as disposable and
delete the worker's own hash-chained journals. That bug is fixed (#349), but a
fix can only stop further losses — it cannot undo one. The roster that makes a
deletion detectable lives *outside* the audit directory precisely so a sweep
cannot take it too, and it is **append-only**: `addToRoster` is its only
writer, and there is no remove, expire, or acknowledge anywhere in the tree.

So a host swept before the fix landed logs, on every worker start, for ever:

```text
[SECURITY] [AUDIT_CHAIN_BROKEN] …/audit-worker-2026-08-21.jsonl: audit directory missing but the roster records this journal — directory deleted
[SECURITY] [AUDIT_CHAIN_BROKEN] …/audit-worker-2026-08-22.jsonl: …
[SECURITY] [AUDIT_CHAIN_BROKEN] …/audit-worker-2026-08-23.jsonl: …
```

`audit-chain-verify` is the first housekeeping step on every start, so those
three lines are now permanent. The only exits were a human editing
`audit.roster.jsonl` — the tamper-evidence file, which operators should never
be routinely editing — or rebuilding the container.

**A permanently-red integrity alarm is a broken integrity alarm.** Once three
`[SECURITY]` lines are always present, a genuine deletion arriving on that host
adds a fourth that nobody will look at. The alarm has to be able to return to
green once a loss is accounted for, or it stops carrying information.

### What was added

`--acknowledge-loss` signs for a journal that is genuinely gone. Nothing is
erased: the roster keeps its `RosterEntry` saying the journal existed, and
gains a dated, attributed line saying its absence was signed for. Every later
sweep still names the loss — `[AUDIT_CHAIN_LOSS_ACKNOWLEDGED]`, counted in the
summary as `N acknowledged as lost` — it simply stops being a *failure*.

```bash
deno task audit-chain-verify \
  --acknowledge-loss audit-worker-2026-08-21.jsonl \
  --reason "pruned by the work-volume housekeeping (Issue #337)" --by nleck
```

The guards are the point, and they mirror the ones `--adopt` has always
applied:

- **On the roster, or refused.** A journal nothing ever expected cannot be
  pre-acknowledged.
- **Absent from disk, or refused.** Journal *and* anchor must both be gone. A
  journal that is present but truncated, rewritten, or carrying a malformed
  line falls through to `verifyChain` and can never be silenced — acknowledging
  one of those would be blessing tampering.
- **A reason is required**, and an operator identity is recorded.
- **The chain is written first.** The act is appended to the live journal as an
  `audit-loss-acknowledged` entry, chained and anchored, before the roster line
  is written. If that append fails, nothing is acknowledged and the alarm keeps
  sounding — the sidecar is never silenced without a chained record of who did
  it.

The broken line now also names its own remedy, but only for the shape of
breakage that has one. The alarm previously had no documented exit at all;
an operator meeting it should not have to go and find out that one exists.

### What this is not

It is not unforgeable, and the docs say so rather than implying otherwise. A
principal who can append to the roster can already delete it outright — which
trips the complete-erasure alarm (Issue #270) instead. What the acknowledgement
buys is accountability: an accounted-for loss becomes a dated, attributed,
reviewable record, so a **new** deletion on that host is once again the only
red line in the sweep.

Acknowledging is also deliberately **not** automatic. A worker that could
silence its own integrity alarm has no integrity alarm; requiring a human to
sign for a loss is the control, not a gap in it.

Closes #359.

## Not fixed here

The reporting host has since grown a fourth, unrelated breakage:

```text
[SECURITY] [AUDIT_CHAIN_BROKEN] …/audit-worker-2026-08-25.jsonl at entry 31: malformed JSON
```

That is a torn line in a live journal, not a loss — this change deliberately
refuses to silence it, and it stays red after this lands. Filed as #361.

## Evidence

Backend/CLI change only — no web surface to screenshot. Seven new tests, each
driving the real command against a real temp audit directory:

```text
$ deno test --allow-all tests/audit_chain_verify_command_test.ts \
    tests/audit_journal_test.ts tests/audit_anchor_test.ts
ok | 44 passed | 0 failed (768ms)
```

The 37 pre-existing audit tests are unchanged and still pass, which is the
point that matters most: detection is not weakened anywhere.

The new tests pin both directions:

- a swept directory fails until signed for, then reports green while still
  naming the loss;
- the acknowledgement is readable in the **hash chain**, not only the roster;
- a journal still on disk (truncated) is refused, and the sweep stays broken;
- a journal never rostered is refused;
- an acknowledgement with no reason, or a blank one, is refused and writes
  nothing;
- signing for one of three losses leaves the other two loud and the run red;
- a half-formed acknowledgement line in the roster is a tamper signal
  (`unexpected shape`), not a silencer.
