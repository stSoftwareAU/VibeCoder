# 🔎 Security sweep — the merge-conflict agent (`merge_conflict_agent.ts`)

**Issue:** [#1767](https://github.com/stSoftwareAU/VibeCoder/issues/1767)
(chunk 12m) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12l) recorded their coverage:

- `worker/deno/lib/merge_conflict_agent.ts` — added by #1767.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12m**, and this file is
the reading of it.

## `worker/deno/lib/merge_conflict_agent.ts`

The module is the resolution agent extracted from
`pr_merge_conflict_processor.ts` so a branch target can run the same rung as a
PR. It builds the `merge_conflict` prompt for the target, calls the injected
agent runner, and returns what the run left behind. It also owns the memoised
reader for the agent's `.pr_response_message` reply.

Shapes checked (12c's — a module carrying untrusted GitHub data into a prompt —
and 12e's):

| Property | Result |
| -------- | ------ |
| untrusted GitHub text cannot pose as instruction | ✅ every GitHub-chosen value it forwards — the base branch, the milestone branch a milestone title named, the conflicted paths, the originating-issue text — is rendered by `buildMergeConflictPrompt` inside this run's CSPRNG boundary and named in the integrity instruction. The module splices none of them into prose itself; `merge_conflict_agent_test.ts` asserts both branch names appear inside the fence and nowhere outside it, and that a forged boundary marker in a branch name is scrubbed |
| a new target cannot bypass the fence | ✅ the branch target's name is fenced by the same `fenceUntrustedValue` helper the base branch uses, and the prompt's opening names the branch by role rather than by name |
| no shell, no argv construction | ✅ the module spawns nothing: the agent runner is injected (`runAgent`, `deps.claude.runClaudeWithRetry` in production) and receives an options object, never a command line |
| filesystem reach | ✅ two reads, both through existing chokepoints — `loadRepoContextContent` for the clone's `CLAUDE.md`/`AGENTS.md` (12b) and `readPrResponseMessage` for the reply, which consumes the file so a stale reply cannot be reused and redacts secrets before the text can reach a PR comment (12b) |
| environment and secrets | ✅ no `Deno.env` read, no credential handling; the run's bounds arrive as plain numbers from the caller |
| a failure cannot read as success | ✅ every failure returns `{ ok: false }` with the cause named — an unbuildable prompt (before any agent runs), a failed run, a hard timeout, a silence timeout. A worker-ended run is reported as `terminated` rather than judged, exactly as #1693 requires, and the caller decides what to do with it |
| blast radius of a wrong answer | ✅ the module merges nothing, pushes nothing, comments nothing and labels nothing. Starting the merge, guarding the resolved tree, refusing an uncorroborated intent override and spending the attempt all stay with the caller |

No findings.
