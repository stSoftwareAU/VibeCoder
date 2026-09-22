# 🔎 Security sweep — the issue-executor sub-agent definitions (`issue_executor_agents.ts`)

**Incident:** [#2342](https://github.com/stSoftwareAU/VibeCoder/issues/2342)
(chunk top-up-2342) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the `--agents` executor definitions:

- `worker/deno/lib/issue_executor_agents.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2342**, and this file is the reading of it.

## `worker/deno/lib/issue_executor_agents.ts`

The module is one exported function, `buildIssueExecutorAgents()`, plus the five
constants it is built from. It takes **no arguments** and reads no external
state: it returns a constant object literal describing one Claude CLI sub-agent.
The caller serialises that object to JSON and passes it as `--agents`.

| Input | Source                        | How it is handled                                |
| ----- | ----------------------------- | ------------------------------------------------ |
| none  | the function takes no input   | nothing to validate — the output is a constant   |

| Property          | Result                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none — no subprocess, no `gh`, no `git`                                                                                                                               |
| prompt injection  | the prompt it carries is a repository-authored constant. No issue body, comment, label or other untrusted text reaches it, so nothing an attacker writes can alter it |
| argv injection    | the value reaches the CLI as a single argv element produced by `JSON.stringify`, never through a shell; `Deno.Command` passes argv directly with no shell parsing      |
| network           | none                                                                                                                                                                  |
| filesystem        | none                                                                                                                                                                  |
| regex safety      | no regular expressions                                                                                                                                                |
| secret surface    | holds no credential and reads no environment variable                                                                                                                 |
| capability grant  | the definition **narrows** capability: the executor gets exactly `Read, Grep, Glob, Edit, Write, Bash` and is denied `Agent`, so it cannot spawn further sub-agents. It is a subset of what the advisor session already holds, so no new capability enters the run |
| fail direction    | fail-closed at the call sites: `agents` is set only when `isIssueExecutorSplitEnabled` resolves `true`, and an absent value emits no `--agents` argument at all        |
| blast radius      | two `issue`-phase call sites (`lib/execute_claude_phase.ts`, `lib/phases/execute_phase.ts`). A CLI that rejects the flag fails the run with its own error — there is no retry without it, so a rejected flag cannot silently downgrade a run to single-model routing |

## The one behaviour worth restating

DeepSeek runs the **same** Claude Code binary against a different endpoint, so
its descriptor would otherwise inherit the flag and forward Anthropic tier
aliases its endpoint cannot resolve. `agent_provider.ts` strips `agents` for
DeepSeek and warns (`warnDeepSeekAgentsUnsupported`), mirroring the existing
`--effort` treatment: dropped, but never in silence.
