## Summary

Closes #3989.

The security discrimination fixture's commits launched detached Git
auto-maintenance, which could keep writing into `.git` after the awaited
command returned and race recursive fixture removal. Fixture Git commands now
disable automatic maintenance and garbage collection, following the existing
real-Git fixture convention.

The timeout scenario also exercises a partially written clone and checks its
removal, source-checkout isolation and removal of the outer fixture. Its
`git clone timed out` assertion and strict recursive cleanup remain in place.

## Spec

### Intent and Rationale

- Prevent background fixture writes from outliving the setup commands the test
  awaits, without hiding cleanup errors or changing timeout classification.

### Essential Design Decisions

- Apply `gc.auto=0` and `maintenance.auto=false` as command-scoped options in
  the fixture helper. Production process execution, its environment filtering
  and disposable-checkout cleanup are unchanged.
- Finish writing the partial clone within the awaited timeout stub before
  returning its result, so the cleanup assertions introduce no background writer.

### Undiscoverable Facts

- The timeout stub never launches a clone process. Git tracing of that
  scenario on the base code recorded two `git maintenance run --auto --quiet
  --detach` child launches from fixture setup; the fixed version recorded zero.
- The original intermittent `Directory not empty` exception was not reproduced
  locally; the trace confirms the background-process mechanism independently.
- This workspace's PID 1 leaves killed orphan processes as zombies. The full
  gate is run under the installed tini supervisor (`docker-init -s`); the
  process-tree test also fails on the unchanged base without that supervisor,
  and both affected process-kill tests pass with it.

## Evidence

- #3989: Eliminate intermittent temporary-repository cleanup race in security
  discrimination test (issue title and requirements read before the change).
- All 47 tests in `worker/deno/tests/security_fix_discrimination_test.ts` pass,
  including the real-Deno red-at-base/green-at-head scenario.
- 100 timeout/cleanup repetitions pass with four concurrent Deno processes.
- `deno task check:manifests`: 791 passed, zero failed, one ignored.
- Targeted Deno type checking, lint and formatting checks pass.
- Markdown lint passes across the 230 configured documents and, separately,
  this archived summary using the same structural rules.
- Full `./quality.sh --sequential < /dev/null` passes under `docker-init -s`,
  including both unit-test passes (parallel: 3m56s; serial: 2m26s), full Deno
  lint, type checking, formatting, structural checks and Markdown lint.
- Optional configuration integration was skipped because this workspace has
  no `.config.json`; Semgrep was skipped because neither its binary nor its
  pinned container image is installed. Hosted CI remains pending.

**Docs sweep** — grep: `withRepo`, `recordingSeams`, `detached auto-maintenance`;
section: `docs/EXTENDING.md#-running-tests` and
`CODING-STANDARDS.md#unit-tests` read; updated the fixture helper's explanatory
comment; siblings: none — no production interface or registry gained a member.
No manual describes these private fixture helpers. The remaining source
comment hits are in the changed helper and describe the guarded behaviour.

## Reproduction

- Symptom: intermittent `Directory not empty` during temporary-repository
  removal after the timed-out-Git assertions.
- Status: partial.
- Reason: the intermittent exception did not reproduce locally; real Git
  traces confirm two detached maintenance launches before the fixture fix
  and zero after, and all 100 concurrent timeout/cleanup repetitions pass.
- Regression test: `worker/deno/tests/security_fix_discrimination_test.ts` —
  `discrimination: a timed-out git step is not_checked`.

## Test Plan

- Extended `discrimination: a timed-out git step is not_checked` to create a
  partial checkout before returning `timedOut: true`, assert its temporary
  directory is absent, assert no Deno test ran, verify a clean source checkout
  and unchanged fixed source, and assert the outer repository is removed.
- Retained the existing exact timeout-reason assertion and the suite's
  production isolation and cleanup assertions. No assertion was removed.
- Compared real Git process traces before and after the fixture change.

## Merge verification

- Full local quality gate: passed with the optional skips recorded above.
- Hosted CI and code review: pending.
