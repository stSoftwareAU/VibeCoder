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
  running process names is never removed. The process table is each process's
  command line (`ps -axww -o command=`) plus the file names that
  `lsof -w -a -d cwd,txt -Fn` reports (`cwd,txt,mem` on Linux): its working
  directory, its program text and, on Linux, its memory-mapped files, so a
  server started as `./target/release/server` holds its cache through the
  executable path lsof reports. Ordinary open file descriptors are not read.
  Windows reads each process's `CommandLine` and `ExecutablePath` from
  `Win32_Process`. When lsof cannot be started, times out, or exits non-zero
  naming no file, the snapshot throws, so the reclaim removes nothing and logs
  `[HOST_CACHE_RECLAIM] process table unreadable — removed nothing: …`, as for
  a `ps` failure. That run still exits non-zero and still prints the
  `largest host directories:` line, which `run.sh` reads before it checks the
  exit status. The process table is not resolved, so each cache is looked for
  under every spelling of its root: the root as given
  (`/tmp`, `$TMPDIR`) as well as its real path (`/private/tmp`,
  `/private/var/folders/...` on macOS). A `CACHEDIR.TAG` is read as at most its
  first 512 bytes, so a huge or sparse file of that name in a shared scratch
  directory is not loaded whole. Sizes come from `du -sk`, or from a bounded
  Deno walk (`walkDirSizeBytes`, no symlinks followed) where `du` cannot run, so
  the Windows `run.ps1` reclaim still stops at floor plus headroom and the
  largest-directories line is size-ordered.
- Host config and removal safety (PR #4500 review): the launchers pass
  `--base-dir` and the command resolves the config with `resolveHostConfigPath`
  (`CONFIG_FILE`, else `CONFIG_PATH`, else `<checkout>/.config.json`), as
  `container-launch-plan` does, so a moved config's `host_cache_reclaim_*`
  settings are honoured. A cache is removed only when it and every directory
  between its root and it are owned by the running user (`resolveOwnUid`, which
  stats `$HOME` because `Deno.uid()` needs a permission the launchers do not
  grant) and are not group- or other-writable, and its `realPath` is still
  itself immediately before the delete; otherwise it is skipped with a reason.
  The root is the configured boundary and is not judged; Windows, which has no
  uid, gets only the real-path check. `FsStat` gained `uid` and `mode`, and
  `HostCacheReclaimDeps` gained `ownerUid`.
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
- `docs/CONFIGURATION.md`, `docs/CONTAINER.md`: document the new settings, the
  config file the reclaim reads and the removal checks.

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
- the `value >= 0` check in `reclaim_host_caches.ts` (dropped) —
  `command: garbage numeric flags are refused` with `free-kb: -1` and
  `floor-kb: -1`
- the `typeof value === "string"` check in `reclaim_host_caches.ts` (dropped) —
  the same test with a missing `free-kb`, `free-kb: true` and `floor-kb: null`,
  which would otherwise throw on `.trim()` instead of being refused

## Test Plan

- `worker/deno/tests/host_cache_reclaim_test.ts` (81 tests at head, all pass; 77
  `Deno.test` calls, one registered for two variables and one for four lsof
  failures):
  - held open on Windows: a stand-in for `Get-CimInstance` whose CommandLine is
    relative (`target\release\server.exe`) and whose ExecutablePath is inside a
    stale cache keeps the cache; with the query reading only `$_.CommandLine`
    it goes red (`the cache is kept`). A positive control removes a cache that
    neither names;
  - lsof failures: an lsof that is not installed, fails to spawn, times out, or
    exits 1 naming no file removes nothing, sets `processTableError`, and the
    command logs `[HOST_CACHE_RECLAIM] process table unreadable — removed
    nothing` with the reason. With the previous tolerant fallback all four go
    red. An lsof that exits 1 but still names files is used: with a 2 GiB floor
    the reclaim removes the idle cache and goes on to judge the held one, which
    is kept and skipped as `held open`. A mutant that keeps the `n` lines only
    when lsof exits 0 turns it red (the earlier 1 GiB fixture stopped before
    judging the held cache and passed against that mutant). With lsof not
    installed, the command still names the largest host directories, largest
    first, and the run is still unsuccessful (red before the fix: no such
    line);
  - held open through lsof: a stale cache whose only mention is an lsof `txt`
    line (a server started as `./target/release/server` from the repo, so ps
    shows a relative argv and the cwd is the repo) is kept on both macOS
    (`cwd,txt`) and Linux (`cwd,txt,mem`), and a file only memory-mapped from a
    cache keeps it on Linux. The lsof stand-in reports only the descriptor types
    `-d` names, like the real tool, so with the previous `-d cwd` both go red
    (`the cache is kept`); a positive control with nothing inside the cache in
    lsof removes it;
  - host independence: every fixture directory is 0755 and every reclaim gets an
    explicit `ownerUid` read with lstat from a temporary directory the test
    makes. The suite gives 81 passed under `umask 002`, `022` and `077`, with
    `$HOME` unset and with `$HOME` owned by another uid; before this change
    `umask 002` gave 13 failures, and an unset or foreign-owned `$HOME` 12;
  - config: with `CONFIG_FILE` or `CONFIG_PATH` naming a moved file that sets
    `host_cache_reclaim_enabled: false`, nothing is removed, and the same setup
    without the variable (the checkout's enabled file) removes the cache; a
    relative `CONFIG_FILE` resolves against `--base-dir`; two different files
    are refused. The launcher tests (`run_sh_launcher_test.ts`,
    `run_ps1_launcher_test.ts`) now assert `--base-dir` is the checkout and no
    `--config` is passed, because the file is resolved in the command, not the
    launcher; run.sh with `--config "${BASE_DIR}/.config.json"` restored turns
    the run.sh test red;
  - removal safety, each red when its check is removed on its own: a foreign uid
    on an ancestor, on the candidate, or none to read; group- and other-writable
    bits on an ancestor and on the candidate, and no mode; an unknown running
    user on POSIX; a moved or vanished real path; a symlink swapped in for an
    ancestor during the size measurement (the real race, with a same-named
    directory outside the root left untouched); the world-writable foreign root
    is not judged (red when the root is included);
  - size order: `largestHostDirectories` and the du-unavailable walk use sizes
    that run against name order with more directories than `n`, and the command
    test has ten directories whose sizes grow with the name and names the eight
    largest, largest first. Dropping the size term from the comparator turns
    three tests red.
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

- `worker/deno/lib/host_cache_reclaim.ts`, `walkDirSizeBytes` — dropped operand
  `!info.isSymlink`: exempt (untestable): equivalent mutant. `Deno.lstat` never
  follows a link, so an entry that is a symlink reports `isDirectory: false` and
  the first operand already excludes it. The other nine mutants listed for the
  tag-prefix read, the size walk and the `du` figure are killed by new tests in
  `worker/deno/tests/host_cache_reclaim_test.ts`, each re-run red against the
  mutation and green on the head.

## Review fixes (PR #4500, second round)

- Config path: `run.sh` and `run.ps1` pass `--base-dir`; the command resolves
  the host config like the launch plan. Other launcher-side readers of the
  config checked: `container-launch-plan`, `log-dir`,
  `container-restart-backoff` and `worker-checkout-update` already use
  `resolveHostConfigPath`; the reclaim was the only launcher call pinning
  `.config.json`.
- Delete safety: ownership and mode of the candidate and its ancestors, and a
  real-path check, immediately before each removal (see What changed).
- Size order: fixtures run against name order. The comparator is unchanged.
- Not checked: in production, the ownership check on a host whose umask leaves
  directories group-writable (for example 002) skips every cache with a visible
  reason rather than removing it; the real tool was not run against a
  foreign-owned `/tmp` tree, whose ownership is injected in the tests. The test
  fixtures no longer depend on the umask (see the fourth round).

## Mutation check (PR #4500 review, third round)

- `host_cache_reclaim.ts` `lstat` property `mode` (deleted) — killed by
  `fs: the real lstat reports the permission bits and the owner of a directory`
  (re-run with `--no-check`, since the mutant is also a type error).
- `host_cache_reclaim.ts` operand `root.length < known.length` (replaced with
  false) — killed by
  `removal: a candidate reached from two roots is judged
  from the shallower root, whichever root is listed first`.
- Both re-run red against the mutation and green on the head
  (`host_cache_reclaim_test.ts`, 80 tests at that round).

## Review fixes (PR #4500, fourth round)

- Held-open guard: `defaultProcessSnapshot` asks lsof for `cwd,txt` (and `mem`
  on Linux, `lsofDescriptors`), keeps only the `-Fn` `n` lines, and takes its
  runner and OS as parameters so a test can supply the process table.
  `docs/CONTAINER.md` now says exactly what is read.
- Test host state: `makeCache` sets the directories it creates to 0755, and
  `reclaimDeps` (and so `commandDeps`) pass `ownerUid` from the test's own
  temporary directory instead of `resolveOwnUid()`, which stats `$HOME`.

## Review fixes (PR #4500, fifth round)

- Windows held-open guard: the snapshot query is
  `Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine; $_.ExecutablePath }`
  (`WINDOWS_PROCESS_QUERY`), so a relative command line no longer hides a
  running executable inside a cache.
- POSIX: an lsof that cannot run, times out, or exits non-zero naming no file
  no longer falls back silently to `ps` alone. The snapshot throws and the
  reclaim removes nothing that launch, with the reason in the launch log.
  `docs/CONTAINER.md` says so and names the Windows properties read. A host
  without lsof therefore reclaims nothing until lsof is installed.

## Review fixes (PR #4500, sixth round)

- The test `an lsof that exits 1 but still names files is used` now uses a
  2 GiB floor, so the held cache is judged after the idle one is removed, and
  asserts it is skipped as `held open`. It goes red against a mutant that drops
  the lsof `n` lines when lsof exits non-zero.
- `reclaim-host-caches`: when the process table cannot be read, the command
  still sizes the roots and prints `largest host directories: …` after the
  `process table unreadable` line, and still exits non-zero. A host without
  lsof therefore still gets the list in `[WORK_VOLUME_UNRECOVERED]` and
  `host-disk.json`. A new command test with a missing lsof covers it (red
  before, green after), and `docs/CONTAINER.md` says so.
