# 🔎 Security sweep — the advisor edit guard (`issue_executor_enforcement.ts`, `issue_edit_guard_cli.ts`)

**Incident:** [#2344](https://github.com/stSoftwareAU/VibeCoder/issues/2344)
(chunk top-up-2344) · **Parent:** #1209

This is the written record for the two modules that entered
`worker/deno/lib/` with the split run's `Edit`/`Write` enforcement:

- `worker/deno/lib/issue_executor_enforcement.ts`
- `worker/deno/lib/issue_edit_guard_cli.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. Both modules are claimed by
**top-up-2344**, and this file is the reading of them.

## `worker/deno/lib/issue_executor_enforcement.ts`

Pure functions plus two path resolvers: the hook decision
(`decideIssueEditHook`), the `--settings` payload that installs the hook
(`buildIssueExecutorHookSettings` / `resolveIssueExecutorHookSettings`), and
the stream summariser (`summariseIssueExecutorSplitRun`).

| Input                | Source                                     | How it is handled                                                                                                  |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| hook payload         | the Claude CLI, over the guard's stdin      | parsed as JSON by the caller; every field — `tool_name`, `agent_id`, `tool_input.file_path` — is read through a `typeof value === "string"` narrowing, never trusted raw |
| raw stream-json      | the agent's own stdout, already captured    | line-by-line `JSON.parse` in a `try`; a malformed line is skipped, never thrown through                             |
| `denoPath`/module path | `Deno.execPath()` and `resolveGuardModulePath` | single-quoted for the shell with `posixSingleQuote` before reaching the hook command                              |

| Property          | Result                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none of its own — it renders a command string the **CLI** later executes; no `Deno.Command`, no `gh`, no `git`                                                                                                                 |
| argv injection    | the two paths interpolated into that command are single-quoted (`posixSingleQuote`), and both are worker-resolved: the agent supplies neither                                                                                   |
| prompt injection  | none — the module renders no prompt text. The denial reason it produces is a repository-authored constant plus the CLI-supplied tool name, which is matched against the `Edit`/`Write` allowlist before it is echoed             |
| trust boundary    | the hook payload is **untrusted input from the constrained party's own session**; the only decision drawn from it is deny/allow, and the default on anything unrecognised is allow, which is the pre-existing behaviour          |
| network           | none                                                                                                                                                                                                                          |
| filesystem        | none of its own; `resolveGuardModulePath` and `resolveGuardDenoDir` stat candidate paths (swept under their own slices)                                                                                                        |
| regex safety      | the matcher string is a literal join of the two tool names. The one regex pair, `ADVISOR_RUN_RECORD_PATTERNS`, is anchored at both ends with no nested quantifier, so it is linear in the path length |
| secret surface    | holds no credential; reads no environment variable directly                                                                                                                                                                    |
| capability grant  | **removes** capability: it can only deny a tool call, never allow one the session did not already permit                                                                                                                       |
| fail direction    | fail-open **by design** at the guard, fail-loud at the record: an unreadable payload is allowed with a `[issue-executor-split]` line on stderr, because failing closed would strand a run whose executors could no longer edit. The advisor-edit count on the run-stats comment is the second, independent record of any edit that got through |
| blast radius      | `lib/claude_runner.ts` (the invocation and the tally), `lib/run_stats.ts` (the optional field), `lib/issue_run_stats_comment.ts` (one line)                                                                                     |

The guard module the hook executes is resolved through
`resolveGuardModulePath` — the read-only checkout, not the writable staged copy
(Issue #1444) — and where the image bakes a read-only Deno seed the child's
`DENO_DIR` is pinned to it (Issue #1448). Both are the existing defences for a
guard the constrained party must not be able to rewrite or feed.

## `worker/deno/lib/issue_edit_guard_cli.ts`

A thin entry point: read stdin, call `decideIssueEditHook`, write the decision
to stdout and the denial line to stderr. It runs under `deno run --quiet
--no-config --no-lock` with **no permission flags at all**, so it can neither
read the filesystem, spawn, nor reach the network — least privilege by
construction.

| Property         | Result                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| permissions      | none granted; stdin/stdout/stderr need no flag                                                                               |
| exit code        | always `0` — a denial is a refused tool call carried in the decision JSON, never a failed run                                 |
| error handling   | a `JSON.parse` failure is reported on stderr with the parser's message and the call is allowed; nothing is swallowed silently |
| output surface   | one JSON object on stdout for a denial, nothing for an allow                                                                  |

## The carve-out

`decideIssueEditHook` allows the advisor's own `Write` of the run's record —
`docs/archive/pr-summaries/pr-summary-*.md` and `.pr_response_message` — which
the prompt requires it to author. The carve-out is matched on the **path the
tool was called with**, an agent-supplied value, so it is deliberately narrow:
two anchored patterns, no directory-traversal allowance, and it widens nothing
the advisor did not already hold — it can only decline to deny a tool the
session already granted.

## The one behaviour worth restating

The denial is enforcement, not a sandbox boundary: the advisor still holds the
`Edit` and `Write` tools, and a hook that failed to run would leave the
prompt instruction (Issue #2343) as the only control. That is why the count is
kept whatever the hook does — `advisorEditCalls` on the run-stats comment is
non-zero exactly when the enforcement did not hold.
