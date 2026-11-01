# Fleet PR babysitter: file shift-left issues for repeated CI failures

## Summary

Closes #4610

A fleet PR that fails CI costs a full CI run plus a second agent session to
repair it. The fleet's Macs are already paid for; GitHub Actions minutes are
not. From 2026-10-25 there were 127 failed PR CI runs across four
repositories, and the same steps kept failing: Deno test shards (~55),
`cargo clippy` (12), `cargo mutants` (12), coverage floors (12) and PR summary
freshness (8). The example that started this was a clippy
`indexing_slicing` failure introduced by a babysitter repair commit. That
commit was pushed without running the repository's `quality.sh`, which runs
the same clippy command.

This PR makes two changes.

1. **Detection (`lib/shift_left_failures.ts`).** Each babysitter pass reads
   the PR workflow runs that have failed since its last scan. It records one
   observation per failed job of a fleet PR whose failed step runs a
   recognised local tool, provided the CI failure classifier calls it a code
   fault. When the same check and step fail on 3 or more distinct fleet PRs
   within 7 days, the babysitter files one `idle-task` issue in the repository
   that owns the fix:
   - **VibeCoder** when the babysitter pushed most of the failing heads, or
     when the repository's `quality.sh` already runs the tool.
   - **VibeCoder, once,** when CI runs the tool but no local gate does, in two
     or more repositories (a fleet-wide gap).
   - **That repository** when only its own local gate lacks the tool.
2. **Repairs verify locally.** The babysitter's repair prompt is now
   `buildRepairPrompt`. A CI repair reproduces the failing step with the
   command the workflow runs and confirms it passes before reporting ready.
   Review and conflict repairs run the formatter, linter and type or compile
   check for the code they touched.

No check is weakened: the same checks run earlier, and CI stays as the
backstop.

## Spec

### Intent and Rationale

- Catch on the Mac, before a PR is raised or a fix pushed, what CI would
  otherwise reject, saving a CI run and a repair session each time.
- Generic gaps belong in VibeCoder; repository-specific gaps belong in that
  repository, so each issue reaches the place that can fix it.

### Essential Design Decisions

- A job counts only when its step names a recognised local tool and
  `classifyCiFailure` calls it `code-fix-required` or
  `history-rewrite-required`. Aggregator, deployment-state, infrastructure and
  timing failures never count, so no issue asks for a local check that cannot
  exist.
- Dedup uses a body marker keyed by a hash of the repository, check and step,
  and a match counts only when a fleet account wrote it
  (`selectFleetAuthoredMatches`), so a planted marker cannot silence the
  detector. The search uses the REST API because it reports App authors as
  `name[bot]`, the form the fleet configuration lists.
- `idle-task` is the work label the worker may apply itself; `work-on` stays
  human-only.
- Each pass inspects at most 40 failed runs per repository and remembers the
  runs it has scanned, so the first pass on a busy repository does not hold
  repairs up for a week's backlog.

### Undiscoverable Facts

- GitHub often leaves a workflow run's `pull_requests` empty, so runs are
  matched to PRs by head branch.
- Newer `gh` refuses to print job logs that carry terminal escapes unless
  `--allow-escape-sequences` is passed, and older `gh` rejects the flag. The
  flag is therefore passed only after that refusal.
- A babysitter repair commit introduced the clippy failure in the reported
  example; `quality.sh` in that repository runs the identical command.

## Evidence

Manual read: `docs/workflows/fleet-pr-babysitter.md` (updated with a
"Shift-left detection" section). Visual evidence is not applicable; this is a
background service with no UI.

- `tests/shift_left_failures_test.ts`: 22 tests. Each scan behaviour was
  written first and seen failing: routing, generic grouping, the `idle-task`
  label, author-verified markers, branch-matched runs, a missing log skipped,
  the escape-refusal retry, and the per-pass cap with resume.
- `tests/fleet_pr_babysitter_test.ts`: three prompt tests, which failed before
  `buildRepairPrompt` existed.
- `deno task check:manifests`: passed. It first caught a missing sweep slice,
  level words in log text, an unverified marker author and an undeclared
  `VIBE_SHIFT_LEFT` name; all four are fixed.
- Related suites (babysitter, App, env registry, log-level lint, marker
  author cap, sweep coverage): 116 passed, 0 failed.

## Test Plan

- New: `worker/deno/tests/shift_left_failures_test.ts`.
- Extended: `worker/deno/tests/fleet_pr_babysitter_test.ts` (repair prompt).
- Wide suite: CI.

## Merge verification

- CI: not yet verified (pending on this PR).
