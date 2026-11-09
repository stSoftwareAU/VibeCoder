## Summary

Run the CI-fix post-agent quality check in the PR checkout and honour the
repository's `quality_command` and `skip_quality_check`. Closes #4805.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

The post-agent gate previously resolved `quality.sh`, its tool probe, command
cwd and Docker mount against the worker's own directory. It now binds those
operations to the PR checkout, keeping the check rather than deleting it.

### Essential Design Decisions

- `QualityGateParams.cwd` is optional; without it the existing shell caller
  retains its process-cwd behaviour. `bindQualityDepsToCheckout` applies the
  checkout to file checks, tool detection, command execution and Docker mounts.
- The CI-fix caller reads `skip_quality_check` and `quality_command` from the
  repository config. Commands without a path, such as `deno task test`, run
  without a file-existence check; a path-like first token is checked.
- Build-cache placement follows the child command's cwd.

### Undiscoverable Facts

- None. Issue #4907's production quality-instruction wiring is unchanged.

## Evidence

`worker/deno/lib/quality_gate_phase.ts` binds the dependencies to the checkout
and identifies command paths. `worker/deno/lib/pr_ci_processor.ts` supplies the
checkout and repository configuration. `docs/workflows/ci-fix.md` describes the
resulting post-agent check.

## Test Plan

- `worker/deno/tests/quality_gate_phase_test.ts` covers checkout resolution,
  Docker mounting, the no-cwd control, command paths and bare commands. Its
  filesystem test executes distinct checkout and worker scripts using an
  injected worker cwd, avoiding process-wide `Deno.chdir` while retaining the
  assertion that the checkout script runs. The direct spawn does not exercise
  the `agent` sudo path.
- `worker/deno/tests/pr_ci_processor_test.ts` covers the checkout cwd,
  configured command and skip setting, including committing remaining changes.
- The obsolete process-wide cwd mutation in the filesystem test was replaced
  because it races parallel tests. The required checkout-versus-worker
  behaviour remains covered by
  `worker/deno/tests/quality_gate_phase_test.ts::runQualityGateCheck - runs the checkout's quality.sh, not the worker's (Issue #4805)`;
  `worker/deno/tests/parallel_safety_cap_test.ts::parallel safety - no new test mutates process-wide state (Issue #880)`
  guards against reintroducing the mutation.
- Locally, those two test files passed together: 96 passed. The changed test
  file passed `deno fmt --check` and `deno lint`.
- CI shard 3 failed on the parallel-safety assertion before this fix. That
  assertion was reproduced directly before the fix and passed afterwards.
  The workflow command `.github/scripts/deno-test-shard.sh 2 4` initially
  could not create its temporary plan. With GNU `mktemp` and a writable temp
  directory it started, but stalled in a process-termination test after the
  sandbox refused `/bin/ps`; it was interrupted.
- `deno task check:manifests` passed (848 passed, one ignored). The local
  `quality.sh` passed its format, lint, type, Markdown and completeness stages;
  its parallel Deno test process panicked in the runtime, so its serial pass
  did not run. The Checkov probe timed out, and semgrep and config integration
  were skipped. The base PR #4941 passed its CI shards and Checkov job.
- Callers of `runQualityGateCheck` checked: `commands/quality_gate_phase.ts`
  passes no cwd, and `pr_ci_processor.ts` passes the checkout. No duplicate
  checkout-binding rule was found.
