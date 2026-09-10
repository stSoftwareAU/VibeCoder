# 🔎 Security sweep — the milestone roll-back (`milestone_rollback.ts`)

**Issue:** [#1771](https://github.com/stSoftwareAU/VibeCoder/issues/1771)
(chunk 12n) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12m recorded its coverage:

- `worker/deno/lib/milestone_rollback.ts` — added by #1771.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12n**, and this file is the
reading of it.

## `worker/deno/lib/milestone_rollback.ts`

The module reverts the merged child PRs of a milestone branch, newest first,
until the default branch merges cleanly, then pushes the result. It reads merged
child PRs from `gh pr list`, hands their merge SHAs to `git revert`, and pushes
the milestone branch (or raises the Issue #589 sync PR when a ruleset refuses
the push).

Shapes checked (12a's — a module whose arguments reach git — 12c's untrusted
GitHub data, and 12e's):

| Property | Result |
| -------- | ------ |
| GitHub-chosen values cannot become git options | ✅ every merge SHA from `gh` is matched against `/^[0-9a-f]{7,40}$/` before it reaches `git revert`, `git rev-list` or `git diff-tree`; a value that fails is dropped by `planRollback` rather than passed. The milestone and default branch names are refused by `assertSafeGitRef` before any git runs, which is what stops a `-`-leading ref |
| no shell, no string-built command line | ✅ the module spawns nothing: `git` and `gh` are injected seams taking an argv array, so no value is ever concatenated into a command line |
| a PR title cannot forge history | ✅ the title is used only as the quoted text of a revert commit message passed as a single `-m` argument; `parseRevertedChildPrs` matches `Revert child PR #N` and reads **numbers** only, so a title claiming to revert something changes no decision the module makes |
| untrusted listing cannot be mistaken for absence | ✅ a listing that does not parse, a `gh` call that fails, an unreadable `diff-tree`, `rev-list` or `log` all fail the roll-back with the cause named; none reads as "there are no children" or "this child touched nothing" |
| filesystem reach | ✅ none — the module reads and writes no files itself; every effect is a git command in the caller's clone |
| environment and secrets | ✅ no `Deno.env` read, no credential handling; logging goes to the caller's injected `log` seam, which redacts at the sink |
| blast radius of a wrong answer | ✅ bounded by construction — the pre-roll-back SHA is recorded first and every outcome short of a clean merge ends at `git reset --hard <pre-roll-back SHA>` with nothing pushed. No push is ever forced, only the milestone branch is pushed to, and the default branch is never written. A merged tree the caller's `verify` seam refuses is reset away, and a roll-back with no gate says `UNGATED:` in the log rather than passing for a checked one |
| issue and PR lifecycle | ✅ the module closes, reopens, labels and merges nothing; the only GitHub write on the path is `raiseMilestoneSyncPr`, which already carries #589's own boundary |

No findings.
