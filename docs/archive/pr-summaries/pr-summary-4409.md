## Summary

The review-fleet-prs runner reported `worker container plan failed: container-launch-plan: host disk 77.2 GB free of 460.4 GB at /Users/nigel` for 12+ passes. That line is not the cause: it is an informational note `container-launch-plan` writes to stderr on every launch (`worker/deno/commands/container_launch_plan.ts`), and 77 GB free is above the 20 GB / 10 % claim floors, so the disk was never refused. The command prints its real failure message with `console.log` (stdout, `worker/deno/mod.ts` `outputResult`), but `scripts/run.sh` sent stdout to `/dev/null` and quoted only the last stderr line. The runner therefore always blamed the last informational line and hid the actual fault.

`round_container` in `.claude/skills/review-fleet-prs/scripts/run.sh` now captures the plan command's stdout, logs it, and uses its first non-blank line as the failure reason, falling back to the last stderr line when stdout is empty. Closes #4409.

## Spec

### Intent and Rationale

- The reported "host disk" text was misleading; fixing the reason so the tracker names the real cause is what lets the actual fault on GRQ-25 be found and fixed.
- The fix is in the runner script, not the worker command, because the worker command already reports its cause correctly on stdout.

### Essential Design Decisions

- The cause is the **first** non-blank stdout line (the command's failure message), not the last, since later lines are advice and stderr's last line is often an informational note.
- The real fault on GRQ-25 is not observable from this checkout (the log is on that host); this change makes the next tracker comment name it. The healthy 77 GB reading is not treated as a fault.

### Undiscoverable Facts

- The runner log `/Users/nigel/logs/review-fleet-prs/runner.log` is only on the GRQ-25 host and was not available.

## Evidence

Backend/shell change, no UI. Tests:

- Red against the unfixed `run.sh`: the new stdout test failed with the escalated error `worker container plan failed: container-launch-plan: host disk 77.2 GB free of 460.4 GB at /home/x`.
- Green after the fix: `deno task test tests/review_fleet_prs_runner_test.ts` (from `worker/deno`): 51 passed, 0 failed. (`test:unit` skips this file, which is on the integration manifest.)
- `shellcheck` on `run.sh` clean; `deno fmt --check` clean.

## Test Plan

- `worker/deno/tests/review_fleet_prs_runner_test.ts`: added `run.sh names the plan's cause from its stdout, not its informational stderr line (Issue #4409)` and `run.sh names the plan's stderr last line when its stdout is empty (Issue #4409)`; added a `no-plan-stdout` stub mode. Stub's plan case pattern narrowed to `*"mod.ts container-launch-plan"*` because the old pattern also matched the escalate call, whose error text contains `container-launch-plan:`.
- Red check: replacing `cause=$(first_line "$outfile")` with `cause=""` turned the stdout test red (shows `host disk`); the fallback test stays green by design and guards the empty-stdout path. The existing `(Issue #3293)` test is unchanged and passes.
- Removed assertions: none.
- Caller check: `round_container` is called from the paths that set `errfile` before the call; all 51 tests pass.
- Quality gate `./quality.sh < /dev/null` on the final code: every stage PASSED (deno tests, lint, type check, fmt, markdownlint, mermaid, spawn timeout, completeness) except semgrep, which reported `FAILED (exit 2, unreadable report)` with `semgrep produced no JSON report on stdout`. This sandbox cannot reach the rule registry (`curl https://semgrep.dev/c/p/default` returns `CONNECT tunnel failed, response 403`), so the scan could not fetch `p/default`; it is an environment fault, not a finding. checkov was skipped (not installed). CI runs both and is authoritative.
