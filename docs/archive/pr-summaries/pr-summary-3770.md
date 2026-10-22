## Summary

`gateUnpushedCommits` discarded the `checksRun` list that `runPrePushGate` returns, and its completion-phase caller logged only a block, so a passing or no-op gate left nothing in the worker log. With this change `gateUnpushedCommits` returns a `PrePushGateOutcome` — `noop` when nothing needed gating, or `passed` naming the changed-file checks that ran — and the completion phase logs one INFO line per gate run: `Pre-push gate passed checks=[deno fmt, markdownlint, …]` on a pass, or `Pre-push gate: nothing ahead of <base>` (and `Pre-push gate: nothing unpushed` when the base is unresolvable) on a no-op. A no-op is never logged as a pass. Closes #3770.

- `worker/deno/lib/git_push.ts`: new exported `PrePushGateOutcome` discriminated union; `gateUnpushedCommits` returns `Result<PrePushGateOutcome>` instead of `Result<void>`, and its two no-op early returns and its final success now carry the outcome.
- `worker/deno/lib/phases/completion_phase.ts`: `gateBeforePush` logs the outcome after a passing gate.
- `worker/deno/lib/issue_worker_wiring.ts`: the default mock's `gateUnpushedCommits` returns `{ kind: "passed", checksRun: [] }` to match the new type.
- `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts`: three new tests through `workOnIssueCompletion` assert the pass line names the checks, and that a no-op — with a resolvable and an unresolvable base — is never logged as a pass.
- `docs/pre-pr-ci-audit.md`: the live-run section now records that the gate logs one INFO line per run.

## Spec

### Intent and Rationale

- The #3717 audit (`docs/pre-pr-ci-audit.md`) had to prove the gate on real failing heads by replaying the entry point in disposable checkouts, because live worker logs could not show which checks the gate reached or skipped. Making the pass and no-op outcomes observable removes that blind spot for future runs.
- The gate's own `runPrePushGate` already computed `checksRun`; the fix is to stop discarding it at the `gateUnpushedCommits` boundary rather than to add a second measurement.

### Essential Design Decisions

- A discriminated union (`noop` | `passed`) rather than a nullable `string[]`: a `passed` outcome with an empty checks list (a gate with no applicable check) stays distinguishable from a `noop` (nothing ahead), so the completion phase never logs a no-op as a pass.
- The no-op log line names the base when it is resolvable (`nothing ahead of <base>`) and degrades to `nothing unpushed` when it is not, mirroring the existing base-resolution behaviour in `gateBeforePush`.
- `commitAndPushPending` Step 1b ignores `gateUnpushedCommits`'s value today, so it needed no change; the new type flows through `GitDeps["gateUnpushedCommits"]` (`typeof gateUnpushedCommits`), which only the default mock and the test stub had to match.
- The repo's pre-flight commands, when configured, run inside the gate and are not listed by `checksRun`, which already names only the changed-file checks; the log line says `checks=[…]` for that reason.

### Undiscoverable Facts

- The issue body has no `## Acceptance Criteria` heading and no `bug` label, so no closure block, no two-axis review block and no Reproduction / Acceptance Criteria block are required in this summary.
- The #3717 replay at `docs/pre-pr-ci-audit.md` reads only `r.ok` / `r.error.message`, which the new return type preserves, so that documented replay command stays valid.

## Evidence

Backend-only change; no UI file is touched. It is verified by unit tests through `workOnIssueCompletion` against the mocked git seams, plus the repository's full quality gate.

- **Docs sweep** — grep: `gateUnpushedCommits`, `PrePushGateOutcome`, "Pre-push gate", "logs nothing on a pass", `checksRun`; section: `docs/pre-pr-ci-audit.md#completion-phase-pre-push-gate-live-runs`; siblings: none — `PrePushGateOutcome` is a new type, so no existing set gained a member; updated: `docs/pre-pr-ci-audit.md` (the live-runs section and the two method/limits bullets that said the gate logged nothing on a pass); `docs/pre-pr-ci-audit.md:251` — still true, the replay reads only `r.ok` / `r.error.message`.
- Related existing rules checked: none govern the pre-push gate's log line. `docs/INTERNALS.md` describes only the block path of the gate (still accurate), so it needed no change.
- Full quality gate on the committed head: `./quality.sh < /dev/null` — `Result: PASSED (with skipped checks)` (config integration skipped; deno tests, lint, type check and fmt all PASSED).

## Test Plan

- New test `completion - a passing pre-push gate logs the checks it ran (Issue #3770)` in `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts`: drives `workOnIssueCompletion` with the gate mock returning `{ kind: "passed", checksRun: ["deno fmt", "markdownlint"] }` and asserts the INFO lines include `Pre-push gate passed checks=[deno fmt, markdownlint]`. Red check: reverting the logging block to the base early return removed the pass line and turned the test red (no `Pre-push gate passed` line in `infos`).
- New test `completion - a no-op pre-push gate logs nothing ahead, never as a pass (Issue #3770)`: asserts a `Pre-push gate: nothing ahead of …` line and that no line starts with `Pre-push gate passed`. Red check: reverting the logging block removed the nothing-ahead line and turned the test red.
- New test `completion - a no-op gate on an unresolvable base logs nothing unpushed, never as a pass (Issue #3770)`: sets `baseUnresolvable` and answers the gate `noop` on both the initial run and the branch-outcomes summary recovery, asserting a `Pre-push gate: nothing unpushed` line and no pass line. Red check: changing the ternary's false operand to `Pre-push gate: nothing unpushed CHANGED` turned the test red (`expected a nothing-unpushed line, got: ["Pre-push gate: nothing unpushed CHANGED", …]`).
- Targeted run: `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts` (17 tests at head) via `deno task test:unit` — all passed.
- `./quality.sh < /dev/null` on the committed head — `Result: PASSED (with skipped checks)`.

<!-- vibe-branch-outcomes -->
