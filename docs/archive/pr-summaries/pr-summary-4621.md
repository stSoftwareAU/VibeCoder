## Summary

Agent-raised PRs now receive the worker's canonical issue title during adoption. Milestone rollups also recover merged deliveries from a same-repository `issue-N` head branch, so older PRs without a title reference are claimed accurately. Closes #4621.

Version bump: none for this change.

## Spec

### Intent and Rationale

- Adoption previously rebuilt the PR body but kept an agent-chosen title, leaving issue-title matchers unable to identify the delivery.
- Title repair handles new adoptions; a separate branch search recovers already-merged PRs without broadening the shared canonical title-search contract.

### Essential Design Decisions

- Keep recognised title references unchanged; otherwise use `buildPrTitle(issueTitle, issueNumber)` so normal scrubbing and formatting remain authoritative.
- The fallback requires a merged PR, a same-repository head, and an exact issue number parsed by `issueNumberFromBranch`; sync branches, forks, prefix matches and unmerged PRs do not qualify.
- Bump the claim-verdict cache prefix from v1 to v2 and test that an old `sync-pr-only` verdict is ignored. Unreadable branch searches are flagged and not cached, so later scans retry them.
- The issue's private-repository examples did not include repository or PR identifiers. The public examples were verified; the private examples were not independently inspectable.

### Undiscoverable Facts

- `gh pr view` showed VibeCoder PR #3783 with head `issue-3614-enableautomerge-…`, a `milestone/*` base, and a same-repository merged head. NEAT-AI-Discovery PRs #2406 and #2464 had heads beginning `issue-2263-…` and `issue-2271-…` respectively and also targeted milestone branches.
- A real `gh pr list --repo stSoftwareAU/VibeCoder --state merged --search 'head:issue-3614' --json number,title,headRefName,baseRefName,mergedAt,isCrossRepository --limit 1000` returned PR #3783 with `isCrossRepository: false`; the query result is rechecked against the exact issue number in code.
- The private-repository examples lack repository and PR identifiers in the issue, so their branch metadata could not be checked independently.

## Evidence

```mermaid
sequenceDiagram
    participant C as Completion phase
    participant A as Agent PR adoption
    participant G as GitHub PR
    participant M as Milestone rollup
    C->>A: issue title, issue branch, pushed HEAD
    A->>G: read title; repair if issue ref is missing
    A->>G: synchronise adopted body
    M->>G: search canonical title and merged issue-N heads
    M->>M: require same-repo exact issue branch and check reopen time
```

- The regression test for branch recovery failed against the pre-fallback classifier, then passed with the fallback. Disabling title repair made the title-repair and already-marked-body tests fail. Replacing the completion caller's issue title made its wiring test fail.
- Mutating the same-repository filter, exact branch-number check, merged-state query, reopen comparison, or v1-to-v2 cache prefix made the corresponding milestone tests fail. The title-edit failure test also confirms the error is logged while body adoption continues.
- This change is backend and documentation only; no screenshot applies.

## Test Plan

- `worker/deno/tests/agent_pr_adoption_test.ts`: `repairs a noncanonical title before adopting the body`, `preserves a canonical title`, `repairs title when the marked body is skipped`, `repeats safely after repairing the title`, and `reports title edit failures and still syncs the body`.
- `worker/deno/tests/milestone_completion_test.ts`: `recovers merged same-repo issue-branch PRs and preserves reopen checks`, `ignores the persisted v1 verdict after branch recovery changes`, and `unreadable branch PR search retries instead of claiming no delivery`.
- `worker/deno/tests/completion_phase_acceptance_closure_test.ts`: `passes the issue title to agent-raised PR adoption`.
- `deno task test:unit tests/agent_pr_adoption_test.ts tests/milestone_completion_test.ts tests/completion_phase_acceptance_closure_test.ts` — passed, 176 tests.
- `deno fmt` on the seven changed TypeScript files — passed.
- `deno lint` on the seven changed TypeScript files — passed.
- `deno check --frozen --lock=deno.lock` on the four changed production modules — passed.
- **Docs sweep** — searched root and nested READMEs, active docs, and source for `agent_pr_adoption`, `agent-raised PR`, `classifyClosedIssues`, `sync-pr-only`, and `milestone_claim_verdict_v1`. Read the milestone completion sections in `docs/INTERNALS.md` and `docs/workflows/milestones.md`, plus the adoption passage in `docs/USAGE.md`; updated all three docs. Remaining hits: `docs/INTERNALS.md:5876` still describes the body-sync helper's adoption role, and `docs/USAGE.md:118` correctly leaves marker-less PRs on other branches alone.
- `markdownlint-cli2` on the active docs set after the `docs/USAGE.md` edit — passed; 0 reported issues.
- `deno task pr-summary-check --base main --issue-body-file /tmp/vibe-issue-4621-body.md --labels work-on,idle-task ../../docs/archive/pr-summaries/pr-summary-4621.md` from `worker/deno` — passed; 0 blocked and 0 not checked.
- `deno task check:manifests` — failed on the existing `worker/deno/lib/fleet_babysitter_codex.ts` entry missing from `docs/audits/lib-sweep-coverage.json`; the same failure is present on `origin/main` at commit `82b1e121`.
- `./quality.sh < /dev/null` — failed because its completeness check and Deno test pass report that same base-branch sweep-ledger omission; Deno lint, type check, formatting, Mermaid, markdownlint and Semgrep passed. Config integration and Checkov were skipped by the environment.
- Removed from `worker/deno/tests/milestone_completion_test.ts`: `assertEquals(bad[0]?.claimProblem, "sync-pr-only");`
  - Required by: "So the rollup body tells the reviewer that delivered work may be missing from the branch."
  - Replaced by: `assertEquals(bad[0]?.claimProblem, "merged-pr-search-unreadable");` — an unsuccessful PR read is no longer described as proof that no delivery exists.
- No other existing-test assertions were removed. No `deno.lock` change was made.
- **Not checked:** the private-repository PR examples could not be queried because the issue omitted their repository and PR identifiers. No other known risk remains.
