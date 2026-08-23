# PR Summary — Issue #322

## Summary

`run_core` bounds itself with in-process `setTimeout` watchdogs. Those are only
as reliable as the event loop they run on, and on 2026-08-22 two agents
saturated the container:

```text
23:26:40Z ERROR Claude timed out after 3422s — killing process tree (PID 6441)
                (fired at +4772s via timer — 1350s late)
23:43:26Z ERROR Claude timed out after 3439s — killing process tree (PID 6007)
                (fired at +6176s via timer — 2737s late)
00:05:10Z INFO  execute: still running · 124m33s elapsed
```

The guard against an overrun was itself a casualty of the overrun. The cycle
ran **2h26m past its deadline** and stopped only because a human killed it.

`loop.sh` was a supervisor in name only: it ran `./run.sh`, waited, recorded
the outcome and slept. It had a `timeout 120` on the backoff *recorder* and
none on the run it supervised, so a `run.sh` that never returned meant waiting
for ever.

This gives the deadline to the one process guaranteed not to be inside the
failure. `run_under_deadline` wraps `./run.sh` in `timeout
--kill-after=<grace> <cap>` — SIGTERM at the cap, SIGKILL after the grace —
defaulting to `VIBE_RUN_MAX_SECONDS=5400` (the 3600 s run duration plus a wide
margin for a slow but genuinely progressing shutdown). The expiry is reported
distinctly and flows into the existing `container-restart-backoff` recorder, so
a host that does this repeatedly escalates (#4072) rather than looping.

### Reaping what a killed run leaves behind

Killing `run.sh` does not stop the container it started. On 2026-08-22 the
orphaned VM kept running at **705% CPU** with nothing supervising it, which is
how one wedge becomes a wedged host — the next cycle fails the same way.

`reap_orphaned_containers` identifies orphans by **reparenting**, not by PID:
once `run.sh` dies, its `container run` client is reparented to init
(`PPID 1`). That test needs no bookkeeping, and it also clears a client
stranded by an earlier cycle or by a human kill. A client still owned by a live
`run.sh` has a PPID that is not 1 and is never touched, so a healthy run is
safe. SIGTERM, then SIGKILL for anything that survives.

Recovering a container whose own *init* has died — where `exec`, `stop` and
`kill` all fail while `container ls` still reports it running — is Issue #323
and deliberately not attempted here.

Closes #322.

## Evidence

Shell/supervisor change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`**: without the cap, the
never-exits stub runs for ever and `run.sh` is invoked exactly once.

**They pass here**, alongside the four pre-existing #1836 cases:

```text
$ deno test --allow-all tests/loop_supervisor_test.ts
loop.sh - continues iterating when run.sh exits non-zero (Issue #1836) ... ok
loop.sh - survives SIGTERM and continues looping (Issue #1836) ... ok
loop.sh - continues iterating when git pull fails (Issue #1836) ... ok
loop.sh - LOOP_SLEEP_SECONDS overrides default 60s sleep (Issue #1836) ... ok
loop.sh #322 - a run.sh that never exits is terminated and the next cycle starts ... ok
loop.sh #322 - a run that finishes inside the cap is not disturbed ... ok
loop.sh #322 - VIBE_RUN_MAX_SECONDS=0 disables the cap rather than capping at zero ... ok

ok | 7 passed | 0 failed (46s)
```

`bash -n loop.sh` parses clean.

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates.

`deno tests` reports the 11 pre-existing `setup.ps1` failures (`NotFound:
Failed to spawn 'pwsh'`) plus `runClaudeWithRetry - a SIGKILLed agent's
surviving descendant is collected … (Issue #4382)`. That last one **also fails
on unmodified `origin/main`** — checked in a detached worktree — so it is not
from this change. It is in the area Issue #325 covers, and is worth its own
look there.

## Test plan

`worker/deno/tests/loop_supervisor_test.ts` — 3 new cases on the existing
harness (`spawnLoop` gains an env-override parameter):

| Case | Asserts |
| --- | --- |
| a `run.sh` that never exits is terminated and the next cycle starts | The wedged-cycle shape: a stub that `sleep 300`s is killed at a 2 s cap and re-launched, so `run.sh` runs ≥2 times |
| a run that finishes inside the cap is not disturbed | A 1 s run under a 30 s cap cycles normally — the cap must not truncate healthy work |
| `VIBE_RUN_MAX_SECONDS=0` disables the cap rather than capping at zero | A misread of `0` as an immediate deadline would kill every run instantly, which is worse than the bug being fixed |

The third asserts on **completion**, not invocation count: with the cap off,
the measure is whether a slow run reaches its own exit. A first draft counted
invocations and failed for the wrong reason — the run had completed and simply
cycled twice inside the window.

No test drives `reap_orphaned_containers` directly: it operates on live
`container run` processes, and a test that spawned one would be an integration
test against the host's container runtime. Its safety property — that a client
with a live parent is never touched — is a `PPID == 1` guard stated in one
line, and the function is best-effort by construction.
