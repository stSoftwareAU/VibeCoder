# Security sweep — the re-approved-then-superseded hand-off (`reapproval_superseded_handoff.ts`)

**Issue:** [#1862](https://github.com/stSoftwareAU/VibeCoder/issues/1862)
(chunk 12p) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12o) recorded their coverage:

- `worker/deno/lib/reapproval_superseded_handoff.ts` — added by #1862.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12p**, and this file is
the reading of it.

## `worker/deno/lib/reapproval_superseded_handoff.ts`

The module turns two facts a run already holds — a post-merge re-approval the
merged-PR pre-check recorded, and a superseded run outcome — into one public
issue comment and one `needs-human` label. It writes to a **public issue** and
interpolates **GitHub-supplied metadata** into that comment, so the shapes
below are 12c's untrusted-ingestion shapes and the comment-authoring shapes
together.

Shapes checked:

| Property | Result |
| -------- | ------ |
| no spawn, no argv | the module builds no argv and runs no subprocess; the injected `ghFn` is passed through to the shared escalation plumbing, which owns every call |
| no filesystem, no network of its own | nothing is read or written outside the injected `ghFn` |
| no clock of its own | the only time value is the `addedAt` the pre-check recorded; the dedup window's clock belongs to `escalateToHuman` |
| the label cannot be attacker-chosen | `label` comes from the pre-check's filter over `config.issueLabels` + `config.workOnLabel` — operator configuration, never an arbitrary label present on the issue |
| the adder cannot be attacker-chosen | `addedBy` reached the state only after `isAuthorTrusted(…, config.allowedAuthors)` and the fleet-author exclusion, so the login rendered in the comment is a trusted human's |
| a hostile timestamp cannot throw | `formatUnixSeconds` rejects a non-finite value and guards `toISOString`'s `RangeError`, degrading to the raw value — a hand-off must not be lost to a badly-reported instant |
| no secret can reach the comment | every field is a label name, a login, a PR number, a PR URL or an instant; no model output, no command output, no environment value is interpolated |
| the label goes through the chokepoint | the escalation routes through `escalateUnworkableWorkOn` → `escalateToHuman`, so `needs-human` is never applied without its explanation comment and `assertWorkerCanApplyLabel` still gates the mutation |
| a forged dedup marker cannot silence the hand-off | suppression is author-verified by `selectFleetAuthoredComments` (#1216) — a marker planted by a non-fleet author does not suppress the comment |
| the trigger cannot fire on its own | both facts are required; a re-approved run that raised a PR, and a superseded release with no re-approval, are both no-ops that issue zero calls |
| a failed hand-off is reported, never raised | the shared helper logs the failure and this module answers `null`, so the run's own outcome survives a GitHub outage; nothing is reported as delivered that was not |
| the hand-off can only reduce what the worker does | it adds a label and a comment; it cannot close the issue, claim anything, push a branch or raise a PR |

No findings. The accepted residual: the hold is `needs-human` plus the main
loop's discovery-label strip, so resuming the issue needs the label surgery the
comment's own next step spells out — the issue asked for a hold released by a
trusted author's comment, and the fleet's only such hold is this one. The
consequence is stated in the comment rather than left for a human to infer.
