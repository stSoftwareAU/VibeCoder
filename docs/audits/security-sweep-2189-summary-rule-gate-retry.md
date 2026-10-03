# Security sweep — the summary-rule gate recovery (`summary_rule_gate_retry.ts`)

**Issue:** [#2189](https://github.com/stSoftwareAU/VibeCoder/issues/2189)
(chunk top-up-2189) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2189:

- `worker/deno/lib/summary_rule_gate_retry.ts` — added by #2189.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2189**, and this file is the reading of it.

## `worker/deno/lib/summary_rule_gate_retry.ts`

One prompt builder and one orchestrator. It spawns nothing, reads and writes no
file, opens no socket and touches no environment variable: the agent invocation
goes through `deps.claude.runClaudeWithRetry` and the re-gate through
`workOnIssueQualityGate`, both of which own their own spawn boundaries and were
swept under chunks 12a/12b.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `verdict.comment` | the summary gate's own comment builder (`acceptance_criteria_gate.ts`, `independent_review_gate.ts`, `reproduction_status_gate.ts`) — worker-authored template text, quoting entry lines from the branch's own PR summary, which carry wording the issue's author chose | fenced with `fenceUntrustedIssueText` under a per-render CSPRNG nonce (forged delimiters and HTML comments scrubbed), named by a `buildBoundaryIntegrityInstruction` rule (Issue #3152). The genuine `<!-- vibe-spec-review -->` / `<!-- vibe-standards-review -->` markers the agent must reproduce come from the trusted `review_block_template.ts` text printed outside the fence, so scrubbing the notice never costs the agent the markers it needs. Empty or whitespace-only is still refused before a prompt exists |
| `verdict.reason` | the same gate, as the phase-failure reason | fenced the same way, under the same nonce, named by the same integrity instruction (Issue #3152) |
| `issueNumber` | the claim the run already holds | validated as a positive integer, then interpolated into prompt text and a summary path *string*. No filesystem call is made with it here |
| `repo` | the claim the run already holds | named in the prompt's first line only |
| `state.repoPath` | the worker's own clone path | passed through as the invocation's `cwd`, unchanged |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | none: the only child process is the one `runClaudeWithRetry` spawns through its existing boundary |
| environment | untouched — no `Deno.env` read or write |
| filesystem | none — the summary file is named in the prompt for the agent to edit; this module never opens it |
| network | none |
| regex safety | none used |
| secret surface | no credential is read, logged or interpolated. The log lines carry the repo, the issue number and the gate's own reason |
| resource bounds | one invocation per run, enforced by the caller's `=== 1` entry condition; the invocation itself is bounded by the run's configured `claudeTimeout` / `claudeKillAfter` and `maxRateLimitRetries` |
| fail direction | fail-loud in the direction that matters: an unusable issue number or an empty remediation comment **throws** rather than producing a prompt that would send the agent to re-derive the shortfall itself; a verdict-less call and a failed launch each log a warning and return the gate's original `failure` unchanged, so no path turns a block into a pass |

No finding. An earlier version of this record read the gate comment as
worker-generated and replayed it **unfenced**; #3152 superseded that decision,
because the summary entry lines each gate quotes back carry wording the
issue's author chose, not just the worker's own template text — the same
attacker-influenced-input reasoning #3133 already applied to the closure
gate's problem lines. Both `verdict.reason` and `verdict.comment` are now
fenced under a per-render CSPRNG nonce with a boundary-integrity instruction
naming it, so a forged delimiter or HTML comment inside the quoted text
cannot pass as a real one; the markers the agent must reproduce come from the
trusted review-block template printed outside the fence, never from the
notice. The prompt still bounds what the fenced content can achieve: the
invocation is told to edit the one summary file and commit, never to create
the PR, close the issue or start new work, and the gates all run again over
the result before any PR exists. The invocation keeps its full tool grant
regardless — it is deliberately allowed to edit and commit, because that is
the recovery's job.
