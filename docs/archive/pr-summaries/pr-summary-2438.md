# Stop requesting reviews on PRs targeting milestone branches

## Summary

Closes #2438

A PR the fleet raises into a `milestone/**` branch never needs a review. The
`milestone/**` ruleset requires status checks only, and the review that matters
sits on the milestone → default-branch PR — so every pending request on a child
issue PR or a `sync/milestone-*` PR is noise in a reviewer's queue.

Two sources created one, and both are now closed off by a single base-branch
rule:

- **The worker's own `--reviewer` argument.** `reviewersForBase(base, configured)`
  returns `[]` for a milestone base and the configured list for every other
  base. The completion phase builds `createPrArgs` from it, and
  `createPullRequestViaRest` builds its REST reviewer POST from it — so the
  deferred-PR drain, which replays reviewers *through* that function, is covered
  with no edit of its own.
- **GitHub's CODEOWNERS auto-request**, which cannot be suppressed at creation.
  `clearMilestoneReviewRequests()` removes it once, immediately after the PR is
  opened, with a single `DELETE …/requested_reviewers` carrying both lists —
  `reviewers[]` for individuals and `team_reviewers[]` for `@org/team` entries.

```mermaid
flowchart TD
    A[PR creation] --> B{isMilestoneBranch base?}
    B -- no --> C[reviewers = configured list]
    C --> D[POST/--reviewer as before]
    D --> E([PR open, review requested])
    B -- yes --> F[reviewers = empty]
    F --> G[create with no reviewer argument]
    G --> H[GET .../requested_reviewers]
    H --> I{anything requested?}
    I -- no --> J([done — zero extra calls, Issue #2409])
    I -- yes --> K[one DELETE .../requested_reviewers<br/>reviewers[] + team_reviewers[]]
    K --> L([PR open, queue clean])
    H -. call fails .-> M[one warning, exit code unchanged]
```

Behaviour the issue pinned down, all honoured:

- **Exactly once, at creation.** The completion phase has two creation paths —
  `gh pr create` and `createPrViaRestFallback`, and the latter routes through
  `createPullRequestViaRest`, which already clears. A `clearedDuringCreate` flag
  guards the phase's own post-create clear so the removal runs once whichever
  path opened the PR, rather than paying a second read on the fallback path.
- **Zero cost when there is nothing to clear.** The DELETE is issued only when
  the read comes back non-empty (Issue #2409's quota lockout).
- **Unconditional per repo.** It runs even where a repo's `milestone/**` ruleset
  does require an approving review — `milestone_ruleset_check.ts` already warns
  about that configuration, and a human can re-request by hand.
- **Fail-soft.** A failed read or DELETE logs exactly one warning and returns
  `"failed"`; the run's exit code is unchanged. A successful removal logs one
  line naming the repo and PR number.
- **Nothing else moves.** Default-branch PRs, `default_branch_approval.ts`, the
  milestone → default-branch PR in `milestone_completion.ts`, `skip_reviewer_request`
  and `.github/CODEOWNERS` files are all untouched. No sweep of already-open PRs,
  no new per-repo config key, assignees left alone.

### REST, not GraphQL — a deliberate deviation

The issue describes reading `gh pr view --json reviewRequests`. That command is
GraphQL-backed, and `pr_create_rest.ts` exists precisely because the fleet lost a
whole run's PR to an exhausted primary GraphQL quota (Issue #42). The REST
`GET repos/:repo/pulls/:n/requested_reviewers` rides the separate core quota,
matches the surrounding module's design, and returns users and team slugs
separately — exactly the two lists the single DELETE needs. The assertion the
issue asked for still holds: nothing is requested on a freshly created milestone
PR.

### Import cycle — assessed and verified benign

`milestone_sync_pr.ts` → `milestone_pr_reviewers.ts` → `milestone_children_gate.ts`
→ `milestone_sync_pr.ts`. Every use sits inside a function body (nothing runs at
module-init top level), ESM resolves it, and no quality gate forbids cycles. The
green `deno check` and the 42-test run that exercises that exact chain confirm it
resolves at runtime. Duplicating `isMilestoneBranch()` would break DRY and
relocating it would be scope creep, so the cycle stays.

### Sweep-coverage registration

A new module under `worker/deno/lib/` must be claimed by a sweep slice
(Issue #1609), so `docs/audits/lib-sweep-coverage.json` gains a `top-up-2438`
slice claiming `milestone_pr_reviewers.ts`, backed by a real reading of it in
`docs/audits/security-sweep-2438-milestone-pr-reviewers.md` — the ledger tests
require the record to exist *and* to name every module its slice claims, which
is what stops a path being appended without the sweep behind it.

## Evidence

Targeted runs from `worker/deno`:

```
$ deno test -A tests/milestone_pr_reviewers_test.ts tests/pr_create_rest_test.ts \
      tests/milestone_sync_pr_test.ts < /dev/null
ok | 42 passed | 0 failed (138ms)

$ deno test -A tests/completion_phase_rest_pr_fallback_test.ts \
      tests/completion_phase_secondary_limit_test.ts \
      tests/deferred_pr_drain_test.ts tests/deferred_pr_dispatch_test.ts < /dev/null
ok | 23 passed | 0 failed (377ms)
```

The full gate from the repository root:

```
$ ./quality.sh < /dev/null
  completeness checks            PASSED
  deno tests                     PASSED
  deno lint                      PASSED
  deno type check                PASSED
  deno fmt                       PASSED

Result: PASSED (with skipped checks)
```

(`config integration` is the skipped check — it needs a configured live repo.)

An earlier run of the same gate failed one test,
`launcher_parity_test.ts` → "run.sh and run.ps1 - hand the runtime the same
invocation". That test spawns launcher processes and races under `--parallel`;
it passes standalone (`ok | 24 passed | 0 failed`) and passed on the gate re-run.
It touches no code in this change.

This change has no visual surface — it alters which REST calls accompany a PR
creation — so there is no screenshot to capture.

## Test Plan

The four cases the issue specified, plus the call-site coverage:

| Case | Test |
| --- | --- |
| Milestone base → no reviewer arguments, nothing requested | `milestone_pr_reviewers_test.ts` — reviewers suppressed, **zero** POSTs |
| CODEOWNERS team request on a milestone base → cleared | `milestone_pr_reviewers_test.ts` — exactly one DELETE carrying `reviewers[]=alice` and `team_reviewers[]=platform` |
| Default base → existing reviewer list unchanged | `pr_create_rest_test.ts` — one POST with both reviewers, zero DELETEs |
| Failed removal → one warning, exit code unchanged | `milestone_pr_reviewers_test.ts` — a 403 DELETE and a 502 GET each return `"failed"` with one warning; `createPullRequestViaRest` still returns `ok` |

Also covered: the boundary base `milestone/` (not a milestone branch, reviewers
kept), a nested `milestone/2026-Q1/rollout`, malformed repo/PR targets short-
circuiting with no call at all, login hygiene against the `NAME_PATTERN`
allowlist, unparseable JSON, the sync PR's own CODEOWNERS clear, and an
already-open sync PR spending nothing on the removal.

Run them with:

```bash
cd worker/deno
deno test -A tests/milestone_pr_reviewers_test.ts tests/pr_create_rest_test.ts \
    tests/milestone_sync_pr_test.ts < /dev/null
```
