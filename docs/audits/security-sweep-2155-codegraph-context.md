# 🔎 Security sweep — the CodeGraph runner (`codegraph_context.ts`)

**Issue:** [#2155](https://github.com/stSoftwareAU/VibeCoder/issues/2155) (chunk
top-up-2155) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2155:

- `worker/deno/lib/codegraph_context.ts` — added by #2155.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2155**, and this file is the reading of it.

## `worker/deno/lib/codegraph_context.ts`

The module spawns two subprocesses (`codegraph init --yes` or `codegraph sync`,
then `codegraph status --json`), resolves one path through `git`, appends one
line to a file inside the clone, and returns four numbers. It renders no prompt
section — the agent reaches CodeGraph over MCP — so no text from the index ever
reaches a model turn through this module.

| Input                                    | Source                                               | How it is handled                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoDir`                                | the worker's own checkout path                       | used only as `cwd`, as the prefix of the two paths read/written, and inside a diagnostic; never interpolated into an argv element                                                  |
| `enabled`, `providerId`                  | the host config and the run's routing                | compared, never rendered into an argv or a path                                                                                                                                    |
| `git rev-parse --git-path` stdout        | git                                                  | trimmed, refused when empty, and used as a path only — a relative answer is joined onto `repoDir`, an absolute one is taken as given (the lane-worktree case)                      |
| `codegraph status --json` stdout         | written by `codegraph` from the agent-writable clone | `JSON.parse`d inside a `try`, type-tested before any property is read, and reduced to two non-negative integers. No string from it reaches an argv, a path, a log line or a prompt |
| the tool tally (`countCodegraphQueries`) | the provider's own stream, parsed upstream           | keys are matched against two fixed names and values summed only when finite; a malformed tally yields a number, never a throw                                                      |

| Property          | Result                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | `codegraph` is spawned only through `runWithTimeout` and `git` only through `runGitCommand`; the module constructs no `Deno.Command` of its own, so both chokepoint scans see it clean                                                                                                                                                                                                                                      |
| argv construction | every `codegraph` argv is a literal array (`["init", "--yes"]`, `["sync"]`, `["status", "--json"]`). No shell, no `-c`, no string concatenation into an argument, and nothing untrusted reaches an argv at all                                                                                                                                                                                                              |
| child environment | `CODEGRAPH_NO_DAEMON=1` is added as a fresh copy per call, nothing is removed. The child inherits the worker environment (it needs `PATH` and `HOME` to run at all), which is the posture every other `runWithTimeout` caller has                                                                                                                                                                                           |
| network           | none. CodeGraph indexes locally and calls no model                                                                                                                                                                                                                                                                                                                                                                          |
| regex safety      | one fixed, linear regex (`/\s+/g`) over a diagnostic already bounded to 300 characters                                                                                                                                                                                                                                                                                                                                      |
| filesystem        | one path written — the clone's `info/exclude`, read with `readTextFileNoFollow` and appended with `appendNoFollow`, so a planted symlink or hard link is **refused** rather than followed (Issue #1234, #1239) — and one `lstat` of `<repoDir>/.codegraph`. Nothing is deleted, and an unreadable `.codegraph` is a reported failure rather than a silent "no index"                                                        |
| path traversal    | neither path is built from untrusted text: `.codegraph` is a constant and the exclude path comes from git. A hostile `--git-path` answer could only be produced by a git the worker already trusts to run every other command                                                                                                                                                                                               |
| resource bounds   | the index step is capped at 300 s and the figures read at 30 s by `runWithTimeout`, which kills the child on expiry. `CODEGRAPH_NO_DAEMON=1` also means no watcher process outlives the run                                                                                                                                                                                                                                 |
| secret surface    | holds no credential. Diagnostics are single-lined and bounded to 300 characters before they reach `logger.warn`, which redacts secrets at the logger                                                                                                                                                                                                                                                                        |
| fail direction    | fail-loud-but-never-fatal: every fault logs exactly one `[CODEGRAPH_UNAVAILABLE] <reason>` line at `warn` and returns `status: "failed"`. No path returns `ok` without both counts — an index whose figures cannot be read is `failed`, not a graph of zero nodes — so "no failure marker" can never read as success. The function neither throws nor rejects; a seam that throws is caught and reported as a spawn failure |
| blast radius      | with the switch off (the default) the module spawns nothing and returns `off` at once, and a Gemini-routed run returns `unsupported` without spawning. On an enabled host the worst outcome is a missing index and a recorded `failed` status                                                                                                                                                                               |

### The one deliberate risk, named

`/.codegraph/` is written to the clone's `info/exclude` **before** the index
step, so the index survives the next run's `git reset --hard` + `git clean -fd`.
That means the module deliberately leaves an ignored directory in a clone that
persists between runs — the class of persistence `ignored_path_clean.ts` exists
to erase (Issue #1443).

It is accepted, not overlooked. At v1.6.0 `.codegraph/` holds files and no
subdirectory: the SQLite index and its sidecars, an indexing lock, the daemon
lock/socket/log (none written under `CODEGRAPH_NO_DAEMON=1`), an error log, a
lessons database, and a `.gitignore` CodeGraph writes itself. Nothing in the
tree executes anything from it, and the only thing read back out of it is two
integers via `codegraph status --json`. The one directory name in the layout
(`.codegraph`) is absent from `EXECUTABLE_IGNORED_DIRS`, so the scoped clean
leaves it alone by construction rather than by accident —
`the index survives the cleans a run starts with,
where an ignored dependency directory does not`
pins that against the real `git clean` invocations, with `node_modules/` as the
control that is erased. A future CodeGraph release writing a `build/` or `dist/`
**inside** `.codegraph/` would have it erased each run (a rebuild cost, not a
fault). The residual is the same shape as R12 in `docs/THREAT-MODEL.md`, and the
same one #2099 accepted for `graft/`.

The index is also the repository's own source, restructured: a private repo's
code stays on the host, since CodeGraph indexes entirely locally and this module
adds no network path.

### One thing named rather than changed

CodeGraph carries anonymous usage telemetry, which its `TELEMETRY.md` says is
disabled by the cross-tool `DO_NOT_TRACK=1` (the variable #2099 sets for Graft).
This module does not set it: #2155 pins the child environment to
`CODEGRAPH_NO_DAEMON=1` for the index step and for the MCP entry alike, and
setting it on one but not the other would be worse than setting it on neither.
The payload its own documentation describes carries no repository content —
counts, a machine id and a version — so this is a posture item for the host that
turns the switch on, not a leak of the code being indexed.

No finding.
