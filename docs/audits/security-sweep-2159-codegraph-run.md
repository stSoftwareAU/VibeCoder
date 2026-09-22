# 🔎 Security sweep — the CodeGraph run wiring (`codegraph_run.ts`)

**Issue:** [#2159](https://github.com/stSoftwareAU/VibeCoder/issues/2159) (chunk
top-up-2159) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2159:

- `worker/deno/lib/codegraph_run.ts` — added by #2159.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2159**, and this file is the reading of it.

## `worker/deno/lib/codegraph_run.ts`

The module spawns nothing itself. It resolves one provider descriptor, delegates
the index step to `codegraph_context.ts` (swept under
[top-up-2155](security-sweep-2155-codegraph-context.md)), and returns three pure
decisions: the prompt to send, the MCP request to make, and how to fold a
completed invocation's tool tally into the result.

| Input                       | Source                                                          | How it is handled                                                                                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoDir`                   | the worker's own checkout path, optional since Issue #2160      | tested for absence (absent or empty) and otherwise passed straight through to `prepareCodegraphContext`, which is where it is used; never interpolated into an argv, a path or a prompt here. A run that names no checkout is recorded as `failed` rather than handed half the pair |
| `enabled`                   | the host `.config.json` switch                                  | a boolean, compared only                                                                                                                                                                                                                                                            |
| `agentProvider`             | the repo pin or the per-invocation selection, both worker-owned | handed to `selectAgentProvider`, which validates it; a throw is caught, reported as `[CODEGRAPH_UNAVAILABLE]` and turned into `status: "failed"`                                                                                                                                    |
| `prompt` (in `applyPrompt`) | the built issue/planning/question prompt                        | **appended to**, never parsed or rewritten. The added text is the module-level `CODEGRAPH_PROMPT_LINE` constant, so no caller-supplied or issue-supplied text can reach it                                                                                                          |
| `stats.toolCallCounts`      | the provider's own stream, parsed upstream                      | passed to `countCodegraphQueries`, which matches two fixed names and sums only finite values                                                                                                                                                                                        |
| `stats.provider`            | the run stats                                                   | compared against the resolved id and, when it differs, named in one `logger.warn` line — never used to change a decision                                                                                                                                                            |

| Property          | Result                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| spawn chokepoints | none. The module constructs no `Deno.Command` and calls no spawn helper; every subprocess in this feature belongs to `codegraph_context.ts`                                                                                                                                                                                                                                                                              |
| prompt injection  | the appended line is a constant. Because it is appended **after** the builder's output it lands outside every untrusted fence the builder wrote, so no issue text can position itself after the instruction and pose as part of it                                                                                                                                                                                       |
| MCP surface       | the `codegraph` entry comes from `codegraphMcpServer()` verbatim. The browser grant is passed through as the caller gave it (`playwright: playwright === true`), so an additional server can never widen the Issue #192 browser grant; a name collision with the generated Playwright entry is refused by `agent_mcp_config.ts`                                                                                          |
| network           | none                                                                                                                                                                                                                                                                                                                                                                                                                     |
| regex safety      | no regex                                                                                                                                                                                                                                                                                                                                                                                                                 |
| filesystem        | none                                                                                                                                                                                                                                                                                                                                                                                                                     |
| secret surface    | holds no credential. The two log lines carry a status, four integers and two provider ids                                                                                                                                                                                                                                                                                                                                |
| fail direction    | fail-loud-but-never-fatal: two things are recorded as `failed` here, each logged with the `[CODEGRAPH_UNAVAILABLE]` marker — a provider resolution that throws, which is caught, and (since Issue #2160) a run that names no checkout to index. The agent invocation that follows raises the real provider fault on its own, so the fault is never swallowed — only prevented from being reported as a CodeGraph success |
| blast radius      | with the switch off (the default) the module resolves no provider and every decision returns the caller's own value, so the run is byte-identical to one from before the trial existed                                                                                                                                                                                                                                   |

## The invariant this module exists to hold

The MCP entry and the prompt line are read from **one** `status === "ok"` test,
so no caller can add one without the other. Handing the agent the line without
the server tells it to call a tool that does not exist; handing it the server
without the line leaves an indexed repository the agent never queries. Either
half alone is a defect the trial's figures would silently absorb, which is why
the pair is decided here rather than at each of the six call sites.

## The caller contract this module cannot enforce

`mcpConfig` names a request; the runner decides whether to honour it. A call
site that passes a request but no `cwd` gets no MCP configuration written at all
(`claude_runner.ts`, the `mcpRequest && cwd` gate), which would append the
prompt line and drop the server it names — the pair invariant broken from
outside this module. Each of the six wired call sites therefore passes the same
checkout as `cwd` that it names as `repoDir`, and every wired suite asserts that
the two match. Since Issue #2160 the module also refuses to report `ok` for a
checkout that is absent or empty, because that gate reads falsiness rather than
`undefined`, so the commonest way to break the contract from outside is now
caught inside.

## Verdict

**Swept, no findings.** The module is pure decision-making over values the
worker already owns, with one caught throw and no spawn, filesystem, network or
secret surface of its own.
