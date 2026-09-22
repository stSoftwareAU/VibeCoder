# 🔎 Security sweep — the advisor/executor prompt block (`issue_executor_split_prompt.ts`)

**Incident:** [#2343](https://github.com/stSoftwareAU/VibeCoder/issues/2343)
(chunk top-up-2343) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the advisor/executor instructions:

- `worker/deno/lib/issue_executor_split_prompt.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2343**, and this file is the reading of it.

## `worker/deno/lib/issue_executor_split_prompt.ts`

The module is a single exported constant,
`ISSUE_EXECUTOR_SPLIT_INSTRUCTIONS` — repository-authored prose with one
interpolation, `ISSUE_EXECUTOR_AGENT_NAME` from `issue_executor_agents.ts`,
which is itself a module-level string literal. There is no function, no
argument and no external read.

| Input | Source                       | How it is handled                              |
| ----- | ---------------------------- | ---------------------------------------------- |
| none  | the module takes no input    | nothing to validate — the value is a constant  |

| Property          | Result                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none — no subprocess, no `gh`, no `git`                                                                                                                                                      |
| prompt injection  | the text is a repository-authored constant spliced into the `issue` template at `{{EXECUTOR_SPLIT_INSTRUCTIONS}}`. No issue body, comment, label or other untrusted value reaches it, and it carries no `{{PLACEHOLDER}}` token of its own, so nothing an attacker writes can alter or inherit it |
| trust boundary    | the block lands in the **trusted** instruction region of the user turn, above the nonce-fenced untrusted issue text; `substitute()` reads the template, not the rendered output, so untrusted content carrying placeholder syntax cannot reach this key |
| argv injection    | none — the value never reaches a command line                                                                                                                                                |
| network           | none                                                                                                                                                                                         |
| filesystem        | none                                                                                                                                                                                         |
| regex safety      | no regular expressions                                                                                                                                                                       |
| secret surface    | holds no credential and reads no environment variable                                                                                                                                        |
| capability grant  | none of its own. It instructs the advisor to delegate to the `executor` sub-agent, whose capability is fixed by `buildIssueExecutorAgents()` (swept under top-up-2342) and is a subset of the advisor's |
| fail direction    | fail-closed at the call site: `buildIssuePrompt` splices the block only when `issueExecutorSplit` is true — the same boolean that decides whether `--agents` is passed — and renders the empty string otherwise, leaving the prompt byte-identical to a pre-key run |
| blast radius      | one consumer, `lib/prompt_builder.ts`, reached from the two `issue`-phase call sites (`lib/execute_claude_phase.ts`, `lib/phases/execute_phase.ts`)                                            |

## The one behaviour worth restating

The advisor is told to make no `Edit` or `Write` call itself, but nothing
removes those tools from its session — the block is guidance, not a sandbox.
The security boundary remains the executor definition's own tool allowlist and
its denial of `Agent`, which is what stops a split run becoming an unbounded
sub-agent tree.
