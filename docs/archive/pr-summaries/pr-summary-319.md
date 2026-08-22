# PR Summary — Issue #319

## Summary

`#187` and `#188` were the only open issues in this repository and the only
claimable work in the whole fleet. They carried `work-on` from a trusted
author, were unassigned, and had **never been claimed** — no comments, no
heartbeats, no WIP. They sat untouched from 2026-08-21.

Every cycle the worker reported the contradiction and did nothing with it:

```text
[idle-detect] repo=stSoftwareAU/VibeCoder total_open=2 claimable=2 reason=has_claimable
[idle-detect] ALERT mis_classification claimable_total=2 repos=stSoftwareAU/VibeCoder
[idle-census] ... work_on=2 pr_blocked=0 availability=available inversion_signal=true
[s1] stop reason=no-work — no eligible work: considered=14 eligible=0 skipped=14
     top-skips=pr-blocked=11,closed-pr-cooldown=2,filtered-out=1
```

Those two `closed-pr-cooldown` skips were `#187` and `#188`.

### Root cause

`isBlockedByRecentlyClosedPR` decided "this issue already has a PR" from a
`RegExp` built from the issue number, tested against the PR **title**:

```ts
const pattern = new RegExp(`#${issueStr}(?:[^0-9]|$)|\\(#${issueStr}\\)`);
```

PR **#212** is a PR for issue **#209**. Its title reads:

> …stservice's open **PR #188** did not block VibeCoderST claiming
> **NEAT-AI-Lamarck#187** 3 min later (and **#178/#184** earlier) (Issue #209)

The `#188` is a **pull request number**. The `#187` is an issue in a
**different repository**. The matcher knew neither, so one title blocked five
issue numbers.

**And it never expires.** Per Issue #3151, `fetchRecentlyClosedPRsForFleet`
keeps *merged* PRs in the blocking set regardless of the cooldown window —
only closed-unmerged PRs age out. PR #212 merged on 2026-08-21, so the block
was permanent while being reported as a "cooldown".

This is the Issue #174 class in the claim path: #174 fixed "any PR
referencing #N is this issue's PR" in the completion and close paths; the
claim scan still did it, with a looser matcher.

### The fix

`prTitleReferencesIssue` replaces the regex. A `#N` counts as this
repository's issue unless it is:

| Shape | Example | Why it is not ours |
| --- | --- | --- |
| Repo-qualified | `NEAT-AI-Lamarck#187`, `owner/repo#187` | GitHub's cross-repo syntax — another repository's issue |
| Pull-request-qualified | `PR #188`, `pull #188`, `pull request #188` | A PR number, not an issue |

The canonical delimited form the fleet's own titles carry — `(Issue #N)`,
`(#N)`, `[#N]` — always counts, via the existing `prTitleMatchesIssue`. A bare
unqualified `#N` still counts, so a human's unconventional title ("Fix #42")
keeps blocking a duplicate PR: this guard would rather over-match than let a
second PR be opened.

`/` is deliberately **not** a repo qualifier. A repo name never ends with a
slash (`owner/repo#187` ends in `o`), whereas `#178/#184` uses one to separate
two references to *this* repo's issues — treating it as a qualifier would have
silently stopped the second one blocking. A test pins that.

**Duplication removed rather than added.** The repository already had the
stricter `prTitleMatchesIssue` in `pr_issue_linking.ts`, used by the cached
`findExistingPrForIssue` path — two different answers to "is this PR for issue
N" was itself the defect. Importing it back into `issue_query.ts` would have
made a cycle (`pr_issue_linking.ts` imports from `issue_query.ts`), so it moved
to a leaf module, `pr_title_issue_ref.ts`, which both import.
`pr_issue_linking.ts` re-exports it, so no existing importer changes.

Neither matcher builds a `RegExp` from the issue number: interpolating an
external value into a pattern is a ReDoS risk, and `issue_query.ts` carries
`unsafe-regex` sweep findings on the line this replaced.

### The skip reason lied

The tally said `closed-pr-cooldown`, which reads as self-healing and sent this
diagnosis down the wrong path for a day — I ruled the cooldown out early
because the window is one hour and the PR had merged 24 hours before. It was
merged PRs never expiring that I had not accounted for.

All three collectors (`work_on`, `low_priority`, `idle_task`) now distinguish
the two, with a new `merged-pr-permanent` `SkipReason` that also names what
clears it:

```text
PR #212 merged at 2026-08-21T06:06:28Z — permanent until a trusted re-label dated after the merge
```

Closes #319.

## Evidence

Backend change with no web interface, so there is no screenshot.

**Reproduced against the live repository** by calling the real
`collectWorkOnCandidates` with the real config. With PR #212 in
`repoClosedPRs`, before the fix:

```text
CONSIDERED stSoftwareAU/VibeCoder#187 → SKIPPED reason=closed-pr-cooldown PR #212 closed at 2026-08-21T06:06:28Z
CONSIDERED stSoftwareAU/VibeCoder#188 → SKIPPED reason=closed-pr-cooldown PR #212 closed at 2026-08-21T06:06:28Z
```

Same inputs, after the fix:

```text
CONSIDERED stSoftwareAU/VibeCoder#187 → ELIGIBLE
CONSIDERED stSoftwareAU/VibeCoder#188 → ELIGIBLE
```

**One title blocked five issues** before the fix, verified directly:

```text
issue #178 -> BLOCKED by PR #212      issue #187 -> BLOCKED by PR #212
issue #184 -> BLOCKED by PR #212      issue #188 -> BLOCKED by PR #212
                                      issue #209 -> BLOCKED by PR #212
```

After: `#209` (its own issue) and the bare `#178`/`#184` still block; `#187`
and `#188` do not.

**Test suite:**

```text
$ deno test --allow-all tests/pr_title_issue_ref_test.ts
ok | 11 passed | 0 failed
```

**No regression** across the query, linking, collector and recovery suites —
17 files:

```text
$ deno test --allow-all tests/*issue_query* tests/*pr_issue_linking* \
    tests/*collect_work_on* tests/*stuck_recovery*
ok | 224 passed | 0 failed

$ deno test --allow-all tests/*collect_* tests/*issue_finder*
ok | 104 passed | 0 failed
```

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates. `deno tests` reports only the 11
pre-existing `setup.ps1` failures (`NotFound: Failed to spawn 'pwsh'`,
environmental).

## Test plan

`worker/deno/tests/pr_title_issue_ref_test.ts` — 11 cases, built on PR #212's
**real** title rather than invented text:

| Case | Asserts |
| --- | --- |
| PR #212 refers to 209 and nothing else it mentions | The whole bug in one assertion: `#209` matches, `#187` and `#188` do not |
| a bare cross-reference in the same title still blocks | `#178`/`#184` deliberately still match — the guard prefers over-matching to a duplicate PR, and narrowing those needs more than a title |
| another repository's issue never matches | Four qualified shapes, including `owner/repo#187` and `repo.name#187` |
| a delimited reference still matches next to a qualified one | `OtherRepo#187 (Issue #187)` — the canonical form is a positive identification |
| a pull-request reference never matches | `PR #188`, `pull #188`, `pull request #188`, `pr #188` |
| `PR` inside another word does not suppress a real reference | `REPR handling for #188` still matches — the qualifier is the preceding word, not a substring |
| the worker's own title convention still blocks | All four delimited styles |
| a bare unqualified reference still blocks | `Fix #42`, `Closes #42`, `Work on #42` |
| a longer number is not a match | The pre-existing `#42` ⊉ `#421` guarantee, in both paths |
| a title with no reference matches nothing | Including the empty title |
| `prTitleMatchesIssue` unchanged by the move (#106) | The moved function keeps its exact contract |

No new test is added for the `merged-pr-permanent` skip reason: it is a log
label on an existing branch, and the 104 collector/logger cases already cover
the branch itself.

## Follow-up worth considering separately

The `[idle-detect] ALERT mis_classification` and `[idle-census] ALERT inversion`
lines fired on **every cycle for over a day** — the census could see claimable
work the scan could not — and nothing escalated. An inversion that persists
across N cycles should raise rather than log at INFO; the detection already
exists, only the response is missing.
