# Security sweep — the in-run milestone create-block repair (`milestone_create_block_repair.ts`)

**Issue:** [#2079](https://github.com/stSoftwareAU/VibeCoder/issues/2079) (chunk
top-up-2079) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2079:

- `worker/deno/lib/milestone_create_block_repair.ts` — added by #2079.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2079**, and this file is the reading of it.

## `worker/deno/lib/milestone_create_block_repair.ts`

One decision function. It classifies the git text a refused milestone-branch
push came back with, and — when that text names a repository **ruleset** —
drives two injected edges in order: exempt the ruleset from branch creation,
then retry the branch creation once. It owns no credential, spawns nothing,
touches no filesystem, and holds one process-lifetime `Set` of repository slugs
so a run attempts the repair at most once per repository.

Untrusted inputs, and how each reaches the output:

| Input                      | Source                                                          | How it is handled                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detail`                   | git's own stderr, relayed by `ensureMilestoneBranchExists`      | tested against three fixed, anchored regexes; never interpolated into an argv, a URL or a shell string. It is not copied into the module's output at all — the caller already carries it into the handoff |
| `repo`                     | the claimed issue's repository, worker-controlled               | used as a `Set` key and passed to the injected `repair` edge, which validates the slug itself (`isValidRepoSlug`) before any `gh` call                                                                    |
| `milestoneBranch`          | derived from the milestone title by `createMilestoneBranchName` | interpolated into an operator-facing note only                                                                                                                                                            |
| `repair` / `retry` results | the injected edges                                              | error messages are folded into a note the caller posts as a GitHub comment; no value is executed, parsed or used to choose an endpoint                                                                    |

| Property          | Result                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no spawn, no argv | the module spawns nothing and builds no argv; the one `gh` write lives behind the injected `repair` edge, wired in `issue_worker_wiring.ts` to `repairMilestoneRulesetCreateBlock` (swept under its own slice) and reaching GitHub through the `spawnGh` chokepoint, which refuses a write to any repo off the run's allowlist                     |
| regex safety      | three literal-anchored alternation-free patterns (`\bGH013\b`, `repository rule violations`, `push declined due to repository rule`) — no nested quantifier, so no backtracking surface on an attacker-sized stderr                                                                                                                                |
| filesystem        | none                                                                                                                                                                                                                                                                                                                                               |
| network           | none of its own                                                                                                                                                                                                                                                                                                                                    |
| injection         | every string it produces is a fixed sentence plus a branch name, a ruleset name and an error message; nothing reaches a shell, an argv or a URL                                                                                                                                                                                                    |
| secret surface    | it emits no credential; the error text it folds into a note has already passed the redaction the `gh` layer applies                                                                                                                                                                                                                                |
| resource bounds   | O(1) per call — three regex tests and one `Set` lookup; the `Set` grows by at most one entry per repository per process                                                                                                                                                                                                                            |
| fail direction    | fail-loud by construction: only a positively confirmed repair **and** a successful retry return `recovered`. A refused write, a ruleset it may not safely touch, and a retry that is still refused each return `failed` with the reason, and the caller then fails the run and escalates. Nothing returns "recovered" for want of a failure marker |
| blast radius      | the write itself is bounded by `planMilestoneRulesetRepair`, which only ever names a ruleset whose ref patterns are **all** under `refs/heads/milestone/`; a ruleset reaching `~ALL` or the default branch is left for a human                                                                                                                     |

No finding. The one deliberate trust decision is that the refusal text is
believed about its own cause: a message naming a ruleset triggers one read and
at most one write, both scoped to the repository the run already holds a claim
on. Believing a forged message costs one refused API call and an unchanged
handoff, because the repair still has to find a milestone-only ruleset that is
actually blocking before it writes anything.
