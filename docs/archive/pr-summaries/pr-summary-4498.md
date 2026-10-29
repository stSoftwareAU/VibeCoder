# Reclaim stale host build caches when the host is below its disk floor

Closes #4498.

A host sat below its disk floor for about 25 hours while roughly 150 GB of it
was stale cargo build output the worker could have removed. Recreating the
work volume cannot return that space, so the launcher now asks the worker to
remove it.

## What changed

- `reclaim-host-caches` command (`worker/deno/commands/reclaim_host_caches.ts`,
  `worker/deno/lib/host_cache_reclaim.ts`): removes stale cargo build caches
  from the host's scratch and source roots when free space is under the floor,
  and logs the largest host directories when that is not enough.
- `run.sh` / `run.ps1`: call the command before deciding to recreate the work
  volume, and report `[WORK_VOLUME_UNRECOVERED]` when a recreate would not help.
- `host_disk.ts` / `heavy_build_gate.ts`: the launch-end stop reason no longer
  promises a recreate once the launcher has declined one, and names the
  largest host directories.
- `docs/CONFIGURATION.md`, `docs/CONTAINER.md`: document the new settings.

## Reproduction

- **symptom** — the host stayed below its disk floor for 25 h because nothing
  removed the stale host-side build caches, and the stop reason promised a
  work-volume recreate that could not free the space
- **status** — `not-run`
- **reason:** the fault needs a real host with ~150 GB of stale caches; the new
  command and parser fields do not exist on the base branch, so a fail-before
  run of the tests is a missing-module error, not the symptom
- **regression test** — `worker/deno/tests/host_cache_reclaim_test.ts` and
  `worker/deno/tests/host_disk_recreate_declined_4498_test.ts`

## Mutation check

The three surviving mutants in `reclaim_host_caches.ts` are now killed by tests
in `worker/deno/tests/host_cache_reclaim_test.ts`, each confirmed by applying
the mutation and watching a test go red:

- line 81 (`execute` returns `undefined`) —
  `command: execute delegates to runReclaimHostCaches`
- line 97 (`value >= 0` dropped) — `command: garbage numeric flags are refused`
  with `free-kb: -1` and `floor-kb: -1`
- line 99 (`typeof value === "string"` dropped) — the same test with a missing
  `free-kb`, `free-kb: true` and `floor-kb: null`, which would otherwise throw
  on `.trim()` instead of being refused
