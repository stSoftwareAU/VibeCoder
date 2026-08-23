# PR Summary — Issue #321

## Summary

`[idle-detect] ALERT mis_classification` and `[idle-census] ALERT inversion`
are the fleet's own contradiction detector: the census can see claimable work
the claim scan cannot. Both end at `log(...)`.

They named `stSoftwareAU/VibeCoder` on every cycle from 2026-08-21 to
2026-08-22 while `#187` and `#188` sat unclaimable, and escalated to nothing.
The cause (Issue #319 — a merged PR's title mentioning `#N` blocking those
issue numbers permanently) was found by a human asking why the issues had not
been worked, not by the alert. An alert that fires every cycle and changes
nothing is indistinguishable from no alert.

This gives the signal a memory. `idle_inversion_streak.ts` counts consecutive
**cycles** in which a repo raises the inversion and, at
`IDLE_INVERSION_THRESHOLD` (3), files **one** issue against that repo naming
the claimable count, how long it has persisted, and where to look.

### Cycles, not ticks

The census runs several times per cycle — the #319 log shows ticks 1, 2 and 3
inside one — so a per-tick count would escalate a momentary deferral into a
filed issue. Each entry records the cycle id that last incremented it
(`resolveRunId()`, stable for the life of a run) and ignores repeats within it.
This is the single most important rule in the module and has its own test.

### Shape

Follows this repo's existing recurring-failure surfaces — the same shape as
`bump_script_failure_streak.ts` (Issue #207):

- A small JSON file under the work directory, written through `atomicWrite`
  and guarded by `withStateLock`.
- Dedup on a **body marker** rather than the title, as `run_failure_issue.ts`
  does, so two hosts watching the same repo converge on one issue.
- A failed *search* files nothing and says so — a lookup that could not be
  performed must never read as "no issue exists" and produce a duplicate.
- Filed with **no label**: the worker cannot self-apply `work-on`
  (`worker_label_guard.ts` strips a worker-applied pickup label on the next
  scan), so the body asks a human to apply it.
- Body-safe escaping of the census detail, so it cannot forge the dedup marker
  or close the fenced block.
- The streak clears the moment that repo has a clean cycle, so a transient
  inversion never reaches the threshold.

Best-effort throughout: the wiring is wrapped so the idle path can never fail
because its own reporting did.

Closes #321.

## Evidence

Backend/observability change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`** — the module does not exist there.

**They pass here:**

```text
$ deno test --allow-all tests/idle_inversion_streak_test.ts
ok | 12 passed | 0 failed (42ms)
```

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates. `deno tests` reports only the 11 pre-existing
`setup.ps1` failures (`NotFound: Failed to spawn 'pwsh'`, environmental).

The real trigger is reproduced in the fixtures rather than invented: the
report shape is the `stSoftwareAU/VibeCoder work_on=2 pr_blocked=0` census line
that fired throughout the #319 incident.

## Test plan

`worker/deno/tests/idle_inversion_streak_test.ts` — 12 cases:

| Group | Covers |
| --- | --- |
| Cycles, not ticks (1) | Five calls in one cycle count **once** and file nothing — the rule that stops a momentary deferral escalating |
| Threshold (3) | Exactly one issue at the threshold and `already-filed` thereafter, however long the inversion lasts; a streak cleared before the threshold files nothing and restarts from one; clearing an untracked repo is a no-op |
| Two hosts (2) | An open escalation issue is reused rather than duplicated; a marker for another repo is not this repo's issue |
| Failure directions (4) | A failed search files nothing ("a duplicate is worse"); a failed create records no issue number so the next cycle retries; escalation never throws into the idle path; a corrupt state file restarts the streak rather than throwing |
| The issue body (2) | Names the repo, the counts, the ALERT tokens to grep and the `work-on` request; census detail cannot forge a marker or close the fence |

## Scope note

This makes a sustained inversion **visible**; it does not diagnose one. The
underlying cause in this incident was Issue #319, fixed separately in PR #320.
The escalation issue's body points at the skip reasons and names #319 as a
worked example, so the next occurrence starts from evidence rather than from a
human noticing.

Filed alongside this, from the same incident, for the wedge that stopped the
fleet entirely — each with how it should self-heal: #322 (the supervisor
applies no deadline to the run it supervises), #323 (container control plane
can die undetected, and killing the client orphans the VM), #324 (an agent's
unbounded bash busy-wait can starve the worker's own watchdogs) and #325 (a
kill that cannot complete holds its pool slot for ever).
