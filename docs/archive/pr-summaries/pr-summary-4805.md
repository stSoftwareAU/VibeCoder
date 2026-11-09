## Summary

Run the CI-fix post-agent quality check in the PR checkout, honour the
repository's `quality_command` and `skip_quality_check`, and name the command
that actually ran in the retry prompt. Closes #4805.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

The post-agent gate previously resolved `quality.sh`, its tool probe, command
cwd and Docker mount against the worker's own directory. It now binds those
operations to the PR checkout, keeping the check rather than deleting it. The
retry prompt likewise names the command that actually ran instead of always
telling the retry agent to make `./quality.sh` pass.

### Essential Design Decisions

- `QualityGateParams.cwd` is optional; without it the existing shell caller
  retains its process-cwd behaviour. `bindQualityDepsToCheckout` applies the
  checkout to file checks, tool detection, command execution and Docker mounts.
- The CI-fix caller reads `skip_quality_check` and `quality_command` from the
  repository config. Commands without a path, such as `deno task test`, run
  without a file-existence check; a path-like first token is checked.
- `buildRetryPrompt` takes the command that ran (`runQualityGateCheck` passes
  its `qualityScript`; the CI-fix fallback passes the configured
  `quality_command`) and names it in the prompt, so a repository with no
  `./quality.sh` is not told to create one.
- Build-cache placement follows the child command's cwd.

### Undiscoverable Facts

- None. Issue #4907's production quality-instruction wiring is unchanged.

## Evidence

`worker/deno/lib/quality_gate_phase.ts` binds the dependencies to the checkout,
identifies command paths, and names the command in `buildRetryPrompt`.
`worker/deno/lib/pr_ci_processor.ts` supplies the checkout, repository
configuration, and the configured command to the gate and its retry prompt.
`docs/workflows/ci-fix.md` describes the resulting post-agent check.

## Test Plan

- `worker/deno/tests/quality_gate_phase_test.ts` covers checkout resolution,
  Docker mounting, the no-cwd control, command paths and bare commands, and
  the retry prompt naming a configured command. Its filesystem test executes
  distinct checkout and worker scripts using an injected worker cwd, avoiding
  process-wide `Deno.chdir` while retaining the assertion that the checkout
  script runs. The direct spawn does not exercise the `agent` sudo path.
- `worker/deno/tests/pr_ci_processor_test.ts` covers the checkout cwd,
  configured command, skip setting, and the retry prompt naming a configured
  command, including committing remaining changes.
- The obsolete process-wide cwd mutation in the filesystem test was replaced
  because it races parallel tests. The required checkout-versus-worker
  behaviour remains covered by
  `worker/deno/tests/quality_gate_phase_test.ts::runQualityGateCheck - runs the checkout's quality.sh, not the worker's (Issue #4805)`;
  `worker/deno/tests/parallel_safety_cap_test.ts::parallel safety - no new test mutates process-wide state (Issue #880)`
  guards against reintroducing the mutation.
- The `runCiFixWithQualityProbe` fixture previously set `workDir` and
  `workRoot` to the same directory, so the checkout-cwd assertion could not
  tell them apart. It now uses a distinct `workRoot` temp directory, so
  `worker/deno/tests/pr_ci_processor_test.ts::processCiFailure - the post-Claude quality check runs ./quality.sh in the PR checkout (Issue #4805)`
  fails if the code regresses to `processorDeps.workRoot`.
- Locally, the two test files passed together: 150 passed (96 in
  `quality_gate_phase_test.ts`, 54 in `pr_ci_processor_test.ts`). The changed
  files passed `deno fmt --check`, `deno lint` and `deno check`.
- Callers of `runQualityGateCheck` checked: `commands/quality_gate_phase.ts`
  passes no cwd, and `pr_ci_processor.ts` passes the checkout. No duplicate
  checkout-binding rule was found.
