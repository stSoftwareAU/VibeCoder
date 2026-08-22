# PR Summary — Issue #249

## Summary

#249 is an auto-filed `worker-crash` bug. Reading the message it was filed
from, the run it describes did not crash:

```text
Claude timed out at the cycle deadline with its work preserved on the branch
— WIP preserved: 2 checkpoint commits pushed to 'issue-4204-…'

### Diagnostics
- Raw exit code: 143 (SIGTERM)
- Watchdog: hard-timeout
```

Exit 143 at the cycle deadline with two WIP checkpoints pushed is the clean
deadline stop working exactly as designed. The category detector agreed and
said `timeout`. The classifier overrode it and said `worker-crash`,
`code_fixable`, with the rationale "the message carries an unhandled exception
/ stack trace from the worker".

There was no exception. `crashOr()` scans the whole failure message, and
`formatDetailedFailureMessage` embeds the tail of Claude's stdout in that
message. Inside the `<details>` block, Claude had written:

> …on a failure the remaining workers keep pulling, so a second failure
> surfaces as an **unhandled rejection**. Tightening it to stop dispatch and
> re-throw.

That is the agent narrating a concurrency bug in **GRQ's** code — the bug it
was in the middle of fixing. `STACK_TRACE_RE` matched the phrase, and the
worker filed a bug against itself for a sentence its own agent wrote about
somebody else's software.

This is not a one-off. An agent's whole job is discussing code, so
"unhandled exception", "TypeError:" and "ReferenceError:" appear in its
narration constantly. Every long-running agent that mentions one while timing
out becomes a spurious `worker-crash`, and `worker-crash` is in `CRASH_CLASSES`
— the classes that auto-file.

### The fix

Crash evidence is now read from the worker's own words. `splitAgentNarration`
separates the agent-authored `<details>` block from the rest, and `crashOr`
applies the prose patterns to the worker's half only.

Two things it deliberately does **not** do:

- **It does not stop reading the agent block entirely.** A structural stack
  frame there — `at Object.run (file:///usr/lib/claude/cli.js:120:9)` — is the
  Claude CLI itself falling over, a genuine worker-side failure that happens to
  reach us through the agent's stdout. `STACK_FRAME_RE` (the structural half of
  the existing pattern) still applies to the agent block. Only the prose half is
  excluded, because prose is what the agent produces about other people's code.
- **It does not touch the "Processes at the kill" block.** That sibling
  `<details>` is worker-authored evidence. The strip is anchored on the
  `Last output from Claude` summary line and is non-greedy, so it cannot
  swallow it.

The asymmetry with the other detectors is now stated in the code rather than
left to be rediscovered. `DISK_FULL_RE` and `OOM_EVIDENCE_RE` still scan the
whole message on purpose: ENOSPC arriving through the agent's stdout means the
run genuinely hit a full disk, which is real environmental evidence the worker
can act on. A mention of an exception is different in kind.

Closes #249.

## Evidence

Backend change with no web interface, so there is no screenshot to capture.

**The regression tests fail against unfixed `main`, and the guard tests pass
there.** That split is the point: two cases prove the bug, four prove the fix
does not over-correct.

```text
# origin/main, new cases only
classify #249 - a deadline timeout is not a worker crash because Claude said 'unhandled rejection' ... FAILED
classify #249 - prose alone inside the agent block never reaches worker-crash ... FAILED
classify #249 - the same prose in the worker's own words IS a crash ... ok
classify #249 - a real stack frame inside the agent block still counts ... ok
classify #249 - the 'Processes at the kill' block stays worker evidence ... ok
classify #249 - disk exhaustion in the agent block is still real evidence ... ok
```

**All green on this branch, with the 8 pre-existing cases intact:**

```text
$ deno test --allow-all tests/run_outcome_classifier_test.ts
run failure classifier - table-driven category/message rows (Issue #4328) ... ok
run failure classifier - precedence: an OOM kill whose message also says 'timed out' is oom; a usage limit with a stack trace is usage-limit (Issue #4328) ... ok
run failure classifier - case-insensitive message matching per message-matched row (Issue #4328) ... ok
run failure classifier - every FailureCategory member is covered; a new member fails here (Issue #4328) ... ok
run failure classifier - the empty message and the empty/unknown category yield unknown (Issue #4328) ... ok
run failure classifier - unknown is not code-fixable for auto-filing; only code_fixable rows are (Issue #4328) ... ok
classifier - a high probe reading at the kill is named as the OOM evidence (Issue #4374) ... ok
classifyRunFailure - interrupted is not_code_fixable and classed 'interrupted' ... ok
classify #249 - a deadline timeout is not a worker crash because Claude said 'unhandled rejection' ... ok
classify #249 - the same prose in the worker's own words IS a crash ... ok
classify #249 - a real stack frame inside the agent block still counts ... ok
classify #249 - prose alone inside the agent block never reaches worker-crash ... ok
classify #249 - the 'Processes at the kill' block stays worker evidence ... ok
splitAgentNarration - removes the agent block and keeps everything else ... ok
splitAgentNarration - a message with no agent block is unchanged ... ok
classify #249 - disk exhaustion in the agent block is still real evidence ... ok

ok | 16 passed | 0 failed (9ms)
```

The `#249` fixture is the real message from the issue body, not invented text —
matching the convention the file's own header sets.

## Test plan

`worker/deno/tests/run_outcome_classifier_test.ts` — 8 new cases:

| Case | Asserts | On `main` |
| --- | --- | --- |
| a deadline timeout is not a worker crash because Claude said 'unhandled rejection' | The verbatim #249 message classifies as `timeout`/`unknown` | **FAILS** |
| prose alone inside the agent block never reaches worker-crash | Four narration phrases — `unhandled rejection`, `TypeError:`, `ReferenceError:`, `unhandled exception` — all stay `timeout` | **FAILS** |
| the same prose in the worker's own words IS a crash | The fix does not blind the classifier outside the agent block | passes |
| a real stack frame inside the agent block still counts | A Claude CLI crash dump is still `worker-crash` | passes |
| the 'Processes at the kill' block stays worker evidence | The non-greedy strip does not swallow the sibling block | passes |
| disk exhaustion in the agent block is still real evidence | The documented asymmetry holds — ENOSPC there is still `disk-full` | passes |
| `splitAgentNarration` removes the agent block and keeps everything else | Diagnostics and the summary line survive; the prose is separated, not lost | n/a (new export) |
| `splitAgentNarration` — a message with no agent block is unchanged | The common case is a pass-through | n/a (new export) |

Acceptance: a run that stops cleanly at its deadline is no longer auto-filed as
a worker crash, and the crash detection that #4328 added still fires on every
shape it was written for.
