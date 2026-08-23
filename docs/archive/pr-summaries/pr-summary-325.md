# PR Summary — Issue #325

## Summary

On 2026-08-22 the hard timeout fired, the runner escalated SIGTERM → SIGKILL,
and then waited **2473 seconds against a documented 120 second cap** before
giving up:

```text
00:07:26Z ERROR Kill of PID 6441 did not complete within 2473s of the hard-timeout
  firing (cap 120s): child status and streams still unsettled after
  SIGTERM→SIGKILL escalation — likely an orphaned descendant holding the stdout
  pipe.
```

Both pool slots were held this way, so the cycle could not end at all.

### Why the cap did not hold

The cap is a `setTimeout`:

```ts
killBoundTimer = setTimeout(() => killBoundResolve?.("kill-bound"), killBoundMs);
```

Two agents had saturated the container, so the event loop was starved — the
same starvation that made the watchdogs fire 1350 s and 2737 s late. A timer
cannot bound a process whose event loop is the thing that failed. Raising the
cap or adding another timer would not have helped.

### The structural fix

`child.status` and the stream pumps fail **independently**, and the runner was
treating them as one condition:

```ts
const settle = (async () => {
  const s = await child.status;
  await stdoutPump.catch(…);      // ← never resolves
  await stderrPump.catch(…);
  return s;
})();
```

After SIGKILL the direct child is reaped promptly — `child.status` is about the
*process*. What hangs is the pump, because a surviving **descendant** inherited
stdout and holds the write end open, so the reader never sees EOF. Awaiting the
pumps as part of "settled" is what let an unkillable *grandchild* wedge the
slot.

Settling is now keyed on the status. The pumps are drained as a bounded
courtesy (`streamDrainCapSeconds`, default 5 s): whatever has arrived is kept,
and a pipe nobody will ever close is abandoned rather than waited on. Losing
the tail of stdout on a run that is already a timeout failure is a far smaller
harm than never releasing the slot.

This does not depend on a timer firing punctually, which is the point.

### An existing test was already failing on `main`

`runClaudeWithRetry - a SIGKILLed agent's surviving descendant is collected and
the kill diagnostics name it (Issue #4382)` fails on unmodified `origin/main`
— verified in a detached worktree. That test spawns exactly this shape, and it
had become a canary nobody had read. **This change repairs it.**

## Evidence

Backend change with no web interface, so there is no screenshot.

**The new test fails on `origin/main` and passes here.** Copied into a detached
worktree of `main`:

```text
FAILED (1m0s)
error: AssertionError: settling must not wait on the held pipe; took 60165ms
       while the descendant holds stdout for 60s
```

60165 ms — the runner waited out the descendant's entire lifetime. On this
branch the whole file completes in 8 s.

**The suite, including the repaired #4382 canary:**

```text
$ deno test --allow-all tests/claude_runner_killed_test.ts
ok | 10 passed | 0 failed (8s)

$ deno test --allow-all tests/*claude_runner* tests/*timeout_extension*
ok | 115 passed | 0 failed (1m8s)
```

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED.
`deno tests` reports only the 11 pre-existing `setup.ps1` failures
(`NotFound: Failed to spawn 'pwsh'`, environmental).

## Test plan

`worker/deno/tests/claude_runner_killed_test.ts` — 1 new case, and one
pre-existing case repaired:

| Case | Asserts |
| --- | --- |
| *a descendant holding stdout does not delay settling past the drain cap* (new) | A stub spawns `sleep 60 &` **without redirecting stdout**, so the descendant inherits and holds the pipe. The run must return in far less than 60 s. Asserts the timing property directly rather than an internal flag — 60165 ms on `main`, immediate here |
| *a SIGKILLed agent's surviving descendant is collected …* (#4382, repaired) | Was failing on `main`; passes here for the same underlying reason |

The new option `streamDrainCapSeconds` is a test seam in the shape the file
already uses for `killCompletionCapSeconds`; production leaves it unset.

## What this does not fix

The cap remains a timer, and on a sufficiently starved event loop *any*
in-process guard fires late. This change removes the dependency for the
dominant wait — the status — but the drain bound is still a `setTimeout`. Late
by a factor of twenty it is 100 s rather than 2473 s, which is a different
order of harm, not immunity.

The guards that do not share the failure are the sibling issues from this
incident: #322 (the supervisor owns a wall-clock deadline, since it is not
inside the wedged process), #323 (recovering a container whose control plane
has died) and #324 (stopping an agent saturating the VM in the first place,
which is what starved the loop here).
