# Security sweep — container toolchain self-check (`toolchain_selfcheck.ts`)

**Issue:** [#1956](https://github.com/stSoftwareAU/VibeCoder/issues/1956) (chunk
top-up-1956) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #1956:

- `worker/deno/lib/toolchain_selfcheck.ts` — added by #1956.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record, as 12f's own record
documents. The module is claimed by **top-up-1956**, and this file is the
reading of it.

## `worker/deno/lib/toolchain_selfcheck.ts`

The module reads the checkout's `container/tools.json`, derives one probe per
pinned toolchain, runs each probe as a subprocess and compares the reported
version with the pin. Its caller is `run_worker.ts`, before the worker claims
anything. Both 12a's process shapes and 12c's ingestion shapes apply: it spawns,
and what it spawns is named by a committed manifest.

| Property                                        | Result                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| argv is a list, never a shell string            | `runWithTimeout(executable, args)` reaches `Deno.Command` with an argv array; nothing is interpolated into a shell, and no probe output is ever executed                                             |
| the manifest cannot name an arbitrary program   | the executable must match `COMMAND_NAME` (`^[A-Za-z0-9][A-Za-z0-9._+-]*$`) — no path separator, no metacharacter, no leading dash — and the check refuses the probe rather than running it otherwise |
| a module name cannot smuggle Python             | the `python3 -c` body is built from `versionModule` and re-validated against `MODULE_NAME` (`^[A-Za-z_][A-Za-z0-9_]*$`) after construction, mirroring `container/toolchains/pyyaml.sh`               |
| the manifest is parsed strictly                 | `parseContainerManifest` is the same validator the quality gate uses; a manifest it rejects is a loud failure that blames the _manifest_, never a pass                                               |
| every probe is bounded                          | `TOOLCHAIN_PROBE_TIMEOUT_MS` (15 s) per probe through `runWithTimeout`'s `AbortController`; a binary that hangs on this architecture costs seconds, not the run's watchdog                           |
| output is bounded before it is logged           | `summarise` collapses a probe's stdout and stderr to one line and truncates at 200 characters, so a tool that prints a megabyte cannot fill the run log                                              |
| probe output reaches only the run log           | the lines go to `deps.log` / `deps.logError`, which pass through the logger's own `redactSecrets`; nothing is parsed out of the output but the pinned version                                        |
| no filesystem writes, no network, no `gh`       | the only filesystem call is `Deno.readTextFile` of the manifest; the module opens no socket and spawns no `git`/`gh`                                                                                 |
| no environment sink                             | `env` is read (the image stamp, and `probeEnv` in tests) and never set; no secret is read or written                                                                                                 |
| absence of a failure is never a pass            | an unreadable manifest, a manifest pinning nothing, a refused argv, a timeout, a non-zero exit and a wrong version are each a failed verdict with a reason                                           |
| a version match cannot be satisfied by a prefix | `reportsVersion` requires the pin to stand as a whole token (`1.7.1` does not match an installed `1.7.12`), and the module surface compares exactly                                                  |

### Findings

None.

### Accepted residuals

- **The manifest is trusted input.** `container/tools.json` is a committed file
  of this repository, read from the read-only checkout mount; an attacker who
  can edit it can already change the image. The allowlists above are defence in
  depth against a manifest edit slipping through review, not a trust boundary.
- **A command probe matches the pin anywhere in the output.** A tool that
  printed the pinned version for an unrelated reason — a path carrying it, say —
  would pass. Every pinned tool prints its own version, the token rule above
  bounds the loose half, and the alternative (a per-tool output grammar) would
  be thirteen parsers to keep in step with thirteen upstreams.
- **The probe cost is the tools' own start-up.** All thirteen run concurrently;
  the wall-clock is whatever the slowest interpreter costs on a cold page cache.
  It is paid once per launch, before any claim.
