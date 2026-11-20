# PR Summary — Issue #4815

## Summary

The issue requires that repeated deferral alone must never turn it into
`needs-human`. The worker already behaves that way: since #4227, once an issue
reaches `MAX_TIME_DEFERRALS`, its next deferral is not honoured and it is
retried as not finished on the failure ladder. But the public comments still
said the opposite. The deferral comment the worker posted on #4815 reads "Past
that limit, this issue is handed to a human instead of deferred again". The
limit-reached comment ends "this is now handed to a human". Both now say the
issue is retried as not finished, and the limit-reached comment adds that no
`needs-human` is added.

GRQ-3 has now posted the redacted facts for its three archived completion kills
on this issue. In all three, the guest did not answer its exec probe, and the
last step logged differs: `agent turn` twice and `pre-PR verifier` once. The
guest VM itself hung, so no single completion step is at fault. The launcher's
early silent-guest reap (#5161, already on `main`) is the repair for a hung
guest. A new bounded replay test runs each kill's recorded timestamps through
that reap's decision at the launcher's real check cadence.

## Spec

### Intent and Rationale

- The diagnosis comes from the facts GRQ-3 posted (PR #5294's backfill):
  three completion kills on 2–4 November, each with the guest probe
  `did not answer`. Before capture, the worker log had been silent for 1h 1m,
  30m 17s and 1h 30m 20s. A hang in one worker step would leave the guest
  answering `exec`. A guest that does not answer is a VM-level hang, and the
  steps differ.
- Since #5161, a guest whose log has been silent for 900s and that fails two
  exec probes is reaped well before the watchdog deadline. All three kills
  predate #5161.
- The comment text is the part of the remaining scope this run can finish: the
  issue's own thread shows a worker comment promising a human hand-off that the
  code no longer performs.

### Essential Design Decisions

- Only the wording changes. The limit, the not-finished retry and the absence of
  `needs-human` (`worker/deno/lib/phases/declared_handoff.ts`, the branch after
  `history.length < MAX_TIME_DEFERRALS`) stay as they are.
- No time-deferral marker is emitted. A deferral after a commit raises no PR,
  and the facts' arrival depends on GRQ-3 restarting, not on a date this run can
  know.

### Undiscoverable Facts

- Why the guest VM stops answering (for example memory exhaustion in the VM)
  is not in the posted facts: guest memory and pressure read `not available`
  because the guest did not answer. The raw evidence stays in GRQ-3's private
  archive, as the issue requires.

## Evidence

Backend change, no UI files. `worker/deno/tests/time_deferral_test.ts` drives
the real comment builders:

- `deferIssueUntil - posts a comment and records the body line`: the posted
  deferral comment includes "retried as not finished" and does not include
  "handed to a human".
- `buildDeferralExhaustedComment - lists prior deferrals and the latest reason`:
  the same two checks, plus every assertion the test already made.

The existing
`worker/deno/tests/handle_no_changes_time_deferral_test.ts::handle_no_changes_phase - deferral limit reached retries, never a human (#4227)`
still proves the behaviour: no label is added, and the issue is retried.

`worker/deno/tests/guest_silence_replay_4815_test.ts` replays the three posted
kills (`vibe-coder-46887`, `vibe-coder-53371`, `vibe-coder-9753`). It uses only
the public timestamps from the issue:

- `replay #4815 <container> (<step>) - the early reap fires before the recorded
  silence`: the real `checkGuestSilence` is run at `run.sh`'s
  `VIBE_GUEST_SILENCE_CHECK_SECONDS` default cadence (300s, now exported as
  `DEFAULT_GUEST_SILENCE_CHECK_SECONDS` beside the threshold), from three
  check-clock offsets. For each, the guest is judged wedged after 900s and
  before 1200s of silence. Even with both exec probes taking their full
  bound, that is before the silence each kill actually ran to.
- `replay #4815 <container> (<step>) - a guest that still answers is never
  reaped`: the same silence with a guest that answers reaps nothing.

Issue numbers the diff cites: #4227 (An approved issue is never handed back: a
run that delivers nothing is retried, not labelled needs-human as
'analysis-only').

## Reproduction

- **symptom** — the launcher watchdog reaped a container wedged in the
  completion phase of run `vibe-mw2hlf2s-1125d1` on GRQ-3
- **status** — `reproduced-by-replay` — the three posted kills are replayed
  from their recorded timestamps through the early reap's decision. With the
  default threshold raised to 3600s (no early reap for these kills), the replay
  failed for `vibe-coder-46887` and `vibe-coder-53371` (`never reaped early
  within 3667.22s` / `1817.232s`). With the shipped 900s default it passes.
- **regression test** —
  `worker/deno/tests/guest_silence_replay_4815_test.ts::replay #4815 vibe-coder-53371 (agent turn) - the early reap fires before the recorded silence`

## Acceptance Criteria

- **missing** — "use a bounded replay or the next applicable recurrence to
  diagnose and repair the completion failure" — reason: GRQ-3 has not yet posted
  the archived facts (PR #5294), and no recurrence has been filed, so there is
  nothing to diagnose from.
- **missing** — "Complete the issue through an implemented fix and automated
  regression/recovery evidence" — reason: the coding standards rule out a
  speculative fix for an unreproduced fault. This diff fixes the deferral
  comment wording, not the wedge.

## Test Plan

- **Edited** `worker/deno/tests/time_deferral_test.ts`: assertions added to two
  existing tests, with none removed. On the unchanged code both tests failed
  with
  `Expected actual: "…handed to a human…" to contain: "retried as not
  finished"`
  (25 passed, 2 failed). After the fix,
  `deno test -A
  tests/time_deferral_test.ts tests/handle_no_changes_time_deferral_test.ts`
  from `worker/deno` passed: 37 passed, 0 failed.
- **Added** `worker/deno/tests/guest_silence_replay_4815_test.ts`. It needs
  no production change: the repair (#5161) is already on `main`. Red check:
  with `DEFAULT_GUEST_SILENCE_SECONDS` temporarily set to 3600, 2 of the 6
  replay tests failed. The change was reverted, and
  `deno test -A tests/guest_silence_replay_4815_test.ts
  tests/guest_silence_watch_test.ts < /dev/null` from `worker/deno` passed:
  16 passed, 0 failed. `deno lint` and `deno check` on the new file are clean.
- **Ran** `./quality.sh < /dev/null` on the earlier head (before the replay
  test):
  `Result: PASSED (with skipped checks)`; the gate skipped `config integration`
  and `checkov`.
- **Docs:** I grepped `docs/` (outside `docs/archive/`), `README.md`,
  `DESIGN-PRINCIPLES.md` and `prompts/` for `MAX_TIME_DEFERRALS`,
  `Deferral limit reached` and the deferral limit.
  `docs/workflows/issue-processing.md` ("Deferral has a budget"),
  `DESIGN-PRINCIPLES.md` and `docs/TOKEN-ECONOMIZER-TRIAL.md` already describe
  the retry, so no doc needed a change.

## Not done or not checked

- Why the guest VM hangs: the facts do not say, and the raw evidence is private
  to GRQ-3. The early reap bounds the cost of a hang; it does not stop the VM
  hanging.
- I did not check whether GRQ-3 is running the code from #5161.
