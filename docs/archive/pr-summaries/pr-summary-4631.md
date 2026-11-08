## Summary

Repository ShellCheck CI policy now validates affected scripts before agent,
completion and PR-repair publication (CI fix, review feedback, spelling and
merge conflict, including repositories without configured pre-flight commands).
The fleet babysitter is not covered: running ShellCheck there would execute a
host tool beside the babysitter App key, so its check waits for the contained
repair path (#4768, #4770) and its repairs are not ShellCheck-validated by this
change. Configuration changes and removals revalidate remaining tracked scripts.
An unsupported policy, unreadable configuration and a missing or mismatched tool
block a push that changes a script, a ShellCheck config or a ShellCheck
workflow. WIP checkpoint, timeout-preservation and declared hand-off pushes stay
ungated. Closes #4631.

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
  executable extensionless shell shebangs, with its default exclusions; the find
  policy selects `.sh` files. Targets with a symlink in any path component are
  excluded, and a configuration with a symlink in any component fails closed.
  Symlinked workflows are ignored; delegated scripts with symlinked components
  are refused. Workflow, delegated-script and ShellCheck configuration reads are
  capped at 1 MiB (`readBoundedPolicyFile`). Discovery joins shell line
  continuations and checks executable commands, including wrapped invocations,
  excluding logs, installation arguments, comments and script path arrays.
  ShellCheck container images, including registry prefixes and digests, and
  shell `-c` invocations with preceding or clustered options are detected as
  unsupported. Unsupported wrappers fail closed. YAML block headers accept
  trailing comments.
- Value-taking options (`-e -s -S -o -i -P -f -W` and their long forms,
  including `--opt=value` and attached `-Swarning`) consume their value instead
  of being read as positional arguments.
- A policy the gate cannot read fails a push when it changes a possible shell
  script, a ShellCheck config or a workflow that invokes ShellCheck. Unrelated
  pushes do not fail solely because of an unsupported workflow. Extensionless
  paths count only when executable and carrying a shell shebang; deleted paths
  do not count. `listPushedFiles` uses `--diff-merges=dense-combined`, so a
  merge commit contributes only the paths the merge itself changed (a conflict
  resolution or a fix folded into the merge). Files a merge merely brings in
  from the base are not in scope for the gate, Step 1b or the repo formatters.
- The ShellCheck version probe is injectable (`readShellcheckVersion`, beside
  `findShellcheck`). An action-managed policy declares no version, so the probe
  result is not compared.
- The runner selects the nearest tracked repository `.shellcheckrc` or
  `shellcheckrc`, honours an explicit repository-relative rcfile, and otherwise
  uses `--norc`. Worker HOME, XDG and external ancestor configs cannot affect
  it.
- Touched paths retain configuration deletions; execution targets exclude
  deleted scripts and paths whose parent has become a file. Unsupported policy,
  delegation, missing tools and version mismatches return incomplete
  infrastructure results rather than success. ShellCheck execution failures
  propagate the pre-flight result.
- Opt-in, not blanket: `commitAndPushPending` Step 1b runs only when a
  pre-flight spec is passed, as before. The four PR-repair processors pass
  `resolveRepairPreFlightSpec`, which yields
  `{ commands: [], shellcheckOnly:
  true }` for a repo with no pre-flight
  commands, so Step 1b runs ShellCheck alone there. Callers that pass no spec
  (`wip_checkpoint.ts`, `run_wip_preservation.ts`, `declared_handoff.ts`,
  `pre_push_gate_retry.ts`) stay ungated, as `docs/pre-pr-ci-audit.md`
  documents. The babysitter's `validateAndCommit` is unchanged. The blanket scan
  remains outside `quality_gate.ts`.

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
points, missing-tool recovery and ambient configuration.

Updated the pre-push hook manual in `docs/CONFIGURATION.md` (which now states
the babysitter is not ShellCheck-validated) and the README.
`docs/pre-pr-ci-audit.md` keeps its "ungated on purpose" WIP statement, and its
non-merge wording now says merges contribute only the paths they changed. No
second copy of the ShellCheck execution rule was found; all publication paths
call the same implementation.

## Test Plan

- `pre_push_gate_test.ts::ShellCheck policy bounds workflow and delegated script reads`
  covers symlinked workflows and scripts and oversized policy files;
  `pre_push_gate_test.ts::unsupported ShellCheck policy ignores Dockerfile but blocks executable shell shebang`
  covers non-shell, executable shell and deleted extensionless paths.
  `shellcheck_publication_test.ts::commitAndPushPending: merge resolution with a ShellCheck diagnostic is refused`
  exercises a real conflicting merge and verifies the remote remains unchanged.
  The former missing-workflow assertion expected a `readfile` error; inspection
  now fails earlier at `lstat`, while the missing workflow remains a policy
  error, covered by
  `pre_push_gate_test.ts::repoShellcheckPolicy: invalid policies return explicit errors`.

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
  `SHELLCHECK_OPTS` is rejected for both policy forms. Real diagnostics (the
  actual repository workflow, dialect and exclusions, and a later edit
  invalidating a clean result) live in
  `worker/deno/tests/shellcheck_gate_integration_test.ts`.
- `pre_push_gate_test.ts::ShellCheck discovers continued commands and refuses indirect invocations`
  covers continued `find` commands, registry-prefixed and digest container
  images and shell `-c` calls with preceding or clustered options.
  `pre_push_gate_test.ts::runPrePushGate selects nearest tracked config and respects explicit rcfile`
  checks root and nested config selection and an explicit policy rcfile;
  `shellcheck_gate_integration_test.ts::runPrePushGate applies tracked config to real ShellCheck diagnostics`
  checks SC2086 is suppressed with the tracked config and rejected without it.
  `pre_push_gate_test.ts::ShellCheck skips scripts under symlinked parents and missing directory paths`
  covers changed paths through a symlinked parent and a directory replaced by a
  file;
  `pre_push_gate_test.ts::ShellCheck refuses a configuration below a symlinked directory`
  covers configuration ancestors. The former treatment of symlinked parents and
  `NotADirectory` as executable or fatal is obsolete; regular in-tree scripts
  remain checked by the existing action and find policy tests above.
- `worker/deno/tests/shellcheck_publication_test.ts`: a PR repair with
  `resolveRepairPreFlightSpec` leaves the remote unchanged on SC2086; a no-spec
  WIP checkpoint with the same diagnostic still pushes. The repair entry point
  blocks with a missing binary, then revalidates after tool recovery and accepts
  corrected content. All but the empty-input CLI test need the host ShellCheck.
  The entire suite is in the integration manifest and fails explicitly if the
  tool is unavailable.
- `worker/deno/tests/git_push_preflight_test.ts`:
  `commitAndPushPending - no preFlight spec: WIP checkpoint with a ShellCheck diagnostic still pushed (PR #4898 review)`
  is the hermetic (no ShellCheck binary) WIP case; forcing Step 1b to run with a
  ShellCheck-only default turned it red (`ShellCheck version mismatch`).
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
  and
  `shellcheck_publication_test.ts::commitAndPushPending: a WIP checkpoint with no spec still pushes a ShellCheck diagnostic`.
- The hand-copied synced workflow fixture is obsolete: the gate must accept the
  actual template as it evolves. The remaining policy and non-shell push paths
  use `workflow_definitions.ts` directly, covered by
  `pre_push_gate_test.ts::repoShellcheckPolicy: the worker's synced ludeeus template is a supported policy`
  and
  `pre_push_gate_test.ts::runPrePushGate: a non-shell push is not refused in a repo with the worker's synced ludeeus template`.
- The action's former `.sh`-only selection is obsolete; its other named shell
  files and executable extensionless shell scripts remain checked, while
  symlinks stay excluded. Coverage:
  `pre_push_gate_test.ts::ShellCheck action checks its scripts and skips symlinks on change and recheck`
  and
  `pre_push_gate_test.ts::runPrePushGate skips committed script symlinks on change and config recheck`.
- The manifest classifier's required-tool rule is covered by
  `integration_source_classifier_test.ts::integration classifier recognises a required real ShellCheck`.
- The merged base's expectation that repairs without configured pre-flight
  commands receive no spec is obsolete. The fix verifier still runs and spelling
  repairs still receive their push guarantee; both now receive the
  ShellCheck-only spec. Coverage:
  `pr_feedback_review_dismissal_3383_test.ts::review-fix verifier - persistent findings stay outstanding without push or dismissal, and the PR stays armed (Issue #4291)`
  and
  `pr_side_gate_guarantee_4876_test.ts::prSpellingProcessorCommand - prompt budget and push checks with no pre-flight (Issue #4876)`.
- PR #4898 review round:
  `pre_push_gate_test.ts::listPushedFiles: a merge lists the paths it resolved, never the files it brings in from the base (PR #4898 review)`
  merges a base commit carrying a ShellCheck-failing `base_bad.sh` into a branch
  with its own `own.sh` and a conflict on `c.txt`; only `c.txt` and `own.sh` are
  listed. Restoring `--diff-merges=first-parent` turned it red. The existing
  `shellcheck_publication_test.ts` merge-resolution SC2086 test still refuses
  the push.
  `pre_push_gate_test.ts::ShellCheck refuses an oversized configuration without reading it`
  uses a sparse 1 MiB + 1 byte `.shellcheckrc`; restoring `Deno.readTextFile`
  turned it red. The babysitter `validateAndCommit` tests and the
  `gateStagedShellcheck` helper (which only they and one assertion used) were
  removed with the babysitter call.
