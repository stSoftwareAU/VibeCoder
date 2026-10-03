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

The external inputs are `state.claudeOutput` — the agent's own final
message, which is untrusted: a prompt-injected run can put anything there —
and, on the committed path, a `getIssue` lookup for the dependency a
`## Blocked:` line names (`owner/repo#N` taken from that message). The
lookup's `state` is trusted only as `OPEN` or not: anything else, including
a missing field or a thrown lookup, does not defer.
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

Before a committed hand-off the module pushes the branch through
`deps.git.commitAndPushPending`. That helper runs `git add`, `git commit`
and `git push`. It refuses the default branch and runs `assertSafeToCommit`
before the commit. The hand-off comment is posted only once nothing is left
unpushed. A failed push returns a failure and posts no comment. A
workflow-scope refusal is reported through `workflowScopePushRefusalMessage`
so the run is `token_scope`; any other push failure starts with
`Git push failed` so it is `push_failure`. The git commands are the helper's.
Nothing taken from the agent's output is executed.

## `worker/deno/lib/phases/declared_handoff_phase.ts`

A thin phase wrapper: it calls `handOffDeclaredOutcome` above, returns its
`result` unchanged when one was produced, and otherwise — when `declared` is
true but no guard let the signal apply — calls the same `handOffAnalysisOnly`
helper and returns `early_exit`. When nothing was declared it returns
`{ status: "continue" }`, letting the run proceed to `bump_deps` as normal.

Because this phase runs only after a commit-producing execute phase, it
calls `pushCommittedBranchForHandoff` before applying a declared hand-off.
That is the push described above: `commitAndPushPending`, with its
default-branch guard and `assertSafeToCommit`. The hand-off is applied only
once nothing is left unpushed. A failed push returns that failure and posts
no comment. The phase never raises a pull request. A path with no declared
signal returns `{ status: "continue" }` and leaves `bump_deps` →
`quality_gate` → `completion` to open the PR.
