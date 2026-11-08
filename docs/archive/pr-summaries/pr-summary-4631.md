## Summary

Repository ShellCheck CI policy now validates affected scripts before agent,
completion and PR-repair publication (CI fix, review feedback, spelling and
merge conflict, including repositories without configured pre-flight commands)
and fleet babysitter repairs. Configuration changes and removals revalidate
remaining tracked scripts. An unsupported policy, unreadable configuration and a
missing or mismatched tool block a push that changes a script, a ShellCheck
config or a ShellCheck workflow. WIP checkpoint, timeout-preservation and declared hand-off
pushes stay ungated. Closes #4631.

Version bump: none; no version file changed.

## Spec

### Intent and Rationale

- Catch repository ShellCheck diagnostics before publication, using CI's flags,
  exclusions, dialect and pinned version.
- Share the implementation between completion, hooks and repair publication
  without requiring configured pre-flight commands.

### Essential Design Decisions

- `runAffectedShellcheckChecks` in `pre_push_gate.ts` implements the supported
  `find . -name "*.sh" -type f -exec shellcheck … {} +` policy and the
  `ludeeus/action-shellcheck` step the worker syncs into Bash repositories
  (`scandir: .` and `severity` only, run as `--severity=<level>`; any other
  input or a workflow-level, job-level or step-level `SHELLCHECK_OPTS` override
  is unsupported). The action policy selects its named shell files and
  executable extensionless shell shebangs, with its default exclusions; the
  find policy selects `.sh` files. Symlinks are not execution targets, and a
  symlinked configuration fails closed. Discovery checks
  executable commands, including wrapped invocations, excluding logs, installation
  arguments, comments and script path arrays. Unsupported wrappers fail closed.
  YAML block headers accept trailing comments.
- Value-taking options (`-e -s -S -o -i -P -f -W` and their long forms,
  including `--opt=value` and attached `-Swarning`) consume their value instead
  of being read as positional arguments.
- A policy the gate cannot read fails a push when it changes a possible shell
  script, a ShellCheck config or a workflow that invokes ShellCheck. Unrelated
  pushes do not fail solely because of an unsupported workflow.
- The ShellCheck version probe is injectable (`readShellcheckVersion`, beside
  `findShellcheck`). An action-managed policy declares no version, so the probe
  result is not compared.
- The runner selects the nearest tracked repository `.shellcheckrc` or
  `shellcheckrc`, honours an explicit repository-relative rcfile, and otherwise
  uses `--norc`. Worker HOME, XDG and external ancestor configs cannot affect
  it.
- Touched paths retain configuration deletions; execution targets exclude
  deleted scripts. Unsupported policy, delegation, missing tools and version
  mismatches return incomplete infrastructure results rather than success.
  ShellCheck execution failures propagate the pre-flight result.
  The babysitter classifies structured gate infrastructure errors as
  infrastructure, preserving its substantive repair attempt budget.
- Opt-in, not blanket: `commitAndPushPending` Step 1b runs only when a
  pre-flight spec is passed, as before. The four PR-repair processors pass
  `resolveRepairPreFlightSpec`, which yields
  `{ commands: [], shellcheckOnly:
  true }` for a repo with no pre-flight
  commands, so Step 1b runs ShellCheck alone there. Callers that pass no spec
  (`wip_checkpoint.ts`, `run_wip_preservation.ts`, `declared_handoff.ts`,
  `pre_push_gate_retry.ts`) stay ungated, as `docs/pre-pr-ci-audit.md`
  documents. The babysitter's `validateAndCommit` checks staged repairs before
  committing. The blanket scan remains outside `quality_gate.ts`.

### Undiscoverable Facts

- #4625 originally added `publication_validation.ts` in commit `2350b1956`;
  commit `1f8d83a1` reverted it before this branch's base. That module is
  absent, so this change shares the existing pre-push runner and its extracted
  ShellCheck implementation; it does not reuse #4625's reverted module or depend
  on its restoration.
- Unit tests use a stub ShellCheck binary and version probe. Tests requiring a
  genuine diagnostic are in the integration manifest, require ShellCheck, and
  take the CI version from that binary.

## Evidence

This changes backend and CLI validation; there is no visual surface.

`pre_push_gate_test.ts` covers policy parsing, the synced ludeeus template,
value-taking options, the push-relevance rule and stub-driven runs. The
integration suites `shellcheck_gate_integration_test.ts` and
`shellcheck_publication_test.ts` cover real diagnostics, repair and WIP entry
points, the babysitter, missing-tool recovery and ambient configuration.

Read and updated the operator manual's **Agent pre-push hook and the
changed-files check** section in `docs/CONFIGURATION.md`.
`docs/pre-pr-ci-audit.md` (WIP checkpoint pushes "ungated on purpose") is true
again and unchanged. No second copy of the ShellCheck execution rule was found;
all publication paths call the same implementation.

## Test Plan

- `worker/deno/tests/pre_push_gate_test.ts`: policy tests derive the repository
  workflow's version and flags from its text and use a fixture version rather
  than a typed-in pin. Stub-driven runs cover config and nested-config rechecks,
  config deletion (`--norc` replaces `--rcfile`), commented YAML block headers,
  missing-tool recovery, version mismatch, the synced ludeeus template
  (`--severity=warning`) and unsupported action inputs. A non-shell push passes
  in a repo with the synced template, an unsupported action or a delegating
  script, and a script push in the unsupported case is still refused. The actual
  `WORKFLOW_SPECS` template is the fixture. Flagless find commands are checked,
  wrapped invocations are refused, and an unrelated workflow change passes.
  Action-selected `.bash` and executable shebang files are checked, script
  symlinks are skipped on changes and config rechecks, and inherited
  `SHELLCHECK_OPTS` is rejected for both policy forms. Real
  diagnostics (the actual repository workflow, dialect and exclusions, and a
  later edit invalidating a clean result) live in
  `worker/deno/tests/shellcheck_gate_integration_test.ts`.
- `worker/deno/tests/shellcheck_publication_test.ts`: a PR repair with
  `resolveRepairPreFlightSpec` leaves the remote unchanged on SC2086; a no-spec
  WIP checkpoint with the same diagnostic still pushes; the babysitter refuses
  its commit. Both repair entry points block with a missing binary, then
  revalidate after tool recovery and accept corrected content. All but the
  empty-input CLI test need the host ShellCheck. The entire suite is in the
  integration manifest and fails explicitly if the tool is unavailable. The
  babysitter missing-tool case also asserts its infrastructure classification.
- Call sites: `worker/deno/tests/pr_round_repo_formatters_test.ts` (feedback and
  CI fix), `worker/deno/tests/pr_merge_conflict_processor_test.ts` and
  `worker/deno/tests/pr_spelling_processor_test.ts` assert the spec each
  processor passes. Reverting a processor to `resolvePreFlightSpec` turned that
  processor's test red (feedback, CI fix, merge conflict and spelling each
  checked).
- Red checks: Step 1b made unconditional with a ShellCheck-only default → WIP
  test red (SC2086 blocks the push); `touchesShellcheckSurface` forced true →
  the unsupported-action and delegating-script non-shell tests red; policy
  failure forced to pass → the script-push refusal red; short value options cut
  to `es` → the value-option test red; version compared for a null policy
  version → the synced-template run red.
- Branch outcomes: relevant push with unsupported policy → refused
  (`pre_push_gate_test.ts` unsupported-action script push); irrelevant push with
  unsupported policy → passes (three non-shell tests); action policy with `null`
  version → probe not compared (synced-template run); `find` policy with a
  mismatched version → refused (mismatch test).
- The obsolete unit-suite behaviour conditionally skipped real-binary cases;
  those cases remain required in the integration manifest. Coverage is in
  `shellcheck_gate_integration_test.ts::runPrePushGate: a changed shell script is blocked through git_push with the actual repository workflow`
  and `shellcheck_publication_test.ts::commitAndPushPending: a WIP checkpoint with no spec still pushes a ShellCheck diagnostic`.
- The hand-copied synced workflow fixture is obsolete: the gate must accept the
  actual template as it evolves. The remaining policy and non-shell push paths
  use `workflow_definitions.ts` directly, covered by
  `pre_push_gate_test.ts::repoShellcheckPolicy: the worker's synced ludeeus template is a supported policy`
  and `pre_push_gate_test.ts::runPrePushGate: a non-shell push is not refused in a repo with the worker's synced ludeeus template`.
- The action's former `.sh`-only selection is obsolete; its other named shell
  files and executable extensionless shell scripts remain checked, while
  symlinks stay excluded. Coverage:
  `pre_push_gate_test.ts::ShellCheck action checks its scripts and skips symlinks on change and recheck`
  and `pre_push_gate_test.ts::runPrePushGate skips committed script symlinks on change and config recheck`.
- The manifest classifier's required-tool rule is covered by
  `integration_source_classifier_test.ts::integration classifier recognises a required real ShellCheck`.
