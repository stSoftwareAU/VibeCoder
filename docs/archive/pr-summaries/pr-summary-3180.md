## Summary

`Claude health check failed — skipping cycle` now says why. On GRQ-23 the
root filesystem went read-only and for 25+ minutes the log held only that
line; the operator had to `container exec` in and read `dmesg`. Closes #3180.

The issue's logged lines, reproduced:

```
INFO: Running Claude Code health check (30s timeout)...
INFO: Running Claude Code with 30s timeout (5s grace period)...
ERROR: Claude health check failed — skipping cycle
```

Three places dropped the cause:

- `checkClaudeHealth` (`worker/deno/lib/claude_runner.ts`) returned
  `Health check error: …` on the pre-spawn failure path (`!result.ok`) without
  logging it. It now logs `<agent> health check could not run: Health check
  error: …` at ERROR, and takes an injectable `runner` (test seam, defaulting
  to `runClaudeWithTimeout`).
- The production `checkClaudeHealth` dep (`run_core_production_deps.ts`)
  returned only `{ healthy, exitCode }`, discarding the probe's message. It now
  carries `message`, and takes an injectable `agentHealthCheck` option.
- `run_core.ts` logged the bare skip-cycle line. The new
  `describeHealthCheckFailure()` turns a failed `Result` into its error, an
  unhealthy value into its message (or `exit N, no reason reported`), and that
  reason now ends the skip-cycle line, the usage-window pause line (#2119) and
  the unhealthy-fallback-alternative line (#2055). Example:
  `ERROR: Claude health check failed — skipping cycle: Health check error:
  Read-only file system (os error 30) …`.

`docs/TROUBLESHOOTING.md` gains a section on reading the skip-cycle line.

## Evidence

No UI. Logged lines are asserted in tests (below).

**Docs sweep** — grep: "health check failed", "skipping cycle", "health
check"; section: `docs/TROUBLESHOOTING.md` (new "`Claude health check failed —
skipping cycle`" section, before "Circuit breaker activated"); checked, no
change needed: `docs/workflows/resilience-and-concurrency.md` (health-check
caching, unchanged).

**Changed call sites, each with a test that goes red without it:**

- `checkClaudeHealth` pre-spawn log line → `claude_runner_test.ts` "a runner
  that fails before spawning logs the underlying error".
- production dep `message` passthrough → `run_core_production_deps_test.ts`
  "an unhealthy probe carries its message to the loop".
- skip-cycle line → `run_core_test.ts` (three #3180 skip-cycle tests).
- fallback-alternative line and usage-window pause line →
  `run_core_test.ts` "an unhealthy fallback alternative and the usage-window
  pause name their cause" (each reverted separately; red both times).

**`describeHealthCheckFailure` outcomes** (failed Result, message, blank
message with exit code, no message and no exit code) are each asserted in
`run_core_test.ts` "describeHealthCheckFailure - names the cause for every
failure shape".

## Test Plan

- Red first: the new tests were added before the fix and failed against the
  base code (`FAILED | 0 passed | 3 failed` for the run_core skip-cycle tests,
  e.g. `Expected actual: "Claude health check failed — skipping cycle" to
  contain: "skipping cycle: Health check error: Read-only file system (os error
  30)"`). The claude_runner test's base-branch red came only from the missing
  `runner` seam, so its proof is the revert check below, which keeps the seam
  and drops only the log line.
- Revert check: with the log line, the `message` passthrough and the
  fallback-line reason removed, `FAILED | 4 passed | 3 failed` (filter `3180`);
  with the pause-line reason removed alone, `FAILED | 0 passed | 1 failed`.
- `tests/claude_runner_test.ts` + `tests/run_core_production_deps_test.ts`:
  `ok | 74 passed | 0 failed`.
- `tests/run_core_test.ts`: `ok | 76 passed | 0 failed | 1 ignored`. The
  ignored one is "an unavailable tier adapts in place and the cycle continues
  (Issue #2059)", which never finishes in this sandbox on unmodified
  `origin/main` as well (it was skipped only for this local run, not in the
  committed file).
- `deno fmt --check`, `deno lint`, `deno check` on the touched files: clean.
- `./quality.sh` (local sandbox, eight agents sharing the container's
  memory): every static check passed (benchmark audit, chokepoints, workflow
  hygiene, source targets, release-tag ruleset, mermaid, deno fmt, deno lint);
  markdownlint, semgrep and config integration were skipped (tools absent).
  The full parallel test pass, the whole-repo type check and the completeness
  step's test run failed under memory pressure without naming a test. Run on
  their own: `deno task check` (all `**/*.ts`) clean; `deno task
  check:manifests` `ok | 687 passed | 0 failed | 1 ignored`; the 212 test files
  that mention run_core, claude_runner, the production deps, TROUBLESHOOTING or
  PR summaries `FAILED | 2777 passed | 1 failed`. The one failure is `loop.sh
  #399 - killing the supervisor leaves no orphaned descendants`, a
  process-signal test this change does not touch. CI is the full-suite check.
- No existing test was edited.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
