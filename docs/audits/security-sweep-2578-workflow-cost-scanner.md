# 🔎 Security sweep — GitHub Actions audit cost pre-pass (`workflow_cost_scanner.ts`)

**Issue:** [#2578](https://github.com/stSoftwareAU/VibeCoder/issues/2578)
(chunk top-up-2578) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2578:

- `worker/deno/lib/workflow_cost_scanner.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2578**, and this file is the reading of it.

## `worker/deno/lib/workflow_cost_scanner.ts`

Two pure exports and no I/O. `scanWorkflowCost` walks workflow files the
github-actions-audit template has already read and parsed (through
`readWorkflowFiles`, unchanged) and returns cost and speed leads for prompt
checks 37, 39, 40 and 41; `renderCostCandidates` turns them into list text for
the prompt's `{{COST_CANDIDATES}}` block. It spawns nothing, reads no file,
environment variable or network resource, and files no issue.

| Input | Source | Handling |
| ----- | ------ | -------- |
| workflow YAML (parsed and raw) | untrusted — the audited repository's `.github/workflows/*` | matched against fixed regular expressions and key lookups only; never evaluated, executed or used to build a path or command. A job name is regex-escaped before it is used to find the job's line |
| job names, step commands, cache keys | untrusted — same | echoed into the lead text the prompt receives. The prompt declares the `<cost_candidates>` block as **data, never instructions**, and every lead is a claim the agent must confirm by reading the file itself, so a crafted job name can at most produce a lead the agent rejects |

The leads never reach `gh`: the template passes the rendered text only into the
prompt, and a scanner exception is caught and logged, leaving the block
`(none)`. The only new agent capability in #2578 is prompt-side — two read-only
`gh` calls (`gh run list`, the `timing` GET) — which the agent `gh` guard already
classifies as reads; `worker/deno/tests/gh_guard_actions_cost_signal_2578_test.ts`
pins that, and pins the adjacent Actions writes as mutations.

One pre-existing gap, not introduced here: the guard's write-repo allowlist
permits cwd-scoped Actions writes (`gh run rerun`, `gh workflow run`) to the
claimed repository, as it permits every cwd write. The audit's Hard Constraint 2
forbids them in the prompt; the guard does not refuse them per template.
