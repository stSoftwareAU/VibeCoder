## Summary

Preserve host Git configuration for the repository-workflow test's real-checkout
`git ls-files -z` read, so configured `safe.directory` trust remains effective.
Check Git's exit status and include stderr on failure. Closes #5384.

## Spec

### Intent and Rationale

- The real checkout needs its configured ownership trust; the fixture Git helper
  deliberately suppresses global and system configuration.

### Essential Design Decisions

- Use a direct `Deno.Command` for this checkout read, retaining NUL-delimited
  parsing and the existing policy assertions.
- Keep the fixture Git helper and `NO_HOST_GIT_CONFIG` unchanged.
- Target `milestone/test-git-isolation`; skip dependency bumps for this
  milestone child.

### Undiscoverable Facts

- Reproduction used child-only `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`,
  `GIT_CONFIG_COUNT=0`, `GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_GLOBAL`
  pointing to a temporary file containing `safe.directory` for this checkout.
  Neither host configuration nor checkout ownership was changed.
- Plain Git under that configuration listed 6,252 tracked paths. The existing
  workflow test failed on the unfixed milestone base and passed after the fix.

## Evidence

- #5384: pre_push_gate_test.ts runs `git ls-files` on the real checkout with the
  host's git config shut out, so `safe.directory` is lost.
- `worker/deno/tests/pre_push_gate_test.ts` test
  `repoShellcheckPolicy: repository workflows distinguish execution from logging and script data`
  was run with `deno test --filter` under the reproduction environment above:
  before the fix, `fatal: detected dubious ownership`; after the fix, one
  passed.
- Removing the temporary trust entry made real Git exit 128 and the fixed test
  fail with that exit code and Git's ownership error in its assertion message.
- Test-only change; no visual surface changed.

## Test Plan

- Modified the existing repository-workflow test's checkout read. No policy
  assertions were removed: workflow-derived ShellCheck version, execution flags
  and the container-workflow null-policy check remain covered.
- From `worker/deno`,
  `deno task test:unit tests/pre_push_gate_test.ts tests/no_host_git_config_test.ts`:
  **224 passed, zero failed**. The latter is the existing Git-config and hostile
  hook isolation regression suite.
- Targeted `deno fmt --check`, `deno lint` and frozen `deno check` on
  `worker/deno/tests/pre_push_gate_test.ts`: passed.
- `timeout 900 ./quality.sh < /dev/null`: passed with skipped checks. Both unit
  passes, lint, type checking, formatting and the executed security checks
  passed. The initial 600-second invocation timed out during unit tests; it
  produced no final verdict.
- `deno task pr-summary-check` with the milestone base, issue body and labels:
  passed, zero blocked and zero not checked.
- Reviewed `CONTRIBUTING.md`'s local quality gate, `docs/CONTAINER.md`'s
  checkout trust explanation and `docs/CONTAINMENT.md`'s trust and inventory
  passages. Searches for the changed test, helper and trust setting found no
  stale manual contract. Documentation is the inline explanation and this
  summary. No twinned policy rule changed.

## Merge verification

- CI and independent PR review remain pending.

## Limitations

- Ownership was simulated using Git's test override; no actual foreign-UID
  checkout or macOS run was used.
- The gate skipped config integration (`deno or .config.json not available`) and
  Checkov (no pinned execution route available).
