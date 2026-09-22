# 🔎 Security sweep — the milestone roll-back re-queue (`milestone_rollback_requeue.ts`)

**Issue:** [#1781](https://github.com/stSoftwareAU/VibeCoder/issues/1781)
(chunk 12v) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12u) recorded their coverage:

- `worker/deno/lib/milestone_rollback_requeue.ts` — added by #1781.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12v**, and this file is
the reading of it.

## `worker/deno/lib/milestone_rollback_requeue.ts`

The module is the GitHub half of a milestone roll-back: it reopens each
reverted child's issue, posts the roll-back marker, closes that issue's open
PRs and any open summary PR, and posts exactly one notice. A roll-back that
could not merge escalates once with `needs-human` on an issue that already
exists.

Shapes checked (12c's — untrusted GitHub data — and 12e's):

| Property | Result |
| -------- | ------ |
| untrusted listing cannot invent an issue | ✅ `resolveIssueForRevertedPr` only accepts the branch shape (`issue-<n>-`) or a GitHub closing keyword `#N`; a bare `See #12` is nowhere. A `pr view` / `issue view` / `pr list` that does not parse leaves that child skipped and is said out loud |
| a pickup label the worker must not apply is never applied | ✅ `isWorkerAppliableLabel` is the only gate; `work-on` is stripped and listed for a trusted re-label. The module never calls `--add-label work-on` |
| the success notice cannot escalate | ✅ `buildRollbackNotice` does not mention `needs-human` and the success path never adds that label. Only `escalateRollbackFailure` does, and only on `merged: false` |
| no new issue is filed | ✅ every `gh` call is `issue comment`, `issue reopen`, `issue edit`, `issue view`, `pr list`, `pr view` or `pr close`. There is no `issue create` |
| no shell, no argv construction from GitHub text | ✅ issue numbers are integers; branch and SHA values reach comments as already-sanitised marker fields (`buildRollbackMarker` refuses quotes and angle brackets) |
| a failure cannot read as success | ✅ a comment, reopen, label or close that throws is logged and omitted from the result; `countedAsEscalated` is false when the failure comment did not go out, so the next cycle retries |
| blast radius of a wrong answer | ✅ only the reverted child's issue and PRs are mutated. An untouched sibling is never reopened. A destination of `none` posts nothing |

No findings.
