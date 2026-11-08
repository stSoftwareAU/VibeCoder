## Summary

The babysitter repair prompt identifies the PR's archived summary from its issue
branch and explains that summaries brought in by a base merge belong to their
original PRs. Branches without an issue number get generic guidance. Closes
#4775.

## Spec

### Intent and Rationale

- Naming the repair PR's summary prevents edits to another PR's record after a
  base merge.

### Essential Design Decisions

- Use `issueNumberFromBranch`; a `null` result omits a specific filename.
- Keep the instruction to rewrite stale claims, counts and results in the same
  repair.
- Inject the HOME lookup in the repair test while production reads the process
  environment. An absent HOME still prevents the agent from starting.

### Undiscoverable Facts

- The 14-day review-log observation is post-merge verification and has not run.

## Evidence

- This is a backend prompt, test and documentation change; no visual surface,
  dependency or lockfile changed.
- The repair-flow description in `docs/workflows/fleet-pr-babysitter.md` was
  updated; the summary rules in `CODING-STANDARDS.md` remain consistent.
- The old test mutated process-wide HOME; that mechanism is obsolete because it
  violates parallel safety. The missing-HOME refusal and no-agent-start behaviour
  remain covered by
  `worker/deno/tests/fleet_pr_babysitter_test.ts::repair caller passes the issue number parsed from the PR branch`,
  using an injected lookup. The parallel-safety gate covers the absence of new
  process-state mutation.
- No rule copies needed changing for the HOME lookup. The prompt tests cover the
  issue and no-issue paths; existing merged-base and unmerged prompt assertions
  remain in `worker/deno/tests/fleet_pr_babysitter_single_push_test.ts`.

## Test Plan

- `deno task test:unit tests/parallel_safety_cap_test.ts tests/fleet_pr_babysitter_test.ts tests/fleet_pr_babysitter_single_push_test.ts`
  — 136 passed. Before the fix the parallel-safety test failed on the HOME
  mutation.
- The prompt tests failed against the previous wording; removing the caller's
  issue-number argument made the caller test fail. Disabling the HOME guard made
  that test reach the agent instead of reporting `HOME is not set`.
- The CI shard command `.github/scripts/deno-test-shard.sh 3 4` could not start
  on the sandboxed macOS host: `mktemp -t` attempted a denied system temporary
  path. CI runs the shard on the pushed head.
- `./quality.sh` passed formatting, lint, type checking, markdownlint and the
  other completed checks, but its parallel Deno suite panicked in host Deno
  2.9.0; the repository pins 2.9.8. Config integration, Semgrep and Checkov were
  skipped because their local prerequisites were unavailable. Mermaid initially
  failed while this summary was being rewritten; a subsequent `check-mermaid`
  run passed after the file was restored.
- `deno task pr-summary-check --base origin/main` passed the applicable gates;
  three gates were not checked without an issue body or labels.
- The 14-day review-log observation remains post-merge work.
