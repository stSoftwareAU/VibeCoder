# 🔎 Security sweep — declared-outcome hand-off on a commit-producing run

**Issue:** [#3088](https://github.com/stSoftwareAU/VibeCoder/issues/3088)
(chunk top-up-3088) · **Parent:** #1209

This is the written record for the two modules that entered
`worker/deno/lib/` under #3088:

- `worker/deno/lib/phases/declared_handoff.ts`
- `worker/deno/lib/phases/declared_handoff_phase.ts`

## Why a new slice

Appending these modules to a slice whose sweep ran before they existed would
make `diffCoverage` green on a false record. They are claimed by
**top-up-3088**, and this file is the reading of them.

## `worker/deno/lib/phases/declared_handoff.ts`

The only external input is `state.claudeOutput` — the agent's own final
message, which is untrusted: a prompt-injected run can put anything there.
`handOffDeclaredOutcome` runs three detectors over it in a fixed order
(blocked dependency, time deferral, planning request) and, where one fires,
hands off through existing, already-audited helpers rather than writing
anything itself: `deferBlockedIssue`, `deferIssueUntil`,
`handOffAnalysisOnly`, and `handOffToPlanning`. Those write only GitHub
comments/labels via the passed-in `ghClient`/`ensureLabelExists`, never the
filesystem or a subprocess.

Anything taken verbatim from the agent's output and published in a comment
(`outputSnippet`) goes through `publishableSnippet` first, which runs
`redactSecrets` over the full text *before* slicing to the last 3000
characters, so a credential cannot be split across the cut and left
unmatched.

Each detector carries its own loop guard: `hasPriorDeferralOnThread` stops a
second deferral on the same dependency, `countPriorTimeDeferrals` enforces
`MAX_TIME_DEFERRALS` before a further time-deferral is granted, and
`hasPriorPlanningHandoffOnThread` stops a second planning request. A tripped
guard falls through rather than retrying, and the caller treats that as
`declared: true` so a human still sees it.

The planning branch is trust-gated: `handOffToPlanning` only runs when the
issue already carries the human-applied `PLANNING_HANDOFF_ANCHOR` label, and
`gatePlanningHandoff` can still withhold it over untrusted images — both read
data the caller already holds (`ctx.issueLabels`, `ctx.untrustedImages`)
rather than executing agent-controlled text.

No shell command, filesystem write, or subprocess spawn appears in this
module.

## `worker/deno/lib/phases/declared_handoff_phase.ts`

A thin phase wrapper: it calls `handOffDeclaredOutcome` above, returns its
`result` unchanged when one was produced, and otherwise — when `declared` is
true but no guard let the signal apply — calls the same `handOffAnalysisOnly`
helper and returns `early_exit`. When nothing was declared it returns
`{ status: "continue" }`, letting the run proceed to `bump_deps` as normal.

Because this phase runs only after a commit-producing execute phase, the
key property is what it does not do: it never pushes the run's local commits
and never raises a pull request. Every path either defers to a human via a
comment/label, or returns `continue` and leaves the unchanged `bump_deps` →
`quality_gate` → `completion` pipeline to decide whether to push and open a
PR. No new network, filesystem, or subprocess surface appears here either.
