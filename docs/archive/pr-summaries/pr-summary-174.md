# PR Summary — Issue #174

## Summary

Issue→PR linking matches "any PR whose title or body references #N". That
cannot tell *the PR for the branch this run just pushed* from *some PR for
this issue* — and in a fleet those differ routinely, because humans and
sibling hosts land partial PRs against issues that are still being worked.

On VibeCoder#42 it cost three commits. The worker pushed
`issue-42-primary-graphql-quota-exhaustion-is-swallowed-by-t`, then:

```text
00:06:33Z IDEMPOTENT: PR already exists for issue number, skipping creation prUrl=…/pull/173
00:06:40Z Self-healing: closing issue after PR merge issueNumber=42 prNumber=173
00:06:47Z Releasing claim VibeCoder#42 — outcome pr:#173
```

PR #173 was a human's partial PR on a different branch, merged *while the
worker's execute was still running*. No PR was ever opened for the worker's
branch, and nothing was logged above INFO.

**The branch-name shape is not a discriminator.** Both PRs on #42 had an
`issue-42-*` head and the same author (`nleck`) — #173's head was
`issue-42-relabel-reopens-merged-pr-gate`. Only the *exact* branch separates
them, so every rule added here compares the full name. A prefix or
author-based rule would have passed #173 straight through.

### The three fixes, one per acceptance criterion

**1. Completion no longer treats a merged PR as this run's.** The order was
"any PR for the issue?" first, and a merged PR answered yes. It is now:

| Order | Condition | Action |
| --- | --- | --- |
| 1 | Open PR whose head is exactly this branch | recover — unambiguously ours |
| 2 | Open PR for the issue | recover — pre-#174 behaviour, loses nothing |
| 3 | **Branch is ahead of base** | **create** — a merged/closed PR is never the PR for commits we just pushed |
| 4 | Branch level with base, a PR exists | recover — nothing to raise, so it does represent the work (#1559) |
| 5 | Nothing found | create, and let creation report its own error |

Row 3 is the fix. Row 4 is why #1559's re-pickup loop stays fixed rather than
being traded away.

**2. Closing requires provenance.** `ensureIssueClosedIfPrMerged` takes the
run's branch and now reads `headRefName` alongside `state`. A merged PR whose
head is not this run's branch leaves the issue **open** and comments naming
the branch, so the issue's author can make the call — their PR, their
judgement. Both real call sites pass the branch; the pre-check deliberately
does not, and guards differently (below).

**3. The pre-check checks for stranded work first.** `merged_pr_precheck` runs
before any repo I/O and closes on the linker's answer, which is why
re-opening #42 by hand got it closed again on the next claim. New
`stranded_issue_branch.ts` asks, over the GitHub API: does this issue have a
pushed branch that is ahead of base with no open PR? If so the pre-check logs
at WARNING and returns `continue`, so the run resumes that branch (#220) and
completion raises its PR. The extra API calls happen only on the close path,
so they never land on a normal claim.

### Failure directions, chosen deliberately

- `stranded_issue_branch.ts` fails **safe toward not closing**: a failed
  compare, a failed open-PR check, and an unresolvable default branch all
  report the branch as possibly stranded. #174 is a report of lost work — the
  cost of being wrong that way is one issue left open for a human, against
  commits silently discarded in the other.
- `decideCompletionPr` deliberately does **not** force creation on an unknown
  commit count. Without the count we do not know work exists, and changing
  behaviour on an unknown is the riskier half. The protection in that case is
  the provenance guard, which still refuses to *close*.
- An unreadable PR state is treated as OPEN — the pre-#174 behaviour — for the
  same reason: a `gh` hiccup must not become a lost branch.

Closes #174.

## Evidence

Backend change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`** — neither module exists there,
`ensureIssueClosedIfPrMerged` takes no branch, and the completion ordering is
the old one.

**They pass here** — 28 new cases across two files, plus 2 in the existing
completion suite:

```text
$ deno test --allow-all tests/pr_run_provenance_test.ts
ok | 15 passed | 0 failed

$ deno test --allow-all tests/stranded_issue_branch_test.ts
ok | 13 passed | 0 failed

$ deno test --allow-all tests/completion_phase_merged_pr_closure_test.ts
recoverAndFinaliseExistingPr - merged PR + open issue closes the issue and skips linkPrToIssue ... ok
recoverAndFinaliseExistingPr - open PR + open issue posts link comment and does not close the issue ... ok
recoverAndFinaliseExistingPr - merged PR + already-closed issue is idempotent ... ok
recoverAndFinaliseExistingPr #174 - a merged PR on someone else's branch leaves the issue open and comments ... ok
recoverAndFinaliseExistingPr #174 - a merged PR on this run's own branch still closes the issue ... ok
ok | 5 passed | 0 failed
```

**No regression in the surrounding suites** — the full completion, lifecycle
and pre-check set, and the 107-case issue-worker suite:

```text
$ deno test --allow-all tests/*completion* tests/*issue_lifecycle* tests/*merged_pr_precheck*
ok | 185 passed | 0 failed

$ deno test --allow-all tests/issue_worker_test.ts
ok | 107 passed | 0 failed
```

**Two existing tests failed on the first pass and were a real finding, not
noise.** `completion - defence-in-depth re-checks by issue number after branch
check fails (#1189)` and `completion - self-heals when PR creation fails but
PR exists` both depend on the issue-number lookup being attempted **twice**
before creation — the #872 retry against a transient miss. My reorder had
collapsed it to one call. The retry is restored explicitly: reordering for
#174 must not cost the guard against a *duplicate* PR while fixing the guard
against *lost work*. Both pass.

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates. `deno tests` reports only the 11
pre-existing `setup.ps1` failures (`NotFound: Failed to spawn 'pwsh'`,
environmental).

## Test plan

`worker/deno/tests/pr_run_provenance_test.ts` — 15 cases. Uses the **real**
branch names from #42, so any rule keying on branch shape rather than the
exact name fails here:

| Group | Covers |
| --- | --- |
| `decideCompletionPr` (7) | A merged sibling PR does not stop us raising ours (the #42 case); a closed one does not either; an open PR on our exact branch is recovered; an open PR for the issue is still recovered; **a level branch with a merged PR still recovers, so #1559 stays fixed**; an unknown count does not force creation; nothing found means create |
| `mergedPrCompletesThisRun` (6) | The human's PR on the same issue is not ours; our own branch is; **the branch shape alone proves nothing** (`issue-42-something-else` and bare `issue-42` are both refused); an unknown head never authorises a close; an unknown run branch never does; whitespace is not a difference; comparison is case-sensitive, as git refs are |
| `foreignMergedPrComment` (1) | Names the PR, the branch and whose call it is — the branch appears more than once, because it is what a human needs to find the work |

`worker/deno/tests/stranded_issue_branch_test.ts` — 13 cases:

| Group | Covers |
| --- | --- |
| `isIssueBranchRef` (3) | Bare and slugged forms match; **`issue-420` does not match issue 42**, which a plain prefix test would accept; unrelated branches do not |
| Detection (4) | Ahead with no open PR is stranded; level with base is not; an existing open PR is not; no branches at all is not |
| Failure directions (4) | A failed compare reports the branch rather than clearing it; a failed open-PR check does not read as "there is a PR"; an unresolvable default branch reports every candidate; a failed listing clears nothing and is logged |
| Plumbing (2) | A supplied base skips the repo lookup and is the ref compared against; the log line names each branch and its state |

`worker/deno/tests/completion_phase_merged_pr_closure_test.ts` — 2 new cases
driving the real recovery path end to end: a merged PR on someone else's
branch leaves the issue open and comments naming our branch; a merged PR on
our own branch still closes it.

`tests/fixtures/merge_landing_stub.ts` gains `headRefName` and a
`mergedPrViewFor(head)` builder. A fixture with no head is now a PR of unknown
provenance, which must never authorise a close — so a test that expects a
close has to say the head is its own. That is the contract change, expressed
in the fixture.
