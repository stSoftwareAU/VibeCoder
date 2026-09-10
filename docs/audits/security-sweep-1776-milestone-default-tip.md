# 🔎 Security sweep — the milestone-sync cadence tip (`milestone_default_tip.ts`)

**Issue:** [#1776](https://github.com/stSoftwareAU/VibeCoder/issues/1776)
(chunk 12q) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12p recorded its coverage:

- `worker/deno/lib/milestone_default_tip.ts` — added by #1776.

Chunk 12c's claim on `worker/deno/lib/milestone_activity_gate.ts` is removed in
the same change: #1776 deleted that module (its closed-issue gate is gone), so
the claim would otherwise name a file that does not exist.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12q**, and this file is the
reading of it.

## `worker/deno/lib/milestone_default_tip.ts`

The module answers one question for the milestone-sync cadence: what commit is
`origin/<defaultBranch>` in a given clone? It calls `ensureDefaultBranchCurrent`
(which validates the branch name and fetches the ref) and then one
`git rev-parse origin/<defaultBranch>` through the `runGitCommand` chokepoint.

Shapes checked (12a's — a module whose arguments reach a subprocess — 12b's
filesystem reach, 12c's untrusted data, and 12e's):

| Property | Result |
| -------- | ------ |
| a branch name cannot become a git option | ✅ `ensureDefaultBranchCurrent` runs first and puts the name through `assertSafeRefComponent`, returning an error for anything that is not a safe ref component; the rev-parse is only reached after that passes. `readLocalDefaultTip - a branch name that is not a safe ref is refused (Issue #1776)` drives `--upload-pack=touch /tmp/pwned` through the real module and asserts it is refused |
| no shell, no string-built command line | ✅ both calls pass a fixed argv array to `runGitCommand` (the `git_timeout.ts` chokepoint); `origin/${defaultBranch}` is one array element, never a command line |
| untrusted output cannot be mistaken for a tip | ✅ stdout is matched against `/^[0-9a-f]{40}$/` before it is returned. Anything else — empty output, a `fatal:` line on stdout, an abbreviated ref — returns `{ ok: false }`, and the caller treats an unknown tip as "sync anyway" rather than "unchanged" |
| a lookup failure cannot read as success | ✅ a failed fetch, a non-zero `rev-parse`, and a non-SHA answer each return a `Result` error naming the branch and what git said; `syncMilestoneBranches` logs that message as a WARNING and syncs. The permissive direction is deliberate and is the safe one here: an unreadable tip must never park every milestone branch silently |
| filesystem reach | ✅ the module opens no files itself. `cwd` is built by the caller from the configured work directory and the monitored repo's name, and is only ever handed to git as its working directory |
| environment and secrets | ✅ no `Deno.env` read, no credential handling, nothing logged but git's own error text, which reaches the caller's redacting logger |
| blast radius of a wrong answer | ✅ bounded in the cheap direction — a wrong "moved" costs one extra merge-down (a no-op merge when the branch is already current); a wrong "unchanged" would need git to report a stale SHA after a successful fetch of that same ref |
| issue and PR lifecycle | ✅ the module writes nothing: no `gh` call, no comment, no label, no push |

No findings.
