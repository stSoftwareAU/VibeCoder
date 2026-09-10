# Security sweep — implementation-prompt comment selection (`implementation_comments.ts`)

**Issue:** [#1910](https://github.com/stSoftwareAU/VibeCoder/issues/1910)
(chunk 12z) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12y) recorded their coverage:

- `worker/deno/lib/implementation_comments.ts` — added by #1910.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12z**, and this file is the reading of it.

## `worker/deno/lib/implementation_comments.ts`

The module decides **which** of an issue's comments the implementation prompt
carries, and **how many characters** of them. That prompt is the most
privileged one the fleet runs, and comments are the most accessible attack
surface on a public repository, so these are 12c's untrusted-ingestion shapes.

It deliberately implements no trust logic of its own: classification,
suspicious-pattern auditing, the per-author volume caps and the per-comment
nonce headers stay in `comment_trust_filter.ts` / `comment_rate_limiter.ts`
(both already swept), and this module only orders and bounds what is handed to
them.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; every function is pure over the comment rows it is given |
| no filesystem, no network, no `gh` | nothing is read or written; the comments arrive from the caller's existing `fetchIssueData` result, so no extra API call is made |
| no environment or secret sinks | no `Deno.env`; secret masking still happens where it always did — `sanitiseDelimiterPatterns` runs on every body inside `formatDelimitedComment` |
| no clock, no ordering by attacker data | selection walks the caller's chronological array by index; no timestamp, ordering field or id from GitHub is trusted |
| trust is never inferred from a body | `isWorkerNoiseComment` only ever **drops** a comment. A comment body that fakes the run-stats marker removes *itself* from the prompt and nothing else — an attacker can silence their own comment, never another author's, and can gain no trust by it |
| a flood cannot evict direction | admission is newest-first in three passes — trusted authors (`classifyCommentAuthor`), then other non-worker authors, then the worker itself — so neither the worker's own bookkeeping nor 40 untrusted comments can push a maintainer's reply out of the budget |
| the budget is bounded and the bound is stated | 20 comments / 12,000 characters of body, below the 20,000-character rate-limiter cap that still runs afterwards; the caps are named constants, not magic numbers spread over the callers |
| a single oversized comment cannot starve the set | one comment larger than the whole budget is admitted only when nothing else has been, and `applyCommentRateLimits` truncates it downstream rather than the prompt losing every comment |
| the trust header cannot be forged | headers are minted by `formatDelimitedComment` with a per-run nonce, and `sanitiseDelimitedComments` in the prompt builder keeps only whole-line headers bearing *this* run's id — an untrusted commenter's pasted `[TRUSTED]` header is scrubbed to inert data (covered by `tests/issue_prompt_comments_1910_test.ts`) |
| no trust configuration is still bounded | the plain path (`formatPlainComments`) runs the same selection first and then `capFormattedComments`, so a repository with no trust lists gets the same volume ceiling |
| audit events are not swallowed | `securityAuditMessages` from the trust filter are returned to both call sites, which log them at `warn` — a suspicious untrusted comment is still reported even though the blob is now bounded |

### Findings

None.

### Accepted residuals

- **Selection runs before the per-author caps, not after.** A comment dropped
  here never reaches `applyCommentRateLimits`, so the untrusted-count cap
  applies to what survived selection. This is the intended order: selection is
  a context-budget bound, the caps are an attacker-volume bound, and trusted
  authors take the budget first, so the sequence cannot let an untrusted author
  displace a trusted one.
- **The repeat-deferral loop guard reads the same blob**
  (`hasPriorDeferral(ctx.issueComments, …)`). Bounding the blob could in
  principle age out a prior deferral comment on a very long thread; dropping
  the run-stats and release bookkeeping — by far the bulk of a resumed issue's
  volume — makes a marker-bearing comment *more* likely to survive than the
  previous oldest-first truncation at 20,000 characters, and on the main-loop
  route the guard previously saw an empty string and could never fire at all.
