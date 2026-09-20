# Render an `RTK:` status line on the run-stats comment (#2385)

## Summary

The per-issue run-stats comment gains one `RTK:` status line, directly beneath
the `CodeGraph:` line and above the cumulative issue total, so the RTK output
trial (#2328) can separate enabled runs from control runs by reading the
comment alone. Part of #2385 — see **Deliberately deferred** below for what
remains before it closes.

```text
- **RTK:** ok — 12,340 tokens saved
- **RTK:** ok
- **RTK:** failed
- **RTK:** off
- **RTK:** unsupported (gemini)
```

- `worker/deno/lib/issue_run_stats_comment.ts` — `RTK_STATS_PREFIX` and
  `buildRtkStatsLine(rtk)`, both exported so the trial page's drift test can
  pin the rendered shapes. Only `ok` carries a figure (the `rtk gain` delta,
  with a thousands separator, `0` included); an `ok` whose delta could not be
  read renders the bare status. `unsupported` names `rtk.provider`, and renders
  bare when the run resolved none. `buildIssueRunStatsComment` and
  `postIssueRunStatsComment` accept `rtk?: RtkOutputResult`; omitted, the
  comment is byte-identical to today's. Like the CodeGraph figures, the status
  is left out of the "is there anything to report?" probe — it never makes a
  stats-free run worth a comment.
- `worker/deno/lib/phase_run_stats.ts` — `reportPhaseDegradation` accepts `rtk`
  and forwards it on both the healthy and the degraded comment, exactly as
  `codegraph` is.
- `worker/deno/lib/phases/completion_phase.ts` and
  `worker/deno/lib/phases/handle_no_changes_phase.ts` — the issue path's two
  stats post calls pass `state.rtkOutput` (#2383). The execute phase sets that
  field on every run, `off` included, so an issue run on a host without the
  switch still reports `- **RTK:** off`. (The issue text points at
  `issue_worker.ts` ~L227; that line feeds the callback context, which is
  #2386's. The stats post calls live in these two phases, so
  `issue_worker.ts` is untouched here.)
- `docs/CONFIGURATION.md`, `docs/REPO-CONTEXT-TRIAL.md` — the RTK row and the
  run-stats section describe the line, its position and its shapes.

It is a status line, never a cost line: it sits outside the `Estimated cost`
shape the issue tally parses, so the saved-token figure can never be read as
spend.

### Deliberately deferred

The planning, question, PR-feedback and CI-fix processors do **not** pass an
RTK result to their stats calls in this PR. Those processors only gain an RTK
result with #2384, which is in flight on a sibling branch; wiring them here
would conflict with it. They follow once #2384 has landed:

- `question_processor.ts` — add `rtk` to the existing
  `reportPhaseDegradation({...})` call, beside `codegraph`.
- `planning_processor.ts` — renders its stats section through its own
  `buildRunStats` / `postStatsComment`, not through
  `buildIssueRunStatsComment`, and carries no `CodeGraph:` line today; the
  exported `buildRtkStatsLine` is the piece to append there.
- `pr_feedback_processor.ts`, `pr_ci_processor.ts` — post no run-stats comment
  today, so there is no call to add an argument to; whether they should gain
  one is a question for that follow-up, not a one-line wiring.

## Tests

Written first and seen red (type-level for the new parameters; behaviourally
red under `--no-check` for the five forwarding tests). Each rendering and
forwarding rule was then mutation-checked: swapping the line order, dropping
the thousands separator, letting a non-`ok` status carry a figure, treating `0`
as absent, giving the line a cost shape, and removing each of the five
forwarding spreads each failed the test named for it and nothing unexpected.

- `worker/deno/tests/issue_run_stats_comment_test.ts` — the prefix; each
  status; thousands separator, sub-thousand and zero figures; `ok` without a
  figure; `unsupported` with and without a provider; a figure or provider on
  the wrong status is ignored; the line sits directly beneath `CodeGraph:` and
  directly above the issue total; the cost tally and cumulative total are
  unchanged by it, and a cost-less run carrying only the RTK line tallies as
  `partial`, never as spend; `rtk` absent is byte-identical; adding the line
  changes no other line; `postIssueRunStatsComment` posts exactly one line,
  posts `off`, and posts nothing for a status with no stats.
- `worker/deno/tests/phase_run_stats_test.ts` — healthy forwarding, degraded
  forwarding, and no mention when no status is given.
- `worker/deno/tests/completion_phase_run_stats_test.ts`,
  `worker/deno/tests/handle_no_changes_phase_test.ts` — both issue-path
  wrap-ups report `state.rtkOutput`; a run that never reached the preparation
  mentions none.

### The deferred remainder, completed

The first PR for this issue (#2414) wired the issue path only, because #2384 —
which carries each processor's RTK result — was being built in parallel. With
#2384 landed, the remainder is done here:

- **Question** — `question_processor.ts` passes `carrier.rtkOutput` into the
  same `reportPhaseDegradation` call that already carries the CodeGraph
  figures. Pinned by `question_processor - the round's run-stats comment carries
  the RTK line` and its switched-off twin (`RTK: off`, never nothing).
- **Planning** — planning builds its own stats section, which carried no
  accelerator line at all, so `buildRunStats` takes the round's result and
  appends `buildRtkStatsLine`. On the **failure path too**: a publish turn that
  times out still posts stats, and they carry the line
  (`planning_processor - a round that fails still reports RTK on the stats it
  posts`). A round with nothing else to report stays silent — the line never
  makes a stats-free round worth a comment, the rule the issue path follows.
- **PR-feedback and CI-fix post no run-stats comment at all**, so there is no
  call to extend. Their RTK outcome is on the run's result and in the worker
  log. Adding a stats comment to PR runs is a design decision, not wiring, and
  is not made here — CodeGraph and Graft are absent from those runs for the same
  reason.

Each test above was red before its wiring.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — every posted run-stats comment carries exactly one `RTK:` line,
  including `off` on hosts without the switch — evidence: the builder appends
  one line whenever a result is supplied
  (`worker/deno/lib/issue_run_stats_comment.ts:397-400`), the shared phase
  helper forwards it on the healthy and the degraded comment
  (`worker/deno/lib/phase_run_stats.ts:245,275`), and both issue-path post
  calls pass `state.rtkOutput`
  (`worker/deno/lib/phases/completion_phase.ts:751`,
  `worker/deno/lib/phases/handle_no_changes_phase.ts:248`); pinned by
  `postIssueRunStatsComment - posts exactly one RTK line`, `… posts \`off\` on a
  host without the switch`, `completion - a host with RTK off still reports the
  line`, and the two `reportPhaseDegradation` forwarding tests — reviewer:
  partial — reason: met for every run kind that both is RTK-wired and posts a
  run-stats comment — issue, question and planning (success and failure
  paths). PR-feedback and CI-fix are wired but post no run-stats comment. The
  clarification-family phases (clarity assessment, refinement, revision,
  grill-me, quorum) post stats comments but are not RTK-wired by this
  milestone at all, so they have no outcome to report and carry no line;
  `docs/CONFIGURATION.md` now says so rather than claiming every spawn path
- **met** — `ok` renders the `rtk gain` delta with a thousands separator when
  present, and the bare status when absent — evidence:
  `worker/deno/lib/issue_run_stats_comment.ts:198-200`; pinned by `rtk line -
  ok reports the saved tokens with a thousands separator`, `… ok with a zero
  delta still reports the figure` and `… ok with no saved-token figure reports
  the status alone` — reviewer: met
- **met** — `unsupported` names the provider — evidence:
  `worker/deno/lib/issue_run_stats_comment.ts:193-197`; pinned by `rtk line -
  unsupported names the provider` (two providers, so the name is shown to come
  from the result) and `… unsupported with no resolved provider reports the
  status alone` — reviewer: met
- **met** — the cumulative issue cost total is unaffected by the line —
  evidence: `RTK_STATS_PREFIX` sits outside `ESTIMATED_COST_PATTERN`
  (`worker/deno/lib/issue_run_stats_comment.ts:175,208`); pinned by `rtk line -
  the cost tally and total line ignore it`, which a cost-shaped mutation of the
  prefix fails — reviewer: met
- **met** — quality gate passes — evidence: `deno fmt --check`, `deno lint` and
  `deno check` clean on every changed `.ts` file; the four touched suites, the
  parallel-safety cap and the docs suites pass locally; CI runs the full gate —
  reviewer: met
