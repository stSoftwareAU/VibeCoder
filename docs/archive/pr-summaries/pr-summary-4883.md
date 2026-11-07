## Summary

`normaliseLogExcerpt` now normalises Deno's compound durations (`1m43s`,
`2m 14s`, `1h2m3s`) and sub-millisecond units (`µs`, `μs`, `us`, `ns`), so
`computeFailureSignature` is stable across pushes for a failing Deno test job
longer than a minute. The per-signature attempt cap, deferral lookup and
unverified-hold count therefore no longer restart on every push. Closes #4883.

## Spec

### Intent and Rationale

- The old pattern `\b\d+(?:\.\d+)?\s?m?s\b` matched `12ms`/`41s` only; the tail
  of `deno test` output always carries `(2m14s)` and `(199µs)`, so the hash
  changed per run.
- A single widened regex was chosen over extra passes: one `<dur>` token, no
  ordering concerns.

### Essential Design Decisions

- The `h`/`m` prefixes and the unit class share no characters, so the pattern
  has no overlapping quantifiers; a hostile-input test pins that it returns.
- Signatures already stored for excerpts containing these durations change once.
  They never matched across pushes before, so no attempt count is lost; excerpts
  without such durations hash as before.

### Undiscoverable Facts

- The issue comment adds the `µs` form; both U+00B5 (`µ`) and U+03BC (`μ`) are
  accepted.

## Evidence

Backend-only change; no UI. Tests:
`worker/deno/tests/auto_fix_attempt_tracker_test.ts`.

## Test Plan

- `worker/deno/tests/auto_fix_attempt_tracker_test.ts`: added "normalisation
  strips compound and sub-millisecond durations", "duration normalisation keeps
  durable numbers", "duration normalisation terminates on a hostile digit run",
  and "signature is stable across minute-length and microsecond durations". The
  first and last were observed red against the unfixed regex (2 failed), green
  after the fix.
- Durable-number negative: `3m records`/line `12` vs `13` and `2 failed` vs
  `3 failed` stay distinct (would go red if the regex swallowed bare numbers).
- Run on the final head: that file 15 passed; with
  `ci_fix_attempt_markers_test.ts`, `pr_ci_processor_auto_fix_cap_test.ts`,
  `pr_ci_processor_deferral_test.ts`, `pr_ci_processor_no_changes_test.ts` 99
  passed.
- Twinned rule search: the only other duration normaliser (`baseline_gate.ts`, a
  different purpose) is untouched; no other copy of this pattern in
  `worker/deno`.
- Docs: grepped `docs/` and READMEs for signature/duration normalisation; none
  describes the unit list. The doc comment on `normaliseLogExcerpt` was updated.
