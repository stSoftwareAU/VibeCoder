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
  running process names is never removed. The process table is not resolved, so
  each cache is looked for under every spelling of its root: the root as given
  (`/tmp`, `$TMPDIR`) as well as its real path (`/private/tmp`,
  `/private/var/folders/...` on macOS). A `CACHEDIR.TAG` is read as at most its
  first 512 bytes, so a huge or sparse file of that name in a shared scratch
  directory is not loaded whole. Sizes come from `du -sk`, or from a bounded
  Deno walk (`walkDirSizeBytes`, no symlinks followed) where `du` cannot run, so
  the Windows `run.ps1` reclaim still stops at floor plus headroom and the
  largest-directories line is size-ordered.
- `worker/deno/lib/config_unknown_keys.ts`: the four `host_cache_reclaim_*` keys
  are known config keys, so setting them no longer prints an "is not recognised
  and will be ignored" warning on every launch.
- `run.sh`: calls the command before deciding to recreate the work volume, both
  before a build and on the steady-state heal step when the image already
  exists, and reports `[WORK_VOLUME_UNRECOVERED]` when a recreate would not
  help. It records the recreate as declined (`workVolumeRecreateDeclined`) only
  when it really declines one: the shortfall gate, the repeat-reading gate, or
  no resettable volume. A recreate the runtime failed is retried on the next
  launch, so it is not reported as declined. A recreate step that ran and left
  the host short (whether or not it recreated a volume), with its reading
  recorded so the next launch declines, sets `workVolumeRecreateUnrecovered`
  (written only then).
- `run.ps1`: has no heal step and no work-volume recreate, so it only runs one
  inline reclaim before its hard disk floor (which re-measures the drive and
  judges what the reclaim left). It does not report `[WORK_VOLUME_UNRECOVERED]`
  and writes neither the declined nor the unrecovered flag; those are `run.sh`
  only.
- `host_disk.ts` / `heavy_build_gate.ts`: the launch-end stop reason no longer
  promises a recreate once the launcher has declined one or a recreate it ran
  left the host short (it says the recreate was tried and is not repeated until
  the free-space reading moves), and names the largest host directories.
- `worker/deno/tests/fixtures/launcher_harness.ts`: the shared Deno stub always
  answers `reclaim-host-caches` (records its arguments and order,
  `STUB_RECLAIM_*`), and the shared `df` stub reads back the free space a
  stubbed reclaim left. The per-file wrappers in the run.sh and run.ps1 launcher
  tests are gone, so no suite that uses the shared harness can run the real
  command against the host's `/tmp`.
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

- `worker/deno/tests/host_cache_reclaim_test.ts` (57 tests at head, all pass):
  - a root reached through a symlink, with a process line naming the cache by
    the alias spelling, keeps the cache (red with the realpath-only guard); a
    positive control removes an unnamed cache through the same alias;
  - a sparse 3 GiB `CACHEDIR.TAG` is read as at most 512 characters and still
    shows its signature; a tag with a long first line and a 2 GiB sparse size is
    skipped for its signature and the run completes. Reading the tag whole turns
    both red (`failed to allocate string; buffer exceeds maximum length`);
  - `walkDirSizeBytes` sums a tree without following a symlink out of it, and
    returns null past its entry budget, its clock or for a missing root;
  - with `du` unable to run, `defaultDirSizeBytes` falls back to the walk, a
    `du` timeout stays null, the reclaim stops at its target on walked sizes and
    `largestHostDirectories` is size-ordered. Replacing the fallback with `null`
    turns two of these red.
- `worker/deno/tests/config_unknown_keys_test.ts`: a record built from the
  exported `HOST_CACHE_RECLAIM_*_KEY` constants gives no unknown-key warning
  (red without the registration). 36 passed.
- `worker/deno/tests/host_disk_recreate_declined_4498_test.ts` (11 tests at
  head, all pass): the stop reason for `recreateUnrecovered` says the recreate
  was tried, will not be repeated until the reading moves, and makes no recreate
  promise; the old-shape reading still gets the promise; the parser reads and
  type-checks the new field; a file on disk reaches the text through the
  monitor. Removing the `recreateUnrecovered` branch turns two red.
- `worker/deno/tests/launcher_harness_reclaim_stub_test.ts` (2 tests, pass): a
  below-floor launch built with the plain shared `setupHarness` records the
  stubbed reclaim and prints the stub's sentinel; an above-floor launch does not
  reclaim. Not red-checked against the unstubbed harness, because that would run
  the real command on this host's `/tmp`.
- `worker/deno/tests/run_sh_launcher_test.ts` (119 tests at head, all pass):
  - on the path where the image already exists, the reclaim runs, and one that
    recovers the host leaves the trim-refused volume intact; a reclaim that does
    not recover runs before the volume removal; a reclaim that exits non-zero
    logs `[HOST_CACHE_RECLAIM] failed` and the launch carries on;
  - a volume removal the runtime fails leaves `workVolumeRecreateDeclined` false
    and writes no `workVolumeRecreateUnrecovered`;
  - a recreate that leaves the host short writes
    `workVolumeRecreateUnrecovered: true` with declined false, and the next
    launch recreates nothing and writes declined true. Dropping the
    `work_volume_recreate_unrecovered=true` assignment turns it red.
- The suites that build launches through the shared harness
  (`launcher_parity_test`, `launcher_signal_readiness_test`,
  `launcher_egress_probe_test`, `launcher_toolchain_selfcheck_test`,
  `run_sh_upgrade_test`, `outcome_record_gate_test`,
  `recovery_authority_4417_test`, `run_ps1_launcher_test`) ran with 121 passed,
  0 failed, together with the new harness test.

Not covered: a `du` timeout leaves a cache unmeasured (null), so the stop rule
cannot credit its removal and the largest-directories line shows it as
`(unmeasured)`; that is rare and reported rather than guessed.

## Mutation check (PR #4500 review)

- `worker/deno/lib/host_cache_reclaim.ts:407` — dropped operand
  `!info.isSymlink`: exempt (untestable): equivalent mutant. `Deno.lstat` never
  follows a link, so an entry that is a symlink reports `isDirectory: false` and
  the first operand already excludes it. The other nine mutants listed for lines
  224, 405–407 and 433 are killed by new tests in
  `worker/deno/tests/host_cache_reclaim_test.ts`, each re-run red against the
  mutation and green on the head.
