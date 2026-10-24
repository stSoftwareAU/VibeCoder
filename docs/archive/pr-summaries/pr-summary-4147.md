# Prevent false human holds on approved work

## Summary

Refs #4147 and #4227. An agent can exit zero while reporting a structured
failure, an unfinished stream or zero model turns. Both execution paths now
check that metadata through `emptyRunFailureReason`. The fleet treats these
as interrupted runs, retries on a fresh session and does not hand the failed
conversation to the next issue. Recoverable changes, commits and PRs still
proceed to completion. Providers without structured metadata retain their
exit-code behaviour.

Merged PRs that explicitly mark acceptance criteria missing leave the original
issue queued with its existing labels. Both closers stop applying `needs-human`,
and cached and uncached PR lookup stop treating an incomplete merge as finished
work. Open PRs and the cooldown for closed, unmerged attempts still prevent
duplicate work.

Acceptance statuses must lead their assessment entry. Ordinary test prose
mentioning a "missing or unreadable value" no longer marks a criterion missing.

The fleet also continues when the clarity heuristic only reports `too_complex`.
Six explicit requirements without code paths no longer generate a question
asking a human to choose a breakdown. Genuine vague instructions still request
clarification, and the implementing agent can request planning when needed.

## Spec

### Intent and Rationale

A failed invocation does not show that an issue needs a human. A partial merge
also does not finish the original approved assignment. These remaining paths
must follow the assigned-issue completion rule in `DESIGN-PRINCIPLES.md`.

### Essential Design Decisions

- Extend #4226's interrupted-run and fresh-session behaviour to structured
  failures with exit zero, using the same check as the standalone command.
- Read matched merged PR bodies live on the cached lookup path. The existing
  persisted cache shape and keys do not change.
- Keep the missing-criterion close guard, but remove its label/comment mutation.
  Missing criteria remain visible in logs and the lifecycle result.

### Undiscoverable Facts

A private fleet repository's comments and label events showed a prose-only
criterion being read as missing, and incomplete merges repeatedly parking
issues whose discovery labels had already been restored.

## Evidence

- Both execution paths failed the structured error, zero-turn and unfinished
  stream regressions with exit zero before the shared check.
- After integration with #4226, three stream regressions still failed: those
  exit-zero results handed a usable session to the next issue. All now pass.
  Forcing stream publication on and off each makes the corresponding negative
  or positive regression fail.
- Both real merged-PR closers originally applied `needs-human`; cached and
  uncached PR lookup suppressed incomplete work. Their regressions now assert
  preserved labels, no hand-off comment and continued eligibility.
- The prose-status regression failed in both the parser and a real closer
  before the fix. Related parser, PR-body and closure tests passed 105 cases.
- The final integrated clarity, execution, stream, closure, parser and
  provider-routing run passed 368 tests.
  Thirteen earlier deliberate guard/operand mutations each produced assertion
  failures in an isolated checkout.
- Full validation exposed existing fixture problems: a missing-file watcher
  starved pending lock I/O, a startup fixture invoked host package updates,
  and `deno eval` fixtures supplied unsupported permission flags. The watcher
  now yields and stops in `finally`; startup disables updates; eval uses its
  implicit permissions. Existing behavioural assertions are retained.
- Seven Git fixture suites still exceeded the per-file timing gate with one
  worker. Their setup now uses `fast-import` to build the same commit graphs,
  subjects and file changes, and configures clone identities at clone time.
  All 30 existing tests pass within the unchanged one-second limit. The tested
  merge, rebase, push and recovery operations still use real Git.
- The six-requirement clarity regression failed before the fix and passes
  afterwards. Forcing the condition true fails the vague-instruction case;
  scope alone causes no comment, label mutation or claim release.
- No UI changed; screenshots are not applicable.

**Docs sweep** — grep: `holdIssueOpenForMissingCriteria`,
`buildMissingCriteriaHoldComment`, `missing_criterion_close_guard`,
`A crashed run is never analysis-only`, `statusOf`, `too_complex`; section:
`docs/workflows/issue-processing.md#-acceptance-criteria-closure-before-the-pr`;
siblings: `runExecuteClaudePhase`, `workOnIssueExecuteClaude`,
`ensureIssueClosedIfPrMerged`, `closeIssuesForMergedPrs`,
`workOnIssueClarityPhase`, `runClarityPhase`; updated:
`docs/workflows/issue-processing.md`, `docs/workflows/planning-and-questions.md`,
`docs/INTERNALS.md` and affected module comments. The standalone clarity
command retains its separate planning pre-check. The integration preserves #4226's compaction fix and #4227's general
no-PR retry behaviour.

## Test Plan

- Clarity tests drive the real fleet phase with six plain-language requirements
  and assert no GitHub mutations. A vague six-item issue still posts questions,
  adds `needs-human` and releases its claim. Existing clear-issue, label-routing
  and maximum-round tests remain.

- Execution tests drive both real phases, the bounded retry, clean results,
  stream persistence and recovery of uncommitted, local, remote and PR work.
  Fixtures use production `CLAUDE_OUTPUT_ADAPTER.decode` and `buildRunStats`,
  matching metadata produced by the real runner.
- Closure tests drive both real closers, repeated sweeps, existing human holds,
  cached and uncached lookup, precheck and superseding-PR classification.
  All-met closure and open/recently-closed duplicate prevention remain covered.
  GitHub fixtures preserve `mergedAt` on merged rows in closed-list responses.
- Parser callers also include claim freshness, unmet criteria, closure-met
  checks and degraded delivery. Their explicit leading-status fixtures retain
  their meaning.
- Assertions expecting an automatic human hold are replaced by no-label and
  no-comment assertions, as required by the operator's request. The removed
  `buildMissingCriteriaHoldComment` test described the deleted hand-off API;
  missing-criterion details are now asserted in logs and the lifecycle reason.
- Existing terminal-reconciliation tests are preserved from current main,
  including its crash retry counts and infrastructure-failure accounting.
- Git fixture changes retain every test and assertion. The shared helper
  prepares only history and clones; the sibling-sync fixture also clones its
  two independent checkouts concurrently and stages its tracked resolution
  with `commit -am`. No timing budget, exemption or test membership changes.

<!-- vibe-branch-outcomes -->

## Merge verification

The earlier execution and closure changes passed the complete local quality
gate with one test worker and sequential checks: both unit passes, timing limits, lint, type checking, formatting,
Markdown, Semgrep and repository policy checks. Config integration and Checkov
were skipped because their local prerequisites are absent. Required CI and the
repository's approving review must pass before merge; local skips do not
replace required CI checks.

Final clarity and main-integration validation is pending.
