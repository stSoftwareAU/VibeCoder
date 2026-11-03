## Summary

Every lane that publishes agent-authored work now runs the target repository's
own gate (`./quality.sh`, or its configured `quality_command`, in its
`docker_image` and with its declared `quality_credentials`) on the committed
head before the push. A failed or unrun gate can no longer become a successful
completion. A new shared module, `worker/deno/lib/publication_validation.ts`,
owns the result contract and five lanes consume it:

- issue completion (`completion_phase.ts`: `gateBeforePush`, and the
  last-currency push of a head merged with a moved base);
- CI repair (`pr_ci_processor.ts`), PR feedback (`pr_feedback_processor.ts`) and
  PR spelling (`pr_spelling_processor.ts`), through the existing `beforePush`
  seam of `commitAndPushPending` and `recoverFromPushRejection`;
- babysitter repair (`fleet_pr_babysitter.ts`), after the commit and before the
  push, so `BABYSITTER_READY` alone is no longer the quality result.

Part of #4625: commits an agent pushes itself in the CI and feedback lanes are
still gated only by the changed-file pre-push hook (see Acceptance Criteria).

Version bump: `VERSION` is not touched by this change.

```mermaid
flowchart LR
    C[Completion] --> V
    CI[CI repair] --> V
    F[PR feedback] --> V
    S[PR spelling] --> V
    B[Babysitter] --> V
    V{Repository gate<br/>on the committed head}
    V -->|passed| P[Push]
    V -->|failed: output returned to repair| R[Not pushed]
    V -->|unavailable: tool, Docker, credential, disk, timeout| D[Not pushed, lane defers and resumes]
```

## Spec

### Intent and Rationale

- The same `deno test` step failed on CI for 13 fleet PRs because paths
  published without a passing local gate: a gate skipped for budget, a
  best-effort post-run check that pushed anyway, and a babysitter push after
  only `git diff --check`. One runner-owned check at the push boundary closes
  them.
- It reuses `runQualityGateCheck` (Docker, credentials, missing-tool and
  Docker-infrastructure classification) rather than a second runner. The
  checkout is passed in, so a babysitter clone is validated, not the process
  cwd.

### Essential Design Decisions

- Three outcomes. `unavailable` (missing tool, Docker or credential fault, disk
  full, gate timeout, unreadable checkout) is infrastructure: never pushed,
  never a content failure, and the lane retries. A repository with no
  `quality.sh` is an explicit `gate: "absent"` pass; `skip_quality_check` is
  `gate: "opted-out"`.
- The result is tied to the head: a dirty working tree (worker state files
  excepted) is a failure, a head that moves during the run is discarded, and the
  guard re-validates any new head. A pass is reused only for the same clean
  head.
- A zero exit is not enough: a Deno summary totalling `0 passed | 0 failed` is a
  failure. The 30-minute default timeout stops this repository's multi-minute
  gate being killed; a repository's own `quality_check_timeout` still overrides
  it, the host-wide 600 s default does not apply.
- The runner executes the target repository's own checks and centralises no
  policy. No prose or evidence accounting was added (#4234).

### Undiscoverable Facts

- `pr_feedback_processor.ts` marks non-review comments processed before
  publication, so a gate failure there leaves that mark (as any push failure
  does today); `pr_review` is held and not marked addressed.
- In this sandbox two existing tests fail on the base commit too, so they are
  environmental: `babysitter default heartbeat resolves its checkout revision`
  (jsr.io unreachable) and
  `verifyResolvedTree - the repository's own task sees
  only the allowlisted environment (Issue #4659)`
  (untrusted account cannot use `/tmp`, #4697). Checked by running both files on
  `392748f3`: 2 failed.

## Evidence

Backend-only change; no UI file touched. Tests drive real functions with temp
git repositories and bare origins:

- `worker/deno/tests/publication_validation_test.ts`: every gate action mapped,
  real `quality.sh` pass and fail, a zero-test Deno run, a dirty tree, HEAD
  moved during the run, opt-out, `qualityCommand`, deps bound to the checkout,
  the 30-minute timeout, exit 124/137/143 and disk-full as `unavailable`, an
  unreadable checkout, and the guard (once per head, new commit, edit after a
  pass, failed output, in-sync branch).
- `worker/deno/tests/completion_phase_publication_validation_4625_test.ts`:
  failed (one repair turn, then `pre_push_gate`, no push), fail then pass,
  unavailable (`push_failure`, no push, no repair turn), pass for `ran`,
  `absent` and `opted-out`, noop skip, merged head failing and passing.
- `worker/deno/tests/pr_ci_processor_test.ts`,
  `worker/deno/tests/pr_feedback_processor_test.ts` and
  `worker/deno/tests/pr_spelling_processor_test.ts`: the `beforePush` argument
  at each push site yields the validator verdicts; real `commitAndPushPending`
  against a bare origin leaves the branch unmoved with the cause in the reported
  failure; feedback runs the gate before the verifier, unavailable releases the
  claim, failed is not marked addressed.
- `worker/deno/tests/fleet_pr_babysitter_validation_test.ts` runs the scenarios
  in `worker/deno/tests/fixtures/fleet_pr_babysitter_validation_scenarios.ts` in
  a child `deno test` (they set `HOME`, which the process-state cap forbids in a
  suite): failed gate, unavailable gate then resume on the same head, passed
  gate, `BABYSITTER_READY` with a failed gate, validate receives the clone and
  repo configs after the commit, a lock-renewal failure during the gate, and a
  config that cannot be loaded.

## Acceptance Criteria

- **missing** — "Include the test targets CI compiles" / "CI's impacted-test
  selection": the runner executes the repository's own entry point and rejects
  an empty Deno selection, but this repository has no impacted-test selection to
  mirror and no test proves Deno tests execute in both an initial run and a
  repair — reason: nothing to reuse here; the full `quality.sh` runs.
- **missing** — "Tests exercise every publishing path": commits an agent pushes
  itself in the CI and feedback lanes reach origin through the pre-push hook,
  which runs only the changed-file checks, and the completion recovery turns
  (summary-rule, screenshot, PR-body-length) push the issue branch before
  completion's own gate — reason: running a multi-minute gate inside the agent's
  `git push` was not attempted; every worker-owned push and every PR creation is
  covered.
- **missing** — "infrastructure outcome ... release/defer": the CI lane keeps
  its retry charge when the gate is unavailable and only reports the push as
  deferred — reason: `pr_ci_checks.ts` has no refund helper; adding one is a
  redesign of the retry accounting.
- **missing** — "test compilation failure" as its own case: a failing real
  `quality.sh` is covered, but no test compiles a broken test module — reason:
  the validator only sees the gate's exit and output, so it would repeat the
  failing-command test.

## Test Plan

Commands run from `worker/deno` on the final head (stdin from `/dev/null`):

- `deno test --allow-all` on `tests/publication_validation_test.ts`,
  `tests/completion_phase_publication_validation_4625_test.ts`,
  `tests/pr_ci_processor_test.ts`, `tests/pr_feedback_processor_test.ts`,
  `tests/pr_feedback_review_dismissal_3383_test.ts`,
  `tests/pr_spelling_processor_test.ts`,
  `tests/fleet_pr_babysitter_validation_test.ts`,
  `tests/parallel_safety_cap_test.ts`: passed.
- `./quality.sh`: every stage passed except `deno tests`, whose only two
  failures (32278 passed) are the two base-commit failures named above;
  `config integration` and `checkov` were skipped by the gate on this host.
- `deno task check:manifests`: passed (the new module is registered in
  `docs/audits/lib-sweep-coverage/top-up-4625.json`).

Red checks (the change broken on purpose, test goes red, then restored):

- validation call removed from completion's gate: the completion tests for
  failed, fail-then-pass, unavailable and pass go red; unavailable treated as
  passed: the unavailable test goes red; noop guard removed: the noop test goes
  red; merged-head check ignored: the merged-head test goes red.
- CI/feedback/spelling: guard dropped from the retry call, verifier-first order,
  unavailable treated as passed: the matching `beforePush` tests go red.
- babysitter: `validate` call removed: 6 of 8 scenarios go red through the
  parent test; unavailable treated as passed, attempt record not removed, the
  renewal re-check removed, and the config load removed each turn their scenario
  red.
- `publication_validation.ts`: timeout mapping, disk mapping, the 1800 s default
  timeout and the re-read error cause each removed: the matching test goes red.

No existing assertion was removed. Existing fixtures changed only to supply the
new seam: `validatePublication: passingPublication` in
`tests/pr_feedback_processor_test.ts` (one test) and
`tests/pr_feedback_review_dismissal_3383_test.ts` (`runScenario`).

Callers of `commitAndPushPending` checked: CI (final and retry), feedback (final
and retry), spelling (final and retry) pass the guard;
`recoverFromPushRejection` in those three lanes passes it; completion uses
`gateBeforePush` and validates before `pushUnpushedCommits`; the completion
recovery turns (`summary_rule_gate_retry.ts`, `screenshot_gate_retry.ts`,
`pr_body_length.ts`) do not, as stated above.
