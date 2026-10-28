## Summary

A run-failure issue is now self-scheduled (Issue #505) only when it names at least one readable source: the body's `**Source:**` line, or a fleet-authored follow-up occurrence line that names a public source. An issue whose every occurrence was withheld (private source repo, #4318) is refused, logged, and left to wait for the owner's `work-on`. #4318's withholding is unchanged. Closes #4462.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- A self-scheduled run on a withheld issue can only guess the cause, which can hide a real worker fault (#4442, #4460). Gating at the scheduler keeps the public issue as safe as #4318 made it.

### Essential Design Decisions

- Gate lives in the collector (`collect_self_diagnostic_candidates.ts`), after the attestation check; the filer and its withholding are untouched.
- Hard-kill issues share the `VIBE_RUN_FAILURE` marker but carry their facts in the public body (no `**Phase that died:**` line), so `runFailureNamesReadableSource` treats them as readable and they stay schedulable.
- Only follow-up comments authored by a fleet login and carrying the follow-up marker count; a comment-read failure refuses (fails closed, logged).
- A body with a Source line costs no extra read; only withheld bodies cost one bounded comments read.

### Undiscoverable Facts

- `tests/completion_phase_repo_formatters_test.ts` (2 Rust-formatter tests) fails on the base commit 045cff76 in this environment too, so it is unrelated.

## Evidence

Backend-only change; verified by the tests below. Fixtures are built from the real `formatRunFailureBody` / `formatOccurrenceLine` output (exported for the round trip).

## Test Plan

- `worker/deno/tests/run_failure_issue_test.ts`: six `runFailureNamesReadableSource` tests (public body, private body, hard-kill body, public and withheld follow-up occurrences, hostile 100k-character input).
- `worker/deno/tests/collect_self_diagnostic_candidates_test.ts`: five `self-schedule` tests: all-withheld refused with cause `no-readable-source`; public-source follow-up scheduled; Source-line body needs no follow-up read; non-fleet follow-up refused; unreadable comments refused.
- Red check: with the readable-source check disabled, the all-withheld, outside-login and unreadable-comments tests fail; the two scheduling tests stay green.
- Ran the four touched test files plus `find_oldest_issue_self_diagnostic_test.ts` and `hard_kill_report_test.ts`: 101 passed, 0 failed. `./quality.sh`: markdownlint (fixed), semgrep, lint, type check and fmt pass; the deno tests stage fails only on the two pre-existing Rust-formatter tests above.
- Callers/siblings checked: `postRunFailureFollowUp` (hard-kill reporter, unchanged output), `formatOccurrenceLine` (only exported).
- Docs updated: `docs/INTERNALS.md` (tier 2b), `docs/workflows/issue-processing.md` (self-scheduled diagnostics).

Not done: none of the gate's skipped stages (checkov, config integration) ran locally.
