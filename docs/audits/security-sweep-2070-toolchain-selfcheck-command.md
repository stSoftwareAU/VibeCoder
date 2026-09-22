# Security sweep — the `toolchain-selfcheck` command (`commands/toolchain_selfcheck.ts`)

**Issue:** [#2070](https://github.com/stSoftwareAU/VibeCoder/issues/2070)
(chunk top-up-2070, with #2071–#2073) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/commands/` under the launcher-failure fix:

- `worker/deno/commands/toolchain_selfcheck.ts` — added by #2070.

## Why a new slice rather than a line in an old one

The module post-dates every recorded sweep, and appending it to a slice whose
reading never saw it would be a false record. It is claimed by **top-up-2070**,
and this file is the reading of it.

## `worker/deno/commands/toolchain_selfcheck.ts`

The command is a thin CLI surface over `lib/toolchain_selfcheck.ts`
(top-up-1956): it resolves a repository root from `--base-dir` or the working
directory, calls `checkContainerToolchains`, and maps the verdict to a
`CommandResult` with the worker's own exit statuses. Its only caller is the
container build in CI, running inside the freshly built image.

| Property | Result |
| -------- | ------ |
| no new process shape | the command spawns nothing itself; every subprocess is the library's, whose argv allowlists (`COMMAND_NAME`, `MODULE_NAME`) are unchanged and recorded under top-up-1956 |
| the only argument is a path | `--base-dir` is a string used to locate `container/tools.json`; it is never interpolated into a command, and the library reads it with `Deno.readTextFile` alone |
| no filesystem writes, no network, no `gh` | the command writes nothing, opens no socket, and needs `--allow-run` only for the library's probes; CI mounts the checkout read-only |
| no environment sink | the image stamp is read through the library's `EnvLookup`; nothing is set and no secret is read |
| absence of a failure is never a pass | a run outside the image (`verdict.skipped`) is `success: false`, exit 1 — "nothing verified" cannot report green in CI |
| the exit status names the fault | 89 for an image that does not provide a pin, 1 for a manifest fault, so a caller cannot mistake one for the other |
| output is the library's bounded lines | the message is `verdict.lines` joined, each already collapsed and truncated by the library's `summarise` |

### Findings

None.

### Accepted residuals

- **The manifest is trusted input**, as recorded under top-up-1956: the
  command adds no trust boundary and removes none.
- **CI's invocation fetches Deno dependencies inside the image.** The run is
  `--frozen --lock`ed to the checkout's lockfile, so a dependency the lock does
  not name fails the step rather than being resolved.
