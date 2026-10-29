# Reclaim stale host build caches when the host is below its disk floor

Closes #4498.

A host sat below its disk floor for about 25 hours while roughly 150 GB of it
was stale cargo build output the worker could have removed. Recreating the work
volume cannot return that space, so the launcher now asks the worker to remove
it.

## What changed

- `reclaim-host-caches` command (`worker/deno/commands/reclaim_host_caches.ts`,
  `worker/deno/lib/host_cache_reclaim.ts`): removes stale cargo build caches
  from the host's scratch and source roots when free space is under the floor,
  and logs the largest host directories when that is not enough. A cache a
  running process names is never removed. The process table is not resolved,
  so each cache is looked for under every spelling of its root: the root as
  given (`/tmp`, `$TMPDIR`) as well as its real path (`/private/tmp`,
  `/private/var/folders/...` on macOS).
- `worker/deno/lib/config_unknown_keys.ts`: the four `host_cache_reclaim_*`
  keys are known config keys, so setting them no longer prints an "is not
  recognised and will be ignored" warning on every launch.
- `run.sh` / `run.ps1`: call the command before deciding to recreate the work
  volume, both before a build and on the steady-state heal step when the image
  already exists, and report `[WORK_VOLUME_UNRECOVERED]` when a recreate would
  not help. `run.sh` records the recreate as declined
  (`workVolumeRecreateDeclined`) only when it really declines one: the
  shortfall gate, the repeat-reading gate, or no resettable volume. A recreate
  the runtime failed is retried on the next launch, so it is not reported as
  declined.
- `host_disk.ts` / `heavy_build_gate.ts`: the launch-end stop reason no longer
  promises a recreate once the launcher has declined one, and names the largest
  host directories.
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

## Test Plan

- `worker/deno/tests/host_cache_reclaim_test.ts`: a root reached through a
  symlink, with a process line naming the cache by the alias spelling, keeps
  the cache (red with the realpath-only guard). A positive control removes an
  unnamed cache through the same alias. 46 passed.
- `worker/deno/tests/config_unknown_keys_test.ts`: a record built from the
  exported `HOST_CACHE_RECLAIM_*_KEY` constants gives no unknown-key warning
  (red without the registration). 36 passed.
- `worker/deno/tests/run_sh_launcher_test.ts` on the path where the image
  already exists:
  - the reclaim runs, and one that recovers the host leaves the trim-refused
    volume intact;
  - a reclaim that does not recover runs before the volume removal;
  - a reclaim that exits non-zero logs `[HOST_CACHE_RECLAIM] failed` and the
    launch carries on;
  - a volume removal the runtime fails leaves `workVolumeRecreateDeclined`
    false.

  Removing the heal-step reclaim call turns the first two red. Setting the
  declined flag for every unrecovered report turns the last one red. The whole
  launcher suite ran with 114 passed. The four Issue #980 extension-build cases
  that failed also fail on unmodified `main` in the same sandbox, whose
  `@std/crypto` stand-in cannot hash a stream.
