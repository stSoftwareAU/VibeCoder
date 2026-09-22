# Security sweep — the RTK run module (`rtk_output.ts`)

**Issue:** [#2382](https://github.com/stSoftwareAU/VibeCoder/issues/2382) (chunk
top-up-2382) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2382:

- `worker/deno/lib/rtk_output.ts` — added by #2382.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2382**, and this file is the reading of it.

## `worker/deno/lib/rtk_output.ts`

Unlike the #2380 parser, this module **spawns a third-party binary**. It decides
whether RTK is wired into a run, and if so runs two fixed `rtk` invocations —
`rtk --version` as a preflight, and `rtk gain --all --format json` before and
after the run — to produce the saved-token delta. It reads no file, opens no
socket itself, and holds no credential.

Untrusted inputs, and how each reaches the output:

| Input                            | Source                                                                                    | How it is handled                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                        | the `.config.json` switch, already parsed and validated by `rtk_output_config.ts` (#2380) | a boolean; false short-circuits to the frozen `RTK_OFF` before anything is spawned                                                                                                      |
| `providerId`                     | the worker's provider registry, a fixed closed set                                        | compared for equality against `CLAUDE_PROVIDER_ID`; echoed into `result.provider` and the status line only, never into argv, a path or a shell                                          |
| `env`                            | the caller's own environment overlay                                                      | passed through to `runWithTimeout`, which merges it onto the inherited environment; this module neither reads nor constructs an environment variable, and never logs one                |
| `cwd`                            | the caller's worktree path                                                                | passed through unchanged as the subprocess working directory; never interpolated into a string                                                                                          |
| `rtk` stdout (the gain JSON)     | a third-party binary on the host                                                          | parsed inside `try`/`catch`; the shape is narrowed by `recordOf`, and a `summary.total_saved` that is not a finite, non-negative number is refused as an error rather than read as zero |
| `rtk` stderr and thrown messages | the same binary                                                                           | only ever reach a log line, through `detail()` — whitespace collapsed to one line and truncated at 300 characters                                                                       |

| Property                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no shell, no argv construction | no shell anywhere: `runWithTimeout` spawns `rtk` with an argv array. Both argvs are module constants (`["--version"]`, `["gain", "--all", "--format", "json"]`) with nothing derived from an issue, a comment, a repository or a config value, so there is no interpolation to escape                                                                                                                                          |
| environment                    | reads none of its own; the caller's optional overlay is forwarded verbatim and never logged                                                                                                                                                                                                                                                                                                                                    |
| filesystem                     | reads and writes none. RTK's own store (`$XDG_DATA_HOME/rtk/tracking.db`) is touched by the `rtk` binary, not by this module                                                                                                                                                                                                                                                                                                   |
| network                        | none                                                                                                                                                                                                                                                                                                                                                                                                                           |
| regex safety                   | one regex, `/\s+/g` in `detail()` — a single character class with no nested quantifier and no alternation, so it cannot backtrack catastrophically on hostile subprocess output                                                                                                                                                                                                                                                |
| secret surface                 | nothing secret is read. Subprocess stderr could in principle carry a path, so it is bounded and flattened by `detail()` before it reaches a log; no environment value, token or config value is ever logged                                                                                                                                                                                                                    |
| resource bounds                | every invocation is capped by `RTK_PREFLIGHT_TIMEOUT_MS` (10s) inside `runWithTimeout`; preparation spawns at most two (one preflight, one gain read) and each `record()` call one more, so the count is the caller's — `record()` is not guarded against being called twice; `JSON.parse` runs on already-bounded subprocess output and its failure is caught; every diagnostic is truncated at `MAX_REASON_DETAIL_CHARS`     |
| fail direction                 | fail-loud but never fatal: every seam outcome — a spawn failure, a timeout, a non-zero exit, unparseable JSON, a missing figure — logs exactly one `[RTK_UNAVAILABLE] <reason>` warning and records `failed`. `prepareRtkRun` never rejects, so an accelerator that is missing or broken degrades the run rather than failing it, and a `failed` or `unsupported` preparation returns no hook settings and an unchanged prompt |

No finding. Three deliberate decisions are worth recording:

1. **An unreadable gain is an error, not a zero.** Reporting "nothing saved"
   when the store could not be read would put a false figure on the trial page;
   the figure is left absent instead.
2. **The delta is clamped at zero.** `VIBE_WORK_ROOT/.container-state` is one
   durable state root per volume, not one per lane, so a sibling container
   writing the same `tracking.db` can leave the second read lower than the
   first. `savedTokens` is RTK's own indicative figure; the trial bar is read
   from run-stats tokens and cost, never from this number.
3. **The hook and the prompt line are indivisible.** A single `wired` flag
   drives both, so the agent can never be told output is condensed while no hook
   is installed, nor have output condensed with no recall instructions.
