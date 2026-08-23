# PR Summary — Issue #323

## Summary

On 2026-08-22 the container's init (`vminitd`) stopped answering. Every
control-plane operation failed, and nothing noticed:

```text
$ container exec vibe-coder-7150 sh -c 'ps -eo pid,ppid,etime,pcpu,args'
Error: failed to start process … (cause: "createProcess: socket: error could
not connect to socket 2:268435458 (Connection reset by peer)")

$ container stop vibe-coder-7150      # exit 0, container still STATE=running
$ container kill vibe-coder-7150      # no effect, container still running
```

`container ls` reported the container healthy and `running` throughout. The
host-side client had to be SIGKILLed by hand — and doing so **orphaned the
VM**, which kept running at **705% CPU** with nothing supervising it.

Liveness was being *inferred* from the worker writing logs. That is a symptom
of health rather than a check, and a wedged worker stops writing at precisely
the moment a check is needed.

### Probe, do not infer

`probe_control_plane` runs beside `run.sh` and does a trivial
`container exec <name> true` every `VIBE_PROBE_INTERVAL_SECONDS` (120).
`VIBE_PROBE_FAILURES` (3) consecutive failures means the control plane is gone,
whatever `container ls` reports. The probe exits once it has recovered a
container, and is stopped when the run ends.

### Recover with what actually works

`force_stop_container` tries `container kill` first — it costs a second and
works when the plane is merely slow rather than gone — then **verifies**,
because `container stop` returning 0 while the container kept running is
exactly what happened. Only if the container is still listed does it terminate
the host-side client, and then the VM.

The VM step matters on its own: killing the client alone is what left a VM at
705% CPU, and a leaked VM makes the *next* cycle fail the same way. Only VMs
reparented to init (`PPID 1`) are touched, so a VM owned by a live client is
never killed.

Closes #323.

## Evidence

Shell/supervisor change with no web interface, so there is no screenshot.

**Both new tests fail against `origin/main`** — no probe exists there:

```text
loop.sh #323 - a container whose exec keeps failing is recovered, not waited on ... FAILED
loop.sh #323 - a healthy container is probed and left alone ... FAILED
FAILED | 0 passed | 2 failed
```

**They pass here:**

```text
loop.sh #323 - a container whose exec keeps failing is recovered, not waited on ... ok (10s)
loop.sh #323 - a healthy container is probed and left alone ... ok (8s)
ok | 2 passed | 0 failed
```

`bash -n loop.sh` parses clean.

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED.
`deno tests` reports only the 11 pre-existing `setup.ps1` failures
(`NotFound: Failed to spawn 'pwsh'`, environmental).

## Test plan

`worker/deno/tests/loop_supervisor_test.ts` — 2 new cases. `setupHarness`
gains an optional `containerStub`, so the probe can be driven without a real
container runtime:

| Case | Asserts |
| --- | --- |
| a container whose `exec` keeps failing is recovered, not waited on | The stub reports `ls` as **running** throughout while every `exec` fails — the exact 2026-08-22 contradiction. Two failed probes must escalate to `kill vibe-coder-999` |
| a healthy container is probed and left alone | `exec` succeeds; the probe must run but must never kill. Without this the fix could become a periodic killer of working containers |

The stub logs every `container` invocation, so both tests assert on the
observable command sequence rather than on internal state.

`force_stop_container`'s client-and-VM escalation is not unit-tested: it
operates on live host processes, and a test that spawned a VM would be an
integration test against the host's virtualisation stack. Its safety property —
that only a VM reparented to init is touched, so one owned by a live client is
never killed — is a `PPID == 1` guard stated in one line, matching the reaper
#322 added.

## Relationship to the other fixes from this incident

Four failure modes were filed from one wedge, and they are layered
deliberately:

- **#324** stops an agent saturating the VM in the first place — the trigger.
- **#325** stops an unkillable descendant holding a pool slot — the first
  thing that failed.
- **This issue** detects and recovers a container whose control plane has died
  — the state the saturation left behind.
- **#322** is the outermost net: the supervisor ends any run that outlives its
  wall clock, whatever else has failed.

Each is independently useful, and none of them relies on a human noticing.
