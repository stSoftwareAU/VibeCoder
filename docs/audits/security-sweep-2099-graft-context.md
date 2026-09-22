# 🔎 Security sweep — the Graft runner (`graft_context.ts`)

**Issue:** [#2099](https://github.com/stSoftwareAU/VibeCoder/issues/2099) (chunk
top-up-2099) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2099:

- `worker/deno/lib/graft_context.ts` — added by #2099.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2099**, and this file is the reading of it.

## `worker/deno/lib/graft_context.ts`

The module spawns two subprocesses, appends one line to a file inside the clone,
reads one JSON file from the clone, and renders one prompt section. Each is read
below.

| Input                             | Source                                                              | How it is handled                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                           | the worker, derived from the issue under work — untrusted           | passed as **one argv element** to `graft ask --source`, never through a shell, and truncated to 64 KiB of UTF-8 on a code-point boundary so an over-long query cannot fail the whole `execve` with `E2BIG`. A cut is announced on a `[GRAFT_QUERY_TRUNCATED]` line rather than hidden                           |
| `repoDir`                         | the worker's own checkout path                                      | used only as `cwd` and as the prefix of the two paths read/written; never interpolated into an argv element                                                                                                                                                                                                     |
| `git rev-parse --git-path` stdout | git                                                                 | trimmed, refused when empty, and used as a path only — a relative answer is joined onto `repoDir`, an absolute one is taken as given (the lane-worktree case)                                                                                                                                                   |
| `wiring.json`                     | written by `graft` into the agent-writable clone                    | read link-free, `JSON.parse`d inside a `try`, and type-tested before any property is read. Only two integers are derived from it; no string from it reaches an argv, a path or a prompt                                                                                                                         |
| the bundle                        | `graft ask` stdout — repository source, so branch-author controlled | never executed, never used as a path. It reaches the prompt only through `formatGraftContextSection`, which redacts secrets, scrubs delimiter-shaped patterns and wraps the text in a `codeFenceFor` fence it cannot close — the same treatment `formatCodebaseMapSection` gives the codebase map (Issue #3706) |

| Property          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| spawn chokepoints | `graft` is spawned only through `runWithTimeout` and `git` only through `runGitCommand`; the module constructs no `Deno.Command` of its own, so both chokepoint scans see it clean                                                                                                                                                                                                                                                                                                                                             |
| argv construction | every `graft` argv is a literal array plus, for `ask`, the single truncated query element. No shell, no `-c`, no string concatenation into an argument                                                                                                                                                                                                                                                                                                                                                                         |
| child environment | `DO_NOT_TRACK=1` is added, nothing is removed. The child inherits the worker environment (it needs `PATH` and `HOME` to run at all), which is the same posture every other `runWithTimeout` caller has                                                                                                                                                                                                                                                                                                                         |
| telemetry         | `DO_NOT_TRACK=1` on both invocations — the worker reads private repositories and nothing about them leaves the host                                                                                                                                                                                                                                                                                                                                                                                                            |
| regex safety      | one fixed regex of its own, `/\s+/g` in `detail()`, plus the shared sanitiser's rules (already swept under #1274). `\s+` has no alternation or nested quantifier, so it is linear in the input and cannot backtrack catastrophically — which matters because its input is unbounded subprocess stderr: `detail()` collapses first and truncates to `MAX_REASON_DETAIL_CHARS` afterwards, so the bound is on what reaches the log, not on what the regex scans                                                                  |
| filesystem        | two paths, both inside the clone. The exclude file is read with `readTextFileNoFollow` and appended with `appendNoFollow`, so a planted symlink or hard link is **refused** rather than followed — the clone is agent-writable and persists between runs (Issue #1234, #1239). `wiring.json` is read link-free for the same reason. Nothing is deleted                                                                                                                                                                         |
| path traversal    | neither path is built from untrusted text: `GRAFT_WIRING_PATH` is a constant and the exclude path comes from git. A hostile `--git-path` answer could only be produced by a git the worker already trusts to run every other command                                                                                                                                                                                                                                                                                           |
| network           | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| resource bounds   | the build is capped at 300 s and the ask at 30 s by `runWithTimeout`, which kills the child on expiry. The query is capped at 64 KiB. The bundle is deliberately **uncapped** — it is the payload — and is bounded downstream by the prompt budget, not here                                                                                                                                                                                                                                                                   |
| secret surface    | holds no credential. Diagnostics are bounded to 300 characters and single-lined before they reach the log, and the bundle passes through `redactSecrets` inside `sanitiseDelimiterPatterns` before it reaches the prompt (pinned by `a credential in the bundle is redacted before it is fenced (Issue #2099)`, which plants a token-shaped string and asserts it does not survive into the section)                                                                                                                           |
| fail direction    | fail-loud-but-never-fatal: every fault logs one `[GRAFT_UNAVAILABLE] <reason>` line at `warn` and returns `status: "failed"`. There is no path that returns `ok` without a bundle and both figures — an ask that exits 0 having printed nothing is itself a `failed` outcome (pinned by `a zero-exit ask returning an empty bundle fails rather than reporting ok`) — so "no failure marker" can never read as success. The function neither throws nor rejects — a seam that throws is caught and reported as a spawn failure |
| blast radius      | on a host with `graft_context.enabled` false (the default) the module spawns nothing and returns `off` at once. On an enabled host the worst outcome is a missing bundle and a recorded `failed` status                                                                                                                                                                                                                                                                                                                        |

### The one deliberate risk, named

`/graft/` is written to the clone's `info/exclude` **before** the build, so the
graph survives the next run's `git reset --hard` + `git clean -fd`. That means
the module deliberately leaves an ignored, executable-bearing-looking directory
in a clone that persists between runs — the class of persistence
`ignored_path_clean.ts` exists to erase (Issue #1443).

It is accepted, not overlooked. `graft/` holds a tree-sitter graph and its
cache, not binaries the worker executes: nothing in the tree runs anything from
`graft/`, and the only file read from it is `wiring.json`, whose contents reach
nothing but two integers. The directory names in the layout (`graft`, `.graph`)
are absent from `EXECUTABLE_IGNORED_DIRS`, so the scoped clean leaves it alone
by construction rather than by accident — a test pins that, and a future Graft
release that writes a `build/` or `dist/` **inside** `graft/` would have it
erased each run (a rebuild cost, not a fault). The residual is the same shape as
R12 in `docs/THREAT-MODEL.md`.

No finding.
