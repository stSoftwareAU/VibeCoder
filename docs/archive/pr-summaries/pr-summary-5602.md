## Summary

Run the milestone branch command tests that can push in a private subprocess,
with auditing disabled and a temporary work directory. Reuse the existing
presync subprocess invocation through a shared test helper. Closes #5602.

## Spec

### Intent and Rationale

- The git-only request shield cannot disable auditing. Isolating the test
  process fixes the leak without widening the production env allowlist.

### Essential Design Decisions

- `runGitOperationsCommand` passes the JSON request as an argv element and
  decodes the last stdout line as the command result. Non-zero child exits
  report both output streams.
- The child clears inherited environment, retains HOME, PATH, DENO_DIR and
  XDG_CACHE_HOME, and sets `NO_HOST_GIT_CONFIG`, TMPDIR and WORK_DIR
  explicitly. Command requests retain their Git config settings and production
  validation.
- The two refusal tests remain in-process: their invalid env is refused before
  git runs. The success and push-failure cases use the isolated helper.

### Undiscoverable Facts

- Before the fix, running only the existing branch-recreation test with auditing
  enabled passed its remote-SHA assertion and wrote one successful `git-push`
  row targeting `origin/main:refs/heads/milestone/recreated`.
- Reproduction used private WORK_DIR, VIBE_AUDIT_DIR and TMPDIR paths and
  removed its owned temporary root afterwards; no live journal was used.

## Evidence

Test-support change only; no UI or production command behaviour changes.

```mermaid
flowchart LR
    T[Milestone command tests] --> H[Shared subprocess helper]
    H --> E[Private environment: audit disabled]
    E --> C[Production git-operations command]
    C --> G[Temporary git remote]
```

- `worker/deno/tests/git_operations_subprocess_test.ts` runs the real command
  tests with auditing enabled in their ambient environment, once with WORK_DIR
  and once with VIBE_AUDIT_DIR. Both audit directories stay empty after the fix.
- Both regression cases failed against the unfixed branch-ensure test file:
  `command tests wrote audit state: anchors,audit-…jsonl`. Production code and
  fixtures were unchanged during that red run.
- The verifier's cache regression was reproduced with DENO_DIR unset, a
  populated XDG cache and an empty default HOME cache: the accepted-caller-config
  presync test failed to load cached `@std/yaml`. Both updated audit regressions
  also failed against the original cache helper. Preserving XDG_CACHE_HOME
  through `denoCacheEnv` fixes both cleared-environment subprocess paths.
- #5602: milestone_branch_ensure_test.ts drives a real `git-operations` push
  that can write a `git-push` row to the live audit journal.

## Test Plan

- `worker/deno/tests/milestone_branch_ensure_test.ts`: retained the recreated
  branch's remote-SHA equality and the failed push's failure-message assertions;
  added checks that neither case creates an audit directory in its private
  WORK_DIR. No existing behaviour assertion was removed.
- `worker/deno/tests/milestone_presync_git_test.ts`: retained the
  accepted-config test's hook marker, refusal/success and remote-SHA assertions.
  Its child-exit assertion and JSON decoding moved into the shared helper.
- `worker/deno/tests/git_operations_subprocess_test.ts`: both hostile ambient
  audit cases were red on the unfixed suite and green after the fix. Each child
  runs the four command tests, including both env-validation refusals. On Linux,
  both cases now unset DENO_DIR, link the populated cache under XDG_CACHE_HOME
  and assert their private default HOME cache stays empty. Other platforms
  retain the ambient cache configuration.
- Targeted `deno task test:unit` over those three files: all 15 tests passed;
  the wrapper failed its timing budget because both audit tests exceeded one
  second (1.44s and 1.41s on this host).
- Targeted `deno test --cached-only --frozen` with DENO_DIR unset, a populated
  XDG cache and an empty default HOME cache: passed, 15 tests. The default HOME
  cache remained empty, including during the accepted-caller-config test.
- Targeted `deno fmt --check`, `deno lint` and `deno check --frozen`: passed
  for the updated subprocess tests and shared cache helper.
- The cache helper's other callers (`babysitter_provider_choice_4738_test.ts`,
  `issue_assignment_test.ts` and `pr_summary_ci_workflow_3768_test.ts`): passed,
  66 tests. `deno task check:manifests`: passed, 876 tests and one ignored.
- Related isolation comments in
  `worker/deno/tests/support/no_host_git_config.ts` now explain the subprocess
  helper. The old summary's accepted residual is a historical record; this
  change removes it for the affected command tests.
- Shared copies: the presync invocation was extracted and both milestone suites
  call it. Both subprocess paths use `denoCacheEnv` and receive its XDG fix;
  no production rule or matcher changed.
- Before the cache-environment follow-up,
  `timeout 900 ./quality.sh < /dev/null` passed with skipped checks. Both full
  unit-test passes, lint, type check, formatting, completeness checks,
  markdownlint, Mermaid, semgrep and gitleaks passed.
- Before the cache-environment follow-up,
  `deno task pr-summary-check --base origin/main` with the issue body and labels
  passed, zero blocked and zero not checked.

## Merge verification

- Full quality-gate and verifier reruns for the cache fix, CI and independent
  PR review remain pending.

## Not checked and remaining risks

- Live journals were not accessed. CI and macOS execution were not run here.
- The focused unit-task timing-budget failure is recorded above; the 15 test
  assertions passed.
- The full gate skipped config integration
  (`deno or .config.json not available`) and Checkov (no pinned binary or cached
  container image available).
