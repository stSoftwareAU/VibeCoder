# 🔎 Security sweep — the Graft pull-side wiring (`graft_run.ts`)

**Issue:** [#2314](https://github.com/stSoftwareAU/VibeCoder/issues/2314)
(chunk top-up-2314) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2314:

- `worker/deno/lib/graft_run.ts` — added by #2314.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record. The module is
claimed by **top-up-2314**, and this file is the reading of it.

## `worker/deno/lib/graft_run.ts`

The module spawns nothing itself. It takes the outcome `graft_context.ts`
(swept under [top-up-2099](security-sweep-2099-graft-context.md)) already
produced, resolves one provider descriptor, and returns three pure decisions:
the prompt to send, the MCP request to make, and how to fold a completed
invocation's tool tally into the result. It is the Graft counterpart of
`codegraph_run.ts` ([top-up-2159](security-sweep-2159-codegraph-run.md)) and
holds the same invariant.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `result` | the collection outcome the worker itself produced | its `status` is compared; its `queries` field is the only thing written, and only by `record` |
| `repoDir` | the worker's own checkout path, optional on the CI-fix path | tested for absence (absent or empty) and otherwise handed to `graftMcpServer()`, which places it as **one argv element** (`graft mcp <dir>`) with no shell; never interpolated into a prompt. A run that names no checkout is withheld the tools rather than handed half the pair |
| `agentProvider` | the repo pin or the per-invocation selection, both worker-owned | handed to `selectAgentProvider`, which validates it; a throw is caught, reported as `[GRAFT_TOOLS_UNAVAILABLE]` and the tools are withheld |
| `prior` (in `mcpConfig`) | the request the run already had — a boolean browser grant or CodeGraph's request | spread into a **new** object; the caller's object is never mutated. A boolean becomes `playwright: prior === true`, so a run with no request gains the server and no browser |
| `prompt` (in `applyPrompt`) | the built issue/planning/question/PR prompt | **appended to**, never parsed or rewritten. The added text is the module-level `GRAFT_PROMPT_LINE` constant, so no caller-supplied, issue-supplied or repository-supplied text can reach it |
| `stats.toolCallCounts` | the provider's own stream, parsed upstream | passed to `countGraftQueries`, which matches six fixed names (with or without the `mcp__<server>__` prefix) and sums only finite values |
| `stats.provider` | the run stats | compared against the resolved id and, when it differs, named in one `logger.warn` line — never used to change a decision |

| Property | Result |
| -------- | ------ |
| spawn chokepoints | none. The module constructs no `Deno.Command` and calls no spawn helper. The `graft` entry it returns is a **description** the runner writes into the per-run MCP configuration; the process is started by the agent CLI, rooted at the checkout named in its arguments, with `DO_NOT_TRACK=1` and nothing else added to its environment |
| prompt injection | the appended line is a constant. Because it is appended **after** the builder's output it lands outside every untrusted fence the builder wrote, so no issue text can position itself after the instruction and pose as part of it. The bundle Graft injected earlier stays inside its own untrusted fence, untouched here |
| MCP surface | the `graft` entry comes from `graftMcpServer()` verbatim and rides beside whatever the run already had. The browser grant is passed through as the caller gave it, so an additional server can never widen the Issue #192 browser grant; a name collision with the generated Playwright entry is refused by `agent_mcp_config.ts`. A provider with no MCP transport (Gemini) is handed nothing and told so on one `info` line |
| network | none |
| regex safety | no regex; the tool-name match is `lastIndexOf("__")` and an array lookup |
| filesystem | none |
| secret surface | holds no credential. The log lines carry a status, a checkout path, integers and two provider ids |
| fail direction | fail-loud-but-never-fatal: a run naming no checkout and a provider resolution that throws are each logged with the `[GRAFT_TOOLS_UNAVAILABLE]` marker and leave the run exactly as it was. The agent invocation that follows raises the real provider fault on its own, so nothing is swallowed — only prevented from being reported as tools the agent had |
| blast radius | on any collection short of `ok` (including the default, `off`) every decision returns the caller's own value, so the run is byte-identical to one from before the pull side existed |

## The invariant this module exists to hold

The MCP entry and the prompt line are read from **one** `wired` verdict, so
no caller can add one without the other. Handing the agent the line without
the server tells it to call a tool that does not exist; handing it the server
without the line leaves a graph the agent never queries. The verdict is also
what gates `record`: a tally is folded in only when the tools were actually
handed over, so a Gemini-routed run reports no figure rather than a `0` that
would read as "the agent never asked".

## The caller contract this module cannot enforce

`mcpConfig` names a request; the runner decides whether to honour it. A call
site that passes a request but no `cwd` gets no MCP configuration written at
all (`claude_runner.ts`, the `mcpRequest && cwd` gate). Each of the wired call
sites therefore passes the same checkout as `cwd` that it names as `repoDir`,
exactly as the CodeGraph sites do, and the module refuses to report `wired`
for a checkout that is absent or empty.

## Verdict

**Swept, no findings.** The module is pure decision-making over values the
worker already owns, with one caught throw and no spawn, filesystem, network
or secret surface of its own.
