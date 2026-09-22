# 🔎 Security sweep — the PR-title read (`pr_title_read.ts`)

**Issue:** [#2103](https://github.com/stSoftwareAU/VibeCoder/issues/2103) (chunk
top-up-2103) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2103:

- `worker/deno/lib/pr_title_read.ts` — added by #2103.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2103**, and this file is the reading of it.

## `worker/deno/lib/pr_title_read.ts`

The module makes one read-only GitHub call and returns its trimmed stdout. It
spawns nothing itself, touches no filesystem path, and holds no state.

| Input       | Source                                                                       | How it is handled                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`      | the worker's own scan, an `owner/repo` from the monitored-repo allowlist     | passed as **one argv element** after `--repo`, never through a shell and never concatenated into another argument                                                                                                                                       |
| `prNumber`  | the worker's own scan — a `number`, so the type forbids an argv-shaped value | stringified into one argv element                                                                                                                                                                                                                       |
| `gh` stdout | GitHub — the PR title, which a PR author controls, so **untrusted**          | trimmed and returned as data. It reaches only the Graft query, which its two callers hand to `graft ask --source` as a single argv element (swept under #2099); it is never executed, never used as a path, and never interpolated into another command |

| Property          | Result                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | the module spawns nothing. It calls the `gh` runner its caller injects, which in production is `deps.github.runGhCommand` — the fleet's own chokepoint — so the `gh` spawn scan sees it clean                                                                                             |
| argv construction | the argv is a literal array with `repo` and `String(prNumber)` as elements. No shell, no `-c`, no string concatenation into an argument                                                                                                                                                   |
| `gh` verb         | `pr view --json title` is **read-only**. Nothing here writes to a PR, an issue or a label, so the lifecycle guards are not in play                                                                                                                                                        |
| regex safety      | no regex of its own; `String.prototype.trim` only                                                                                                                                                                                                                                         |
| filesystem        | none. No path is read, written or deleted                                                                                                                                                                                                                                                 |
| network           | only the caller's `gh` runner                                                                                                                                                                                                                                                             |
| resource bounds   | one call, no retry and no loop. Bounding the call's own duration is the injected runner's business, which in production is the timeout-bearing chokepoint                                                                                                                                 |
| secret surface    | holds no credential. The error messages carry `owner/repo#N` and the `gh` failure text, and that text reaches the log through the caller's `logger.warn`, which already redacts                                                                                                           |
| fail direction    | fail-loud: a throwing `gh` is caught and returned as a `Result` error naming the repo, the PR and the cause; a clean exit that printed nothing is **also** an error rather than an empty title, so "no failure marker" can never read as success. The function neither throws nor rejects |
| blast radius      | on a host with `graft_context.enabled` false (the default) neither caller reaches the module at all. On an enabled host the worst outcome is a warned, title-less Graft query — the bundle is an accelerator, so nothing fails                                                            |

### The untrusted title, named

The title is PR-author-controlled text and it lands in a prompt — inside the
Graft query, and therefore inside whatever bundle Graft selects for it. That is
the same posture #2099 recorded for the query as a whole: the query is one argv
element, and the bundle it produces is rendered by `formatGraftContextSection`,
which redacts secrets, scrubs delimiter-shaped patterns and wraps the text in a
fence it cannot close. A title carrying prompt-injection text is therefore data
behind an untrusted fence, exactly as the issue body already is on the
issue-shaped runs.
