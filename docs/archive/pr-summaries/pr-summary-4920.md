## Summary

The pre-push gate no longer reads tracked workflows or `deno.json` through
symlinks out of the checkout, and no longer reads them without a size limit. One
shared helper, `readRepoFile` in `worker/deno/lib/repo_file_read.ts`, now does
this read. It replaces the private `readWorkflow` in `ci_mutation_contract.ts`
and the plain `Deno.readTextFile` calls in `repoCiRunsCspell` and
`loadDenoScopes`. Closes #4920.

Version bump: no `VERSION` change is part of this diff.

## Spec

### Intent and Rationale

- The same unbounded, symlink-following read was sent back in two PRs (#4744,
  #4898). Moving the bounded reader into one exported module stops each new
  reader re-inventing it.

### Essential Design Decisions

- `readRepoFile` lstats every component below `repoRoot` (not `repoRoot` itself,
  which may legitimately be a link), requires a regular file, and reads at most
  `MAX_REPO_FILE_BYTES` (1 MiB). It also rejects absolute, empty, `.` and `..`
  segments.
- A refusal throws; each caller keeps its existing catch path.
  `repoCiRunsCspell` skips that workflow. `loadDenoScopes` tries the next config
  name and otherwise leaves the root out, so its files are checked unfiltered.
  `findBlockingMutationJob` records the file as unreadable.
- The helper lives in its own module to avoid an import cycle between
  `pre_push_gate.ts` and `ci_mutation_contract.ts`.
- Not changed: the parent-directory symlink in `listPushedFiles` (#4909), which
  is a separate path.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. Tests:

- `worker/deno/tests/repo_file_read_test.ts`: regular read, file symlink,
  symlinked parent, unsafe paths, size cap (including the exact-cap positive
  case), NotFound, directory.
- `worker/deno/tests/pre_push_gate_test.ts`: `repoCiRunsCspell` and
  `loadDenoScopes` each refuse a symlink to a file outside the checkout and an
  oversized file, each with a regular-file positive control.
- `docs/audits/lib-sweep-coverage/top-up-4920.json`: registers the new module in
  the sweep ledger.

## Test Plan

- `cd worker/deno && deno task test:unit tests/repo_file_read_test.ts tests/pre_push_gate_test.ts tests/ci_mutation_contract_test.ts`:
  passed (106 parallel, 78 serial).
- Red check: with both `pre_push_gate.ts` call sites reverted to
  `Deno.readTextFile`, the four new `pre_push_gate_test.ts` tests (symlinked and
  oversized workflow, symlinked and oversized `deno.json`) fail.
- Existing `ci_mutation_contract_test.ts` still passes; no assertions were
  removed from any existing test.
- `deno fmt --check`, `deno lint` and `deno check` on the touched files: clean.
- Callers of the changed readers checked: `runPrePushGate` (`repoCiRunsCspell`,
  `loadDenoScopes`) and `repo_formatters.ts` (`loadDenoScopes`), both of which
  go through the same exported function.
- `./quality.sh` was run once on the first commit: every check passed except
  two. The completeness check (`tests/lib_sweep_coverage_test.ts`) wanted
  `repo_file_read.ts` claimed by a sweep slice; this PR adds
  `docs/audits/lib-sweep-coverage/top-up-4920.json` and that test now passes (39
  passed).
- The other failure was five `tests/pr_maintenance_command_test.ts` cases
  (`update-open-pr-branches ...`). The log shows
  `gh command skipped: GraphQL primary quota exhausted` on this host, so they
  depend on live GitHub quota, not on this change; the gate was not re-run in
  full after the slice was added.
