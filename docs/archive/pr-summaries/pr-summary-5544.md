## Summary

Replace repeated regex attempts over failed name runs with a linear reference
scan, preserving follow-up selection and label-stripping safeguards. The
archived watchdog incident remains undiagnosed. Part of #5544.

## Spec

### Intent and Rationale

- Prevent long model-authored name runs from blocking synchronous follow-up
  detection. Preserve matching behaviour instead of truncating model output.

### Essential Design Decisions

- Preserve reference order, case-insensitive same-repository preference, other
  full-reference fallback and bare-reference fallback.
- Revisit the repository segment of a failed match because it can start a
  nested reference such as `a/b/c#1`.
- Count character reads through the production reader seam; unit tests contain
  no timing thresholds.
- Treat the scan defect as independently reproduced, not as the established
  cause of the original watchdog kill.

### Undiscoverable Facts

- The GRQ-23 archive for container `vibe-coder-70601`, run
  `vibe-mwud88ss-874459`, records both label strips completing in 0s at
  09:26:53Z and 09:31:05Z on 24 November 2026. Later activity includes claim
  release and a 300s failure backoff at 09:39:57Z, before capture at 10:31:11Z.
- The 25 November retry stopped at the guest memory floor (178 MiB available,
  806 MiB floor). That interruption is separate from the original watchdog.

## Evidence

- Backend only. `worker/deno/tests/escape_hatch_reference_scan_5544_test.ts`
  checks observable detection results and linear read growth for six input
  families at N and 4N, with an additional input-length bound.
- `worker/deno/tests/escape_hatch_label_strip_test.ts` drives the real
  message-level strip, checking resulting labels, self-reference exclusion,
  repository restrictions, human-applied-label protection and negative
  detection.
- Call path inspected: `worker/deno/lib/issue_worker.ts` →
  `worker/deno/lib/escape_hatch_label_strip.ts` →
  `worker/deno/lib/escape_hatch.ts`. The phase-signature wording was checked
  against `worker/deno/lib/hard_kill_report.ts::hardKillSignature`.
- #5544: Hard kill: container wedged in follow-up-label-strip (watchdog).
  Confirmed through `gh api` after `gh issue view` hit the GraphQL rate limit.

## Reproduction

- **symptom** — the launcher's watchdog deadline expired after 51m 14s of
  silence, reported under `follow-up-label-strip`.
- **status** — `partial` — reason: synthetic scan stalls reproduced against
  unfixed production code; the original container/watchdog failure was not
  reproduced, and the archive shows its label strips completed.
- **regression test** —
  `worker/deno/tests/escape_hatch_reference_scan_5544_test.ts::detectEscapeHatch - long name run with bare fallback (Issue #5544)`.
  A disposable copy importing the unfixed `origin/main` detector exceeded a
  five-second command bound at 1,000,000 and 100,000 name characters; 10,000
  completed. The fixed detector passed the retained million-character case.
  The new label-strip regression also exceeded the bound with the base
  detector and the new fake client, isolating the production scan as the cause.
  These shared-host bounds are reproduction evidence, not test assertions or
  benchmark claims.

## Acceptance Criteria

- **missing** — a container wedged and the launcher watchdog reaped it, so the
  run never released its claim — reason: the archive instead records completed
  strips and claim release before later silence; the original watchdog cause
  remains undiagnosed.

## Test Plan

- Detector and reference-scan suites: 25 passed. Label-strip and shared
  reserved-label suites: 62 passed, using `deno task test:unit` sequentially.
- Affected issue-worker, wiring, PR-feedback and CI-fix suites: 248 passed.
  The first command exceeded its 90s bound; the same suites passed under a
  600s bound. Formatting and lint passed for the three changed TypeScript
  files. A type check including the large caller graphs exceeded 180s without
  diagnostics; a check limited to changed files is still running.
- Added tests are in
  `worker/deno/tests/escape_hatch_reference_scan_5544_test.ts` and
  `worker/deno/tests/escape_hatch_label_strip_test.ts`. Existing assertions were
  retained; the fake client now updates its stored labels on removal so the
  added tests assert state as well as the strip summary.
- Compatibility corpus: archived summaries, prompt Markdown and relevant test
  source at base (1,620 files, 3,240 comparisons) and head (1,621 files, 3,242
  comparisons), using two repository slugs. Zero result mismatches; zero added
  positives or negatives relative to the base detector. This establishes
  compatibility, not independent accuracy of the existing prose heuristic.
- The checkpoint's sticky full-reference, alphanumeric-start and name-run
  regexes were reviewed and replaced by character scanning. The final diff
  adds no regexes. Existing bare-reference and needs-human patterns remain.
- Shared callers inspected: issue work, CI fix and PR feedback. No twinned
  implementation of the full-reference scanner was found.

## Remaining risk

The original watchdog cause is unverified. Private archive contents were not
committed. The full quality gate has not run yet. No push or issue/PR lifecycle
change was performed.
