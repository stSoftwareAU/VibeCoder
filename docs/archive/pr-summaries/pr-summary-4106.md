# Milestone health reports a failed list as a failed repo (Issue #4106)

## Summary

Closes #4106.

`milestone-health` turned a failed gh list call into an empty, successful
report. A repo whose milestone list, closed issue list or open issue list
failed was shown as `No active milestones` or `Complete — all issues closed`,
and the command exited success.

Now a failed milestone listing or a failed closed or open issue list marks the
repo as failed. The repo result carries `error`, the formatted report shows
`Failed to read milestones: …`, and the command returns `success: false` naming
the failed repo. A healthy repo is reported as before.

## Spec

### Intent and Rationale

An operator reading the milestone-health report has to be able to trust
`Complete` and `No active milestones`. Both were printed for a repo whose data
had never been read, so a broken milestone looked healthy. The report now says
a list could not be read, and the command fails, so an unreadable repo is never
mistaken for a clean one.

### Essential Design Decisions

- A failed milestone listing or closed or open issue list returns
  `{ repo, milestones: [], error }` from `getMilestoneHealth`. The formatter
  prints `Failed to read milestones: …` for that repo and skips its milestone
  loop.
- The whole repo fails rather than one milestone, because both issue batches
  are repo-wide.
- `buildMilestoneHealthCommandResult` fails the command when any repo has
  `error`, and keeps the formatted report in `message`, so the operator sees
  which repo failed and why.
- `milestone_progress.ts` is unchanged. Its caller of
  `fetchClosedIssuesByMilestone` already wraps the call in try/catch and
  returns a failed Result.

### Undiscoverable Facts

- On base, `fetchAllIssues` (#4257) and `fetchAllClosedIssues` (#4124) already
  throw on gh failure, so the issue's claim that the closed fetch returns `[]`
  is stale. The only defect was the catch blocks in `milestone_health.ts`.
- The whole repo is failed rather than per-milestone, because both batches are
  repo-wide.
- A repo whose default branch fails is still skipped as before. This is
  unchanged and out of scope.
- The stale doc sentence on `fetchClosedIssuesByMilestoneNumber` was corrected.

## Evidence

Backend and CLI only; there is no UI change.

**Docs sweep** — grep: `No active milestones`, `milestone-health`, `Continue with empty list`, `swallows gh`; section: `docs/INTERNALS.md#-milestone-health-diagnostics` (the heading is "### 🏥 Milestone health diagnostics"); siblings: `milestones`, `repo`; updated: `docs/INTERNALS.md`.

Greps were run from the repo root over `*.md`, `*.ts` and `*.json`. Hits in
`docs/archive/` are excluded. Remaining hits:

- `No active milestones`:
  - `worker/deno/lib/milestone_health.ts:679`: still true, it is the healthy empty-repo branch with no `error`.
  - `worker/deno/lib/milestone_health.ts:592` and `:658`: doc comments stating the new rule, still true.
  - `worker/deno/tests/milestone_health_test.ts:463`: still true, the "no milestones" formatter case.
  - `worker/deno/tests/milestone_health_test.ts:947`, `:966`, `:984`, `:1022`: assert the phrase is absent for failed repos, still true.
  - `worker/deno/tests/milestone_health_command_test.ts:39` and `:102`: assert the phrase for a clean report and a healthy empty repo, still true.
- `milestone-health`: still true, it names the command, the GraphQL source label, a comment or a temp prefix:
  - `worker/deno/commands/milestone_health.ts:10`, `:86`; `worker/deno/mod.ts:622`, `:754`.
  - `worker/deno/lib/milestone_health.ts:264`, `:265`; `worker/deno/lib/gh_call_metrics.ts:235`, `:708`.
  - `worker/deno/lib/issue_query.ts:591`, `:949`, `:973`.
  - `worker/deno/tests/gh_call_metrics_test.ts:421`, `:428`, `:480`, `:494`; `worker/deno/tests/run_core_test.ts:2711`, `:2712`, `:2744`.
  - `worker/deno/tests/milestone_health_cache_test.ts:40`, `:52`; `worker/deno/tests/milestone_health_test.ts:35`; `worker/deno/tests/milestone_health_command_test.ts:2`.
  - `docs/INTERNALS.md:3980`: still true, the command description. `docs/INTERNALS.md:3986` was updated for this change.
- `Continue with empty list`: no hits outside `docs/archive/`.
- `swallows gh`: one hit outside `docs/archive/`, `worker/deno/tests/crash_notification_test.ts:462`, a crash-notification test name unrelated to milestone health, still true.

Test run, with `VIBE_IMAGE_AGENT_PROVIDERS` unset:

```text
$ deno test --allow-all tests/milestone_health_test.ts tests/milestone_health_command_test.ts < /dev/null
ok | 41 passed | 0 failed (123ms)
```

## Test Plan

Tests added or modified in `worker/deno/tests/milestone_health_test.ts`:

- `getMilestoneHealth - failed milestone list transport marks the repo as failed (Issue #4106)`: modified, replaces the #3856 test of the same transport.
- `getMilestoneHealth - failed open issue list marks the repo as failed, not complete (Issue #4106)`: added.
- `getMilestoneHealth - failed closed issue list marks the repo as failed, not complete (Issue #4106)`: added.
- `getMilestoneHealth - non-JSON closed issue list marks the repo as failed, not complete (Issue #4106)`: added.
- `getMilestoneHealth - healthy empty milestone reports complete with no error (Issue #4106)`: added, positive control.
- `formatMilestoneHealthReport - a repo with an error prints the failure, not no milestones (Issue #4106)`: added.
- `getMilestoneHealth - a failing repo is reported with error while a healthy repo is reported normally (Issue #4106)`: added.

Also added in `worker/deno/tests/milestone_health_test.ts`, to pin the exact error text, the repo name and the report layout:

- `getMilestoneHealth - a failed milestone list names the repo and keeps the thrown text (Issue #4106)`
- `getMilestoneHealth - a failed closed list names the repo and keeps the thrown text (Issue #4106)`
- `getMilestoneHealth - a failed open list names the repo and keeps the thrown text (Issue #4106)`
- `formatMilestoneHealthReport - a failed repo is followed by a blank line before the next repo (Issue #4106)`

Tests added in `worker/deno/tests/milestone_health_command_test.ts` (new file):

- `buildMilestoneHealthCommandResult - clean report succeeds with the formatted text (Issue #4106)`
- `buildMilestoneHealthCommandResult - a repo with an error fails and names the failure (Issue #4106)`
- `buildMilestoneHealthCommandResult - a mixed report with one errored repo fails (Issue #4106)`
- `runMilestoneHealth - a failed milestone list fails the command (Issue #4106)`
- `runMilestoneHealth - an empty healthy repo succeeds with the report (Issue #4106)`
- `runMilestoneHealth - no configured repos succeeds with an empty report (Issue #4106)`
- `runMilestoneHealth - a malformed gh response fails the command with its message (Issue #4106)`
- `runMilestoneHealth - the default-branch cache path is passed through (Issue #4106)`
- `milestoneHealthCommand.execute - delegates to runMilestoneHealth (Issue #4106)`

`runMilestoneHealth(config, deps)` is a new exported function in `worker/deno/commands/milestone_health.ts`. `execute` delegates to it, so a test can inject a fake gh and a throwaway default-branch cache path.

- Removed from `worker/deno/tests/milestone_health_test.ts`: `assertEquals(result.value.repos.length, 1);`
  Required by: "Update the test 'failed milestone list transport still gives an empty repo (Issue #3856)'"
  Replaced by: `assertEquals(result.value.repos.length, 1);`
- Removed from `worker/deno/tests/milestone_health_test.ts`: `assertEquals(result.value.repos[0]!.milestones.length, 0);`
  Required by: "Update the test 'failed milestone list transport still gives an empty repo (Issue #3856)'"
  Replaced by: `assertEquals(repo.milestones.length, 0);`, `assertStringIncludes(repo.error ?? "", "HTTP 500");`

The two assertions are kept, now unconditional after `if (!result.ok) throw new Error("unreachable");` instead of inside `if (result.ok) {`, and the test also asserts the repo `error`.

Red checks, one flip at a time on the head. Each flip was restored with `git checkout` and `git diff --stat` was checked empty. Baseline was `ok | 35 passed | 0 failed`.

- Milestone-list catch (`worker/deno/lib/milestone_health.ts:462`) returns `{ repo, milestones: [] }`: red is `getMilestoneHealth - failed milestone list transport marks the repo as failed (Issue #4106)` (`milestone_health_test.ts:866`).
- Closed-list catch (`:505`) swallowed: red is `getMilestoneHealth - failed closed issue list marks the repo as failed, not complete (Issue #4106)` (`:950`) and `getMilestoneHealth - non-JSON closed issue list marks the repo as failed, not complete (Issue #4106)` (`:969`).
- Open-list catch (`:526`) swallowed: red is `getMilestoneHealth - failed open issue list marks the repo as failed, not complete (Issue #4106)` (`:931`) and `getMilestoneHealth - a failing repo is reported with error while a healthy repo is reported normally (Issue #4106)` (`:1025`).
- Formatter error branch (`:672`) deleted: red is seven tests: `buildMilestoneHealthCommandResult - a repo with an error fails and names the failure (Issue #4106)`, `buildMilestoneHealthCommandResult - a mixed report with one errored repo fails (Issue #4106)`, `formatMilestoneHealthReport - a repo with an error prints the failure, not no milestones (Issue #4106)`, `getMilestoneHealth - a failing repo is reported with error while a healthy repo is reported normally (Issue #4106)`, `getMilestoneHealth - failed open issue list marks the repo as failed, not complete (Issue #4106)`, `getMilestoneHealth - failed closed issue list marks the repo as failed, not complete (Issue #4106)`, `getMilestoneHealth - non-JSON closed issue list marks the repo as failed, not complete (Issue #4106)`.
- Command `failed.length > 0` (`worker/deno/commands/milestone_health.ts:37`) forced to the success path: red is `buildMilestoneHealthCommandResult - a repo with an error fails and names the failure (Issue #4106)` (`milestone_health_command_test.ts:37`) and `buildMilestoneHealthCommandResult - a mixed report with one errored repo fails (Issue #4106)` (`:45`).
- Command failure branch forced on a clean report (`failed.length >= 0`): red is `buildMilestoneHealthCommandResult - clean report succeeds with the formatted text (Issue #4106)` (`milestone_health_command_test.ts:29`).

Mutation survivors from the gate, each now red (run with `--no-check` so a type error does not count):

- `commands/milestone_health.ts:49` (`data: report` deleted on success): red is the clean-report command test, which now asserts `result.data`.
- `commands/milestone_health.ts:80` (`return buildMilestoneHealthCommandResult(...)` replaced): red is the two `runMilestoneHealth` tests.
- `commands/milestone_health.ts:66`, `:67`, `:68` (no-repos result `success`, `message`, `data`): red is `runMilestoneHealth - no configured repos succeeds with an empty report (Issue #4106)`, which asserts all three.
- `commands/milestone_health.ts:75` (`defaultBranchCachePath` deleted): red is `runMilestoneHealth - the default-branch cache path is passed through (Issue #4106)`, which reads the cache file back from the injected path.
- `commands/milestone_health.ts:79` (`success: false` swapped, or the return replaced with undefined): red is `runMilestoneHealth - a malformed gh response fails the command with its message (Issue #4106)`.
- `commands/milestone_health.ts:94` (`execute` return replaced with undefined): red is `milestoneHealthCommand.execute - delegates to runMilestoneHealth (Issue #4106)`.
- `lib/milestone_health.ts:463`, `:506`, `:528` (`repo` deleted from the milestone, closed and open error returns): red is the three "names the repo and keeps the thrown text" tests.
- `lib/milestone_health.ts:466`, `:509`, `:530` (negated `e instanceof Error` ternary): red is the same three tests, which compare the exact text for an `Error` and for a thrown string.
- `lib/milestone_health.ts:674` (`lines.push("")` deleted in the formatter error branch): red is the blank-line formatter test.

Quality gate: `./quality.sh` ran on the head. All stages passed except `deno tests`, whose parallel pass failed 14 tests, none touching milestone code. Six are `claude_runner_provider_fallback_4034`/`codex_model_adaptation` tests, and six more fail with 'running container image did not install the "codex" coding-agent provider' because this sandbox exports `VIBE_IMAGE_AGENT_PROVIDERS=claude`. Two Rust-fmt tests in `completion_phase_repo_formatters_test.ts` fail on base too. The serial pass was NOT RUN. Config integration and checkov were SKIPPED. The touched milestone and issue_query tests (169) pass with the env var unset.

<!-- vibe-branch-outcomes -->

## Not done / risks

- A repo whose default branch fails is still skipped, as before. This is unchanged and out of scope.
- Per-milestone partial reports are intentionally not offered. A failed repo-wide batch fails the whole repo.
- A real gh rate-limit is not exercised. The tests use fakes only.
