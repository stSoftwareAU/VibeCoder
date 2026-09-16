# Security sweep — the milestone-refusal label release (`milestone_branch_refusal_release.ts`)

**Issue:** [#2220](https://github.com/stSoftwareAU/VibeCoder/issues/2220)
(chunk top-up-2220) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2220:

- `worker/deno/lib/milestone_branch_refusal_release.ts` — added by #2220.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2220**, and this file is the reading of it.

## `worker/deno/lib/milestone_branch_refusal_release.ts`

One sweep function plus three pure helpers. It spawns nothing itself: every
GitHub read and write goes through the injected `ghCommandFn`, which is the
worker's own `runGhCommand` boundary (swept under chunk 12a). It reads and
writes no file, opens no socket, and touches no environment variable directly —
`Deno.env` is reached only inside `alert_dedup_authors.ts`, through its own
`EnvLookup` seam.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `gh issue list --json number,labels` output | GitHub, for the repository the run already holds a claim on | `JSON.parse` inside a `try`; a non-array throws. Each row is shape-checked field by field — a non-numeric `number` and a non-string label `name` are dropped, never coerced. A parse fault is recorded in `errors`, not thrown |
| `gh issue view --json comments` output | GitHub; each comment body is text **anyone who can comment on the repository may write** | Shape-checked the same way, then filtered through `selectFleetAuthoredComments` so only a comment authored by the configured fleet identity is read as a failure record. Both the `{ login }` and bare-login author shapes are normalised |
| the surviving comment bodies | fleet accounts only, after the filter above | matched against an anchored heading regex, then classified by `detectFailureCategory` — the same function used at failure time, so the category precedence cannot diverge between the two sites |
| `repo`, `milestoneTitle`, `milestoneBranch`, label names | the run's own claim and its `WorkerConfig` — both callers pass the deployment's configured `failed` / `failed-once` names, so the sweep can only remove labels this fleet actually applies | passed as separate argv elements to `gh`, never concatenated into a command string. `milestoneBranch` and the label names are additionally interpolated into the release comment's Markdown |
| `limit` | caller, default 100 | stringified into `--limit` |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | none: `ghCommandFn` takes a `string[]`, so every value is one argv element and no metacharacter is interpreted. No `gh` argument is built by concatenation |
| environment | untouched — no `Deno.env` read or write in this module |
| filesystem | none |
| network | none directly; only the injected `gh` runner |
| regex safety | two literals, both linear. `FAILURE_RECORD_RE` is anchored (`^##\s+…` with `m`) and its only quantifier is a single `\s+` over a literal alternation — no nested quantifier, so no catastrophic backtracking on an attacker-sized comment |
| secret surface | no credential is read, logged or interpolated. The only text echoed back to GitHub is the release comment, built from the branch name and the label names — both worker configuration |
| resource bounds | two `gh issue list` calls capped by `--limit` (default 100), then at most one `gh issue view`, one `gh issue edit` and one `gh issue comment` per candidate. The module-level `swept` registry caps a clean sweep at one per `repo branch` per process |
| authorisation | the writes are label removals and one comment on issues in the repository the run already holds a claim on. No issue is closed, reopened, assigned or transferred |
| fail direction | every unknown fails towards **keeping** the label: a `gh` fault, a malformed payload, a comment whose author is outside the fleet, and an unresolvable fleet identity all end with the issue in `retained`. Nothing is swallowed — each fault is pushed onto `RefusalReleaseOutcome.errors`, both callers log them, and a sweep that hit a fault releases its once-per-run claim so a later milestone setup in the same process retries |

**One finding, fixed in this change.** As first written the sweep read the
comment **bodies** only. A failure record is plain Markdown with no
authenticated part but its author, so on a public repository any account able
to comment could post a `## Automated Processing Failed` block quoting a
`GH013` refusal and have the sweep strip a genuine `failed` label — returning
an issue the fleet had permanently failed to the work queue. The comment read
now goes through `selectFleetAuthoredComments` (`alert_dedup_authors.ts`), the
same chokepoint `claim_pr_comment.ts`, `label_clarification.ts` and
`shared_cooldown.ts` use, against the fleet identity (`service_accounts` ∪
`fleet_pr_authors` ∪ this host's `GITHUB_USER`) — never `allowed_authors`, and
never `--author @me`, which would break cross-host convergence. The setup-phase
caller resolves that identity from the `WorkerConfig` it already holds rather
than re-reading the config file. Regression tests:
`releaseMilestoneBranchRefusalLabels - a refusal record written outside the
fleet releases nothing` and `… - an unresolvable fleet keeps every label`.

The two remaining fail-direction claims above are pinned by tests as well:
`… - a malformed issue list is reported and releases nothing` (a payload that
is not an array must not read as an empty milestone) and `… - a comment that
fails after the label came off is still a release, and is said out loud`.

No other finding. The one deliberate trust decision left is that the release
comment interpolates `milestoneBranch` and the label names into Markdown
unescaped; both are worker configuration — a slug the worker derives from the
milestone title and the label names from `WorkerConfig` — not values any
issue author controls.
