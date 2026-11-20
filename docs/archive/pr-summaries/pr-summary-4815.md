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
`needs-human` is added. The wedge's cause is still not diagnosed or repaired, so
this is Part of #4815.

## Spec

### Intent and Rationale

- Diagnosis still waits for evidence that cannot reach this run. PR #5294
  (merged 20 November, 20:58Z) posts the archived facts from GRQ-3 to this issue
  on that host's next worker start. When this run checked, those facts had not
  been posted, and no `hard-kill-watchdog-completion` recurrence had been filed
  since 4 November.
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

- The two completion steps that ran after the verifier in the killed runs are no
  longer on `main`. #5095 retired the mutation check. Commit `5be66720e` removed
  the coverage carry-over check. Whether either one was the wedge is unproven
  until GRQ-3's facts are posted.

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

Issue numbers the diff cites: #4227 (An approved issue is never handed back: a
run that delivers nothing is retried, not labelled needs-human as
'analysis-only').

## Reproduction

- **symptom** — the launcher watchdog reaped a container wedged in the
  completion phase of run `vibe-mw2hlf2s-1125d1` on GRQ-3
- **status** — `not-run` — reason: the wedge's evidence is only in GRQ-3's
  private archive, and no recurrence has been filed. The new assertions cover
  the comment wording, not the wedge.
- **regression test** —
  `worker/deno/tests/time_deferral_test.ts::deferIssueUntil - posts a comment and records the body line`

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
- **Ran** `./quality.sh < /dev/null` on the head:
  `Result: PASSED (with skipped checks)`; the gate skipped `config integration`
  and `checkov`.
- **Docs:** I grepped `docs/` (outside `docs/archive/`), `README.md`,
  `DESIGN-PRINCIPLES.md` and `prompts/` for `MAX_TIME_DEFERRALS`,
  `Deferral limit reached` and the deferral limit.
  `docs/workflows/issue-processing.md` ("Deferral has a budget"),
  `DESIGN-PRINCIPLES.md` and `docs/TOKEN-ECONOMIZER-TRIAL.md` already describe
  the retry, so no doc needed a change.

## Not done or not checked

- The wedge's cause and its repair (see Acceptance Criteria).
- I did not check whether GRQ-3 is running the code from PR #5294.
