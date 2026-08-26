# The #410 gate read the guest, not the host — so it never fired

## What went wrong

PR #419 gated the fleet-health clone on "is the host below its disk floor",
and computed that by running `df` on `WORK_DIR`:

```ts
const reading = await probeDiskReading(workDir);   // df -kP inside the guest
```

In container mode `WORK_DIR` is the **work volume** — a thin-provisioned image
that reports plenty of free space while the host it lives on is full. So the
gate answered a different question from the one the reclaimer acts on, and
never fired.

That is precisely the guest-versus-host category error Issue #384 was filed
about. I wrote the issue and then made the mistake in the fix for it.

Measured on GRQ-23 with #419 deployed:

```
host free                              43.5 GB   (floor 46.0)
GRQ-health prunes since restart              5
health re-clones since restart               5
"below its disk floor" deferral lines        0
```

The livelock was untouched. Meanwhile #419's other half worked: zero
`did not match any file(s) known to git` since the restart, and the new
`Failed to position … on its remote head` message appears — so #411 is fixed
and only this gate was wrong.

## The correction

The predicate is now **injected** from the run's `HostDiskMonitor`, the one
component that knows the host figure — the launcher's launch-time `df`
baseline minus the volume's growth since (`estimateHostFree`, Issue #226) —
and the same monitor whose verdict the reclaimer acts on. The two sides can no
longer disagree, because there is only one signal.

```ts
const fleetHealthDeps = createProductionFleetHealthDeps(
  logger,
  () => Promise.resolve(hostDisk.status.level === "low"),
);
```

`status` is the last sampled verdict, so the gate costs no probe. `unknown` is
deliberately not `low`: an unprobed host must not silently switch health
reporting off.

`fleet_health.ts` no longer imports `host_disk` at all — it cannot compute a
disk verdict, only be told one. That is the property worth keeping: the module
that must not guess is now structurally unable to.

## Evidence

```text
$ deno test --allow-all tests/fleet_health_test.ts tests/host_disk_test.ts \
    tests/run_core_production_deps_test.ts
ok | 93 passed | 0 failed (1s)
```

Two new tests pin the contract that the first cut got wrong:

- omitting the predicate leaves the clone **ungated** — no gate that guesses;
- the injected predicate is the one consulted, and it is consulted.

The four behavioural tests from #419 are unchanged and still pass: gated below
the floor, normal above it, ungated when absent, and an existing checkout still
refreshed below the floor.

## What this does not fix

The reclaimer still prunes a directory it can observe will return, and still
prunes when it can compute that 0 bytes reach the host. That is the follow-up
recorded on #384, and it is the other half of this livelock — this change only
stops the clone side feeding it.

Refs #410, #384.
