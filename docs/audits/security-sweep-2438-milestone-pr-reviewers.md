# 🔎 Security sweep — the milestone PR reviewer clear (`milestone_pr_reviewers.ts`)

**Issue:** [#2438](https://github.com/stSoftwareAU/VibeCoder/issues/2438)
(chunk top-up-2438) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2438:

- `worker/deno/lib/milestone_pr_reviewers.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2438**, and this file is the reading of it.

## `worker/deno/lib/milestone_pr_reviewers.ts`

Two exports. `reviewersForBase(base, configured)` is a pure filter — a
`milestone/**` base gets no reviewer list, every other base keeps the one it was
configured with. `clearMilestoneReviewRequests(options, deps)` issues at most
two `gh api` calls against one PR: a `GET` of `requested_reviewers` and, only
when that read comes back non-empty, a single `DELETE` carrying the logins and
team slugs the read returned. Three callers reach it —
`pr_create_rest.ts` (which covers `deferred_pr_drain.ts` and the completion
phase's REST fallback transitively), `phases/completion_phase.ts` and
`milestone_sync_pr.ts` — each immediately after a PR is created.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `repo` | worker config / the claim repo — trusted, but interpolated into an argv | rejected unless it matches `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` before it reaches a `gh` argument; a miss returns `"invalid-target"` with **no** call made |
| `prNumber` | parsed from the PR URL GitHub returned, or from a sync-PR branch tail via `Number(...)` | rejected unless `Number.isInteger` and `> 0`, so a `NaN` from a non-numeric tail returns `"invalid-target"` with no call |
| `base` | the branch the worker chose to target | only ever tested by `isMilestoneBranch()`; never interpolated into a command |
| `requested_reviewers` response body | **GitHub API output — untrusted**: the logins and team slugs are attacker-influenceable by whoever can be added to a CODEOWNERS file or an organisation | `JSON.parse` inside a `try` (unparseable ⇒ one warning, `"failed"`, no DELETE); every `login`/`slug` must match `/^[A-Za-z0-9._-]+$/` or it is **dropped**, so no shell metacharacter, `--flag`, `$(...)` or `;` can reach the argv |

| Property | Result |
| -------- | ------ |
| argument injection | the only untrusted values that reach `gh` are logins and team slugs, each allowlisted to `[A-Za-z0-9._-]` and each passed as the value half of a `-f reviewers[]=<name>` / `-f team_reviewers[]=<name>` pair. `runGhCommand` spawns an argv — there is no shell — so a dropped-name miss is the worst case, not an executed one |
| can it escalate privilege? | no. Its only mutation is `DELETE …/requested_reviewers`, which **removes** a pending request. It cannot add a reviewer, approve, merge, or alter branch protection. Where a repo's `milestone/**` ruleset does require an approval, `milestone_ruleset_check.ts` already warns and a human re-requests by hand |
| can it weaken the review that matters? | no. It is gated on `isMilestoneBranch(base)`, so a default-branch PR returns `"not-milestone-base"` before any call — `default_branch_approval.ts` and the milestone → default-branch PR are untouched |
| can it leak a secret? | no. It logs one success line and at most one warning, both carrying only `repo`, the PR number, counts, and the `gh` error text; no body, token or header is echoed |
| quota safety (#2409) | one `GET` per newly created milestone PR, and a `DELETE` only when something was actually requested. No retry loop of its own, no sweep of open PRs, no polling |
| REST, not GraphQL (#42) | every call is `gh api <rest-path>` on the core quota — never a `gh` subcommand, never `gh api graphql` — which is why the REST read replaces the GraphQL-backed `gh pr view --json reviewRequests` the issue named |
| regex safety | two anchored character-class patterns with a single `+`/`*`. No nested quantifier, no backtracking surface; both run against short single-line inputs |
| fail direction | fail-soft **and loud**: a failed read or DELETE emits exactly one warning naming the repo, the PR and the underlying error, returns `"failed"`, and leaves the caller's exit code alone. A stale review request is noise, not a broken PR — but it is never silently swallowed |
| network / filesystem / spawn | one `gh` subprocess per call via `runGhCommand`. No filesystem access, no `Deno.env`, no direct `fetch` |
| prompt injection | none of its input or output reaches a model |
| blast radius | a non-milestone base returns on the first line, so every default-branch PR is untouched; a milestone PR with no CODEOWNERS entry stops after the read |
