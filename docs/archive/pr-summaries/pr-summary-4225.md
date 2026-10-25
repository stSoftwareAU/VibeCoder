## Summary

A guest coding agent can start one rustc or linker per vCPU, and can start a Rust suite and a Deno suite together in the background. On an 8GB guest with no swap that exhausted memory without an OOM kill, and the container sat silent until the launcher's 11400s watchdog reaped it. This change caps cargo at two jobs inside the container, tells the merge-conflict and pre-PR prompts to run one scoped suite in the foreground, and records MemAvailable and the two PSI files on the liveness tick while that tick is still being written. It does not claim the guest can no longer freeze. Closes #4225.

## Spec

### Intent and Rationale

- Cap `cargo` inside the guest so one build cannot start a job per vCPU.
- Tell the agent to run one test suite at a time, in the foreground, and only for the crates or packages the change touched.
- Record memory pressure on the liveness tick that already runs, so the log shows it before a later stall. A frozen event loop still writes nothing.
- Leave the process-tree kill path alone unless a defect can be shown with a failing test. None could.

### Essential Design Decisions

- `CARGO_BUILD_JOBS=2` is exported by `container/entrypoint.sh`, which replaces a value the container was already given. The entrypoint is what the worker, the agent and their children inherit. `run.sh` and `run.ps1` do not set it.
- The untrusted-command allowlist forwards `CARGO_BUILD_JOBS` when the parent has it and does not invent a value, so a host run that never set the variable stays uncapped.
- On a tick line written because the liveness guard returned ok, the line ends with `mem_available_mib`, `pressure_memory` and `pressure_cpu`. A file that cannot be read, and a meminfo with no `MemAvailable:` line, is the token `unavailable`. A readable blank pressure file is `empty`. `mem_available_mib=0` is a real reading. The `[liveness] ALERT` line does not carry these fields, and a guard error does not write the tick line.
- No cargo config or debug-profile hook exists for the guest, so no linker profile was added. The slot governor already samples its own MemAvailable probe and does not read this tick, so PSI is logged and not used to refuse a slot or a build.

### Undiscoverable Facts

- None.

## Evidence

Backend change, no UI. The live guest stall was not run on this machine.

- `worker/deno/tests/container_entrypoint_test.ts::entrypoint - caps cargo build jobs at 2 (Issue #4225)` — passed. A container started with `CARGO_BUILD_JOBS=8` still presents `2` to the driver.
- `worker/deno/tests/container_entrypoint_test.ts::entrypoint - never reaches the host's own scratch root, whatever the host exported` — passed after `CARGO_BUILD_JOBS` was added to the leak test's shell-owned set.
- `worker/deno/tests/untrusted_command_env_test.ts::buildUntrustedCommandEnv - forwards the guest cargo job cap and does not invent one (Issue #4225)` — passed.
- `worker/deno/tests/liveness_pressure_4225_test.ts` — 4 passed, including `readLivenessTickPressure - a missing pressure file is unavailable and is not logged as zero (Issue #4225)`.
- `worker/deno/tests/guest_test_suite_prompt_4225_test.ts` — passed. The same sentence is in the merge-conflict template, the issue prompt, and the coding-guidelines targeted-test section.
- `worker/deno/tests/merge_conflict_prompt_v2_test.ts`, `worker/deno/tests/liveness_guard_test.ts`, `worker/deno/tests/milestone_gate_repair_prompt_test.ts` and `worker/deno/tests/coding_guidelines_layers_2574_test.ts` — passed (55, then 12).
- `deno fmt` and `deno lint` on the touched TypeScript files — clean.
- `docs/CALLBACKS.md` — the per-cycle liveness bullet now states when the three fields are written and what `unavailable`, `empty` and `0` mean.

## Test Plan

- [ ] Confirm `container/entrypoint.sh` exports `CARGO_BUILD_JOBS=2` and that a pre-set value of `8` is replaced (`entrypoint - caps cargo build jobs at 2`).
- [ ] Confirm the untrusted-command allowlist forwards `CARGO_BUILD_JOBS` only when the parent set it.
- [ ] Confirm a missing `/proc/pressure/*` file or a meminfo with no `MemAvailable:` line is the token `unavailable` on the pressure fields, and that `0` kibibytes of `MemAvailable` stays `mem_available_mib=0`.
- [ ] Confirm the merge-conflict template, `prompts/issue/prompt.md` and `prompts/coding_guidelines/prompt.md` share one sentence: one suite at a time, in the foreground, never with `run_in_background`, only the crates or packages the change touched.
- [ ] Copies inspected and not given a second wording: the existing "one at a time, in the foreground, never with `run_in_background`" bullets in `prompts/coding_guidelines/prompt.md` (two) and `CODING-STANDARDS.md`. They already said that and were left as they were. `run.sh` and `run.ps1` were not changed; the guest inherits the entrypoint export, and `worker/deno/tests/launcher_parity_test.ts` was not in this diff.
- [ ] Do not treat a green unit run as proof the guest stall is gone.

## Reproduction

- **symptom** — the worker container goes silent during a large Rust or Deno test build and is reaped only by the 11400s watchdog, with no OOM kill
- **status** — `partial`
- **regression test** — `worker/deno/tests/liveness_pressure_4225_test.ts::readLivenessTickPressure - a missing pressure file is unavailable and is not logged as zero (Issue #4225)`

reason: the guest-wide stall was not reproduced on this machine; the regression test covers the new cap / log line only.

## Kill path

`fireKill` in `worker/deno/lib/claude_runner.ts` starts `killClaudeProcessTree` and arms the completion cap (`killAfterSeconds * 4`, never under 60s) before awaiting either. The "did not complete" line is written when that timer wins the race against the child's status, after an in-flight progress-extension probe returns. Those probes use a bounded `runWithTimeout`. When the cap fires, the kill promise itself is not awaited. `commandOutputWithTimeout` can still sit on `child.status` after its own abort, but that wait is inside the kill promise the cap abandons, not in front of the log. The issue records one run that did print the line, 497s after a 120s cap, and the latest run where the no-output line was logged and the event loop never ran again. Both are a guest that is not being scheduled, not a branch that skips the line while the loop is alive. No unit test showed the line being skipped while the event loop was still running, so the kill path was not changed.
