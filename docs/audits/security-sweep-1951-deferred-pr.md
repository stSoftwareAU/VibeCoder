# Security sweep — deferred PR creation (secondary rate limit)

**Issue:** [#1951](https://github.com/stSoftwareAU/VibeCoder/issues/1951)
(chunk 12ac) · **Parent:** #1209

The written record for the four modules that entered `worker/deno/lib/` with
the secondary-rate-limit deferral:

- `worker/deno/lib/secondary_rate_limit.ts` — recognises GitHub's
  content-creation throttle and plans the wait.
- `worker/deno/lib/pr_creation_retry.ts` — the bounded retry loop around
  `gh pr create`.
- `worker/deno/lib/deferred_pr_store.ts` — parks the refused PR on disk.
- `worker/deno/lib/deferred_pr_drain.ts` — raises the parked PR next cycle.
- `worker/deno/lib/phases/pr_deferral.ts` — the completion phase's side: the
  deadline, the breaker coordination and the parking itself.

## Why a new slice rather than a line in an old one

Appending modules to a slice whose sweep ran before they existed is the cheapest
way to make `diffCoverage` green and a false record. These four are claimed by
**12ac**, and this file is the reading of them.

## `worker/deno/lib/secondary_rate_limit.ts`

Pure over a string the worker already holds — a `gh` error message, which is
attacker-influenceable only in the weak sense that a repository's own content
can appear in an API error. It spawns nothing, opens nothing, and has no clock
of its own.

| Property | Result |
| -------- | ------ |
| no spawn, argv, filesystem, network or `gh` | no `Deno.*` at all; every input is a parameter |
| no environment or secret sinks | nothing read, nothing logged; the caller decides what is said |
| no catastrophic backtracking | `SECONDARY_RATE_LIMIT_RE` is a flat alternation of literal phrases — no nesting, no ambiguous quantifier — and the `Retry-After` pattern bounds its digits at `\d{1,7}`, so a megabyte of digits cannot be read as one number |
| a hostile `Retry-After` cannot park the run | the value is clamped to `MAX_RETRY_AFTER_SECONDS` (1800) and refused when ≤ 0, and the deadline check then refuses any wait that would not fit the run |
| the primary quota cannot be mistaken for this one | the primary phrases (`API rate limit exceeded`, …) are deliberately absent from the pattern, so `isPrimaryRateLimitMessage`'s REST fallback keeps its own path |

### Findings

None.

## `worker/deno/lib/pr_creation_retry.ts`

Orchestration only: it calls the `createPr` closure it is given and sleeps
between attempts. It never builds an argv, so nothing here can widen what the
caller decided to run.

| Property | Result |
| -------- | ------ |
| no spawn, filesystem, network or `gh` | `createPr`, `sleepFn`, `nowMs`, `onRefusal` and `onSuccess` are all injected; the module itself touches nothing |
| the loop is bounded | the only path that continues is a `wait: true` plan, and the planner refuses any attempt past the schedule's length, so `delays.length + 1` attempts is the hard ceiling — an `Infinity` deadline cannot make it spin |
| an unbounded wait is impossible | every delay comes from the planner, which clamps `Retry-After` and enforces the run deadline |
| a non-secondary error is never retried | it returns `failed` on the first throw, so an auth or "no commits" failure keeps today's timing exactly |
| a breaker fault cannot block the create | `onRefusal` returning `undefined` simply means "no coordinated floor"; the caller's implementation catches its own errors |

### Findings

None.

## `worker/deno/lib/deferred_pr_store.ts`

The only module of the four that writes to disk, and the only one handling a
value that reaches a filesystem path.

| Property | Result |
| -------- | ------ |
| a repo slug cannot escape the store directory | `REPO_PATTERN` (`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`) is applied before the path is built, so `../` — the one shape that would choose the file written — is refused by `deferredPrPath`, and `recordDeferredPr` refuses with it. Regression test: `deferred_pr_store_test.ts::a repo slug cannot escape the store directory` |
| the issue number cannot widen the path | only a positive integer is accepted |
| writes are atomic and confined to the work dir | `atomicWrite` (write-to-tmp then rename) under `<workDir>/.deferred_prs/`; no path outside the work dir is ever constructed |
| a read cannot be made to throw | a malformed or unreadable file is reported through `onProblem` and skipped; the remaining records still drain |
| a forged record cannot widen what is created | `isDeferredPrRecord` re-validates every field on read — including the repo pattern — so hand-editing a record in the work dir can only produce a PR whose repo, branch and base are well-formed strings, and the drain still sends them as `-f` raw fields (never `-F`, so no `@file` expansion) |
| the body is worker-composed | the PR body is the summary this run already committed to the branch; it is stored verbatim and sent verbatim, with no shell in the path |
| no secret sinks | the record holds a repo slug, numbers, branch names, the PR body and the refusal text; no token, no environment |

### Findings

None.

### Accepted residuals

- **A record is host-local.** It lives in the host's work dir, so a host that
  never runs again leaves its parked PR unraised. The fallback is unchanged and
  intact: the branch is pushed, the issue is open, and the next claim recovers
  the PR from the branch (`findExistingPrForBranch`) — which is why the resume
  state is kept for a `pr_deferred` release.

## `worker/deno/lib/phases/pr_deferral.ts`

Orchestration inside the completion phase; the values it handles are the run's
own (branch, base, title, the summary it committed) plus the refusal text.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | the PR is created by the caller's closure; this module only decides the deadline, records the refusal on the breaker and parks the record |
| a deferral that cannot be parked is a failure, not a promise | an empty `workDir` or a failed write returns `status: "failure"`, so the run never reports a pending PR nothing will raise |
| breaker faults are reported, never swallowed | both the record and the reset log at `warn` on a non-`ok` `Result` and on a throw |
| the comment carries no secret | the body comes from `formatPrPendingComment`, which redacts |

### Findings

None.

## `worker/deno/lib/deferred_pr_drain.ts`

| Property | Result |
| -------- | ------ |
| creation goes through the reviewed REST helper | `createPullRequestViaRest`, which validates the repo and sends raw fields; the drain adds no argv of its own |
| the retrying is bounded on both axes | a non-throttle failure counts up to `MAX_DEFERRED_PR_ATTEMPTS` and is then abandoned. A throttle refusal deliberately does not count — that is the drain doing its job — so the *age* bounds it instead: past `MAX_DEFERRED_PR_AGE_SECONDS` (24 h) a record is abandoned whatever refused it, and no record can be re-parked for ever |
| a lookup fault is never read as "no PR exists" | `findOpenPrUrlViaRest` returns the same shape for "none found" and for an API fault, so the fault is warned about explicitly; the create still runs, and `createPullRequestViaRest` resolves a duplicate (HTTP 422) to the open PR rather than opening a second one |
| nothing outbound carries a secret | the refusal is `gh` stderr, which can echo a token-bearing URL, so both sinks (`formatPrPendingComment` and the drain's abandonment comment) route it through `redactSecrets` — `postComment` does no redaction of its own |
| giving up is loud | abandonment logs at `error` and comments the branch on the issue, so an unraised PR is never silently dropped |
| a comment cannot fail the drain | `bestEffortComment` catches and warns; a raised PR is never lost to a comment failure |
| writes stay in the work dir | the only writes are through `recordDeferredPr` / `clearDeferredPr` above |
| the comment target is checked | the production wiring only comments on repos still on this host's roster (`isRepoAllowed`), so a record that outlived a repo leaving the roster cannot write to it |

### Findings

None.
