# 🔎 Security sweep — the one-pass rebase for a declined branch (`branch_conflict_pass.ts`)

**Issue:** [#2459](https://github.com/stSoftwareAU/VibeCoder/issues/2459) (chunk
top-up-2459) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2459:

- `worker/deno/lib/branch_conflict_pass.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2459**, and this file is the reading of it.

## `worker/deno/lib/branch_conflict_pass.ts`

`ensureBranchCurrent` (`branch_currency.ts`) is deliberately not a
merge-conflict resolver: when the pre-PR rebase declines on a genuine content
conflict it leaves the branch alone. Before this module the completion phase
raised the PR on that stale head anyway, and it sat unmergeable until the
conflict ladder (`pr_merge_conflict_processor.ts`) found it hours later.

This module spends **exactly one** agent pass trying to close that gap, and
takes no chances with the branch it is touching:

| Input                                                   | Decision                                   | Handling                                    |
| ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| Branch tip unreadable                                   | Nothing safe to restore to                 | Hand off immediately, no agent call         |
| `budgetSeconds < MIN_REBASE_PASS_RUNWAY_SECONDS` (180s) | Not enough runway to finish                | Hand off immediately, no agent call         |
| Agent call fails (`!attempt.ok`)                        | Cannot trust the branch state              | Restore the pre-attempt tip, hand off       |
| Agent succeeds but re-measured `behind !== 0`           | Success is never taken on the agent's word | Restore the pre-attempt tip, hand off       |
| Agent succeeds and `behind === 0`                       | Branch is genuinely level with its base    | Resolved — the PR is raised on the new head |

The single agent invocation is injected through the `runAgentFn` seam
(`AgentRebaseFn`), so callers — and `branch_conflict_pass_test.ts` — supply a
fake rather than a real Claude call. Restoration reuses the same tip-restore
idiom `rebaseOntoBase` uses in `stale_branch_lineage.ts` on refusal, so a failed
pass leaves the branch exactly as it found it. A hand-off carries exactly one
comment (`buildBranchConflictComment`), naming the conflicting paths (capped at
`MAX_NAMED_CONFLICT_PATHS`) and stating that the conflict ladder owns the PR
from here — the ladder is never raced or duplicated.

No `sleep`, retry loop or polling appears anywhere in the module: it is one
bounded attempt, re-measured, then a decision. It is unit-tested in
`worker/deno/tests/branch_conflict_pass_test.ts`.
