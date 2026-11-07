## Summary

Repository ShellCheck CI policy now validates affected scripts before agent,
completion and repair publication, including repairs without configured
pre-flight commands and fleet babysitter repairs. Configuration changes and
removals revalidate remaining tracked scripts. Unsupported policy, unreadable
configuration and missing or mismatched tools block validation. Closes #4631.

Version bump: none; no version file changed.

## Spec

### Intent and Rationale

- Catch repository ShellCheck diagnostics before publication, using CI's flags,
  exclusions, dialect and pinned version.
- Share the implementation between completion, hooks and repair publication
  without requiring configured pre-flight commands.

### Essential Design Decisions

- `runAffectedShellcheckChecks` in `pre_push_gate.ts` implements the supported
  `find . -name "*.sh" -type f -exec shellcheck … {} +` policy. Discovery checks
  executable commands, excluding logs, installation arguments, comments and
  script path arrays. YAML block headers accept trailing comments.
- The runner selects the nearest tracked repository `.shellcheckrc` or
  `shellcheckrc`, honours an explicit repository-relative rcfile, and otherwise
  uses `--norc`. Worker HOME, XDG and external ancestor configs cannot affect
  it.
- Touched paths retain configuration deletions; execution targets exclude
  deleted scripts. Unsupported policy, delegation, missing tools and version
  mismatches return incomplete infrastructure results rather than success.
  ShellCheck execution failures propagate the pre-flight result.
- `runPrePushGate` uses the shared implementation. `commitAndPushPending` gates
  unpushed commits even without a pre-flight spec, applying ShellCheck alone in
  that case. The babysitter's `validateAndCommit` checks staged repairs before
  committing. The blanket scan remains outside `quality_gate.ts`.

### Undiscoverable Facts

- #4625 originally added `publication_validation.ts` in commit `2350b1956`;
  commit `1f8d83a1` reverted it before this branch's base. That module is
  absent, so this change shares the existing pre-push runner and its extracted
  ShellCheck implementation; it does not reuse #4625's reverted module or depend
  on its restoration.
- The behavioural tests use the available ShellCheck 0.11.0 binary, matching
  `.github/workflows/validate-scripts.yml`.

## Evidence

This changes backend and CLI validation; there is no visual surface.

`pre_push_gate_test.ts` covers this repository's actual validate-scripts
workflow and container-build workflow. `shellcheck_publication_test.ts` covers
both repair entry points with real SC2086 diagnostics, missing-tool recovery,
the CLI under `--no-config`, and conflicting ambient configuration.

Read and updated the operator manual's **Agent pre-push hook and the
changed-files check** section in `docs/CONFIGURATION.md`. Updated affected API
comments to describe ShellCheck validation without a pre-flight spec. No second
copy of the ShellCheck execution rule was found; all publication paths call the
same implementation.

## Test Plan

- `pre_push_gate_test.ts`: direct policy assertions pin unsafe paths, workflow
  filtering, explicit failure discriminants and messages, delegated execution,
  unsupported actions/commands/options, working directories, version pins,
  missing rcfile values, `-rc`, comments and version probes. A real diagnostic
  blocks through the existing `git_push.ts` caller with the actual repository
  workflow. Commented YAML block headers and root/nested config deletion also
  block on SC2086.
- The ShellCheck fixtures put the earlier documentation commit on the remote
  before adding scripts. The old fixture unintentionally required markdownlint
  for ShellCheck-only tests; `pre_push_gate_test.ts` still covers the separate
  Markdown blocking path in `runPrePushGate: doc-only push blocked by failing
  markdownlint`, while the clean-script and recovery tests exercise ShellCheck
  without that unrelated tool. With markdownlint absent, the suite reproduced
  the three CI failures before the repair and passed all 72 tests afterwards.
- `shellcheck_publication_test.ts`: unconfigured repair publication leaves the
  remote unchanged on SC2086; the babysitter refuses its commit. Both entry
  points block with a missing binary, then revalidate diagnostics after tool
  recovery, and accept corrected content. The real CLI accepts this repository's
  workflows with empty hook input and rejects SC2086 despite HOME, XDG and
  external ancestor suppression files.
- In a disposable checkout of the original head, `f2a18ae1`, the two changed
  ShellCheck test files produced 65 passes and 13 failures. Those failures
  reproduce workflow discovery, the existing git/CLI caller regressions, YAML
  block comments, root/nested config deletion, both repair entry-point
  diagnostic and missing-tool checks, and ambient configuration suppression.
  Both files pass with the fixes. The eight-file targeted suite passed all 147
  tests, including completion, pre-flight, babysitter and hook coverage.
- Reapplying 41 targeted mutations to the policy validation and replacement
  comment/version guards made a test fail in every case, against a passing
  unmutated baseline. This is targeted evidence for the reported survivors, not
  a claim that the entire diff received a mutation sweep.
- The reported empty-path operand was unreachable after rcfile value validation;
  it was removed. The empty-line operand was redundant with invocation
  recognition and was removed when command discovery was corrected. Comment and
  version-probe guards are pinned by direct policy tests. No mutation exemption
  is claimed.
- `./quality.sh < /dev/null`: passed before the CI fixture repair, including the
  full Deno suite, lint, type-check, formatting, Markdown lint, Semgrep and
  completeness checks. Config integration and Checkov were skipped by the gate.
- `deno task check:manifests`: 848 passed, 0 failed, 1 ignored.
- The CI shard was retried after the fixture repair, but this host's sandbox
  denied `/bin/ps` during process-tree tests, preventing the shard from
  completing. The affected test file passed separately; CI runs the full shard.
- `deno task pr-summary-check --base origin/main ../../docs/archive/pr-summaries/pr-summary-4631.md`:
  0 blocked; closure, independent review and reproduction status were not
  checked because no issue-body file or labels were supplied.
- Markdown lint and `git diff --check` passed.
