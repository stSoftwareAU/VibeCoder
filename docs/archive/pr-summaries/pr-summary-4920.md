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

- `readRepoFile` splits the path on `/` only (both `git ls-files` and `readDir`
  report `/`-separated names, and a backslash is an ordinary POSIX filename
  byte), then lstats every component below `repoRoot` (not `repoRoot` itself,
  which may legitimately be a link) and opens the same joined path. It requires
  a regular file, reads at most `MAX_REPO_FILE_BYTES` (1 MiB), and rejects
  absolute, empty, `.` and `..` segments. Splitting on backslashes too while
  opening the raw string previously let a decoy regular directory pass the lstat
  checks while the open followed a same-named backslash symlink out of the
  checkout.
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
  symlinked parent, backslash-named symlink beside a decoy directory, regular
  backslash-named file, unsafe paths, size cap (including the exact-cap positive
  case), NotFound, directory.
- `worker/deno/tests/pre_push_gate_test.ts`: `repoCiRunsCspell` and
  `loadDenoScopes` each refuse a symlink to a file outside the checkout and an
  oversized file, each with a regular-file positive control; `repoCiRunsCspell`
  also refuses a backslash-named symlink beside a decoy directory.
- `docs/audits/lib-sweep-coverage/top-up-4920.json`: registers the new module in
  the sweep ledger.

### Test change evidence

The review's path-confinement finding changed `readRepoFile`'s path handling,
so per CODING-STANDARDS.md TDD rule 3:

- Obsolete behaviour: splitting the relative path on both `/` and `\` for the
  lstat checks while opening the raw string, which let a decoy regular directory
  pass the checks while the open followed a same-named backslash symlink out of
  the checkout.
- Remaining behaviour: split on `/` only and open the same joined path, so every
  refusal the earlier PR added (symlink in any `/`-separated component,
  non-regular file, size cap, unsafe path) still holds, and a regular
  backslash-named file is now read correctly rather than reported unreadable.
- Covering tests: `tests/repo_file_read_test.ts::readRepoFile: a backslash-named
  symlink beside a decoy directory is refused`,
  `tests/repo_file_read_test.ts::readRepoFile: a regular backslash-named file is
  readable`, and `tests/pre_push_gate_test.ts::repoCiRunsCspell: a
  backslash-named symlink beside a decoy directory does not count`.

## Test Plan

- `cd worker/deno && deno task test:unit tests/repo_file_read_test.ts tests/pre_push_gate_test.ts tests/ci_mutation_contract_test.ts`:
  passed (109 parallel, 78 serial).
- Red check: with the split reverted to `/[\\/]/` and the open reverted to the
  raw string, the three new decoy/backslash tests (the two `repo_file_read_test.ts`
  cases and the `repoCiRunsCspell` case) fail — the decoy directory passes the
  lstats and the outside file's text is returned.
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
- Mutation check: the `relPath === ""` operand was dead (`"".split` gives
  `[""]`, which the empty-segment check already refuses), so it was removed. The
  oversize test now asserts the `within the size cap` message, which kills the
  `stat.size > maxBytes` mutant. The `""` path was already in the unsafe-path
  test. The decoy/backslash tests kill the `split` separator mutant (splitting
  on both separators again makes the decoy directory pass while the symlink is
  followed).
- `worker/deno/lib/repo_file_read.ts:45` exempt (untestable): the `!stat.isFile`
  operand after `Deno.open` guards only a file swapped for a non-regular one
  between the `lstat` and the `open`; that race cannot be triggered
  deterministically in a test, and the earlier `lstat` check at line 39 already
  refuses every non-regular file present at check time.
