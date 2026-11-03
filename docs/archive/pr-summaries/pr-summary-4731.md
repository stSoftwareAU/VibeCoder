## Summary

The babysitter runner no longer exchanges the PR description or Codex's final
message through paths the repair agent can write, and it no longer reads
agent-written files through a symlink, a special file or an unbounded read.
Closes #4731.

```mermaid
flowchart LR
    A[Codex agent] -- writes --> C[".babysitter-pr-body in clone"]
    X["Codex CLI (outside profile)"] -- --output-last-message --> E["runner-owned exchange dir"]
    R[Runner] -- no-follow, size-bounded read --> C
    R -- no-follow, size-bounded read --> E
    R -- O_EXCL write pr-body.md --> E
    E -- gh pr edit --body-file --> G[GitHub]
```

## Spec

### Intent and Rationale

- The runner is unsandboxed, so any write or read it makes at a name the agent
  can write is a way for a prompt-injected agent to use the runner's privileges.
  Trusted writes now go to a directory only the runner can write; the one file
  the agent must still write is read through a hardened reader.
- Deno has no `O_NOFOLLOW`/`O_NONBLOCK`, so the reader extends the existing
  `readTextFileNoFollow` (lstat, open, fstat identity) rather than adding a
  copy.

### Essential Design Decisions

- New `lib/fleet_babysitter_exchange.ts`: `createExchangeDir` (canonical, 0700),
  `readAgentOutput` (name check, directory is a real canonical directory, then
  `readTextFileNoFollow`), `writeExchangeFile` (`createNew`, 0600).
- `readTextFileNoFollow` gains optional `maxBytes`, `openTimeoutMs` and an
  `open` seam, a descriptor regular-file check, and a `dev` check beside `ino`.
  The descriptor must have at most one hard link and match both the pre-open
  and post-open path identities (inode and device).
  One-argument callers behave as before, apart from the extra descriptor checks.
- `spawnBabysitterAgent` and `startBabysitterAgent` take a required
  `responseFile`; spawn refuses a relative path or one inside the clone or
  scratch directory.
- Unsafe output throws before any PR description is applied or review dismissed.
  Because the head is already recorded as attempted, it is not retried on that
  host until the state file is removed (documented).

### Undiscoverable Facts

- That Codex writes `--output-last-message` from outside the agent's permissions
  profile is taken from the issue comments and was not checked against an
  installed Codex; the docs say to confirm it per host.
- With `openTimeoutMs` set, the reader opens read-write, preventing a FIFO
  raced in before the open from blocking on Unix; the descriptor check refuses
  it. This requires write permission. Other stalled opens are abandoned after
  the timeout and their descriptors are closed if they later complete. A
  pending open can keep a process alive; non-watch passes explicitly exit after
  cleanup, while watch mode continues with the open pending.

## Evidence

Backend only. The retry session named in the issue is not on `main`; the only
response read is the initial one in `fix`, now `readAgentResponse`.

Call sites changed: `takePrBodyProposal` (`.babysitter-pr-body`), `applyPrBody`
(both callers in `fix`), `readAgentResponse` (`fix`),
`spawnBabysitterAgent`/`startBabysitterAgent` (all callers, including
`worker/deno/tests/fleet_babysitter_app_test.ts`). Callers of
`readTextFileNoFollow` (`gh_wrapper.ts`, `gitignore_enforcer.ts`,
`graft_context.ts`, `codegraph_context.ts`) pass no options; their tests are run
below.

Docs: `docs/workflows/fleet-pr-babysitter.md` (exchange directory paragraph and
the write-grants sentence).

The sweep top-up records merge base
`0a4d803ab862753bd35fcf39f5df4b3c91545504` as `sweptAt`, following the
workflow's default-branch ancestry requirement. The previous feature-branch
commit failed `Sweep ledger sweptAt ancestry` in PR #4752 and in the local
reproduction. After repointing, the exact workflow command passes:
`deno run --frozen --lock=deno.lock --allow-read --allow-env --allow-run mod.ts sweep-drift --repo ../.. --default-branch origin/main`
from `worker/deno`. No runtime code or tests changed in this CI repair.

CI repair validation: 39 `lib_sweep_coverage_test.ts` tests and 13
`sweep_drift_command_test.ts` tests pass. `deno task pr-summary-ci --base main
--head-branch issue-4731-babysitter-runner-follows-agent-planted-symlinks-w`
reports no blocked gates (closure, independent review and reproduction are
not checked without issue context). The local quality gate passes completeness,
markdownlint, Mermaid, lint, type checking, formatting and its static checks.
Semgrep and Checkov are unavailable locally; config integration has no local
configuration. The full parallel unit pass cannot finish: host Deno 2.9.5 on
macOS panics in `cli/ops/testing.rs` with "pledge test permissions called before
restoring previous pledge"; the repository pins 2.9.8. The serial pass therefore
does not run. All four CI test shards passed on the latest merged main PR
#4742 (Actions run 41550561600), confirmed through `gh`.

## Test Plan

New: `worker/deno/tests/fleet_babysitter_exchange_test.ts` (13 tests: symlink,
FIFO, hard link, oversize, exactly-at-cap, replaced parent directory, bad names,
open timeout, O_EXCL write over a planted link), 8 cases in
`worker/deno/tests/file_utils_test.ts`, and in
`worker/deno/tests/fleet_pr_babysitter_test.ts` the `takePrBodyProposal`
symlink/FIFO/oversize cases, `readAgentResponse` ok/absent/symlink/oversize,
`spawnBabysitterAgent` response-file refusals and three `applyPrBody` tests.

Edited expectations: the spawn-args test now expects `--output-last-message` at
the exchange `responseFile` (was `${dir}/.babysitter-response`); the other spawn
tests and five `startBabysitterAgent` calls gained `responseFile`; three
`takePrBodyProposal` tests use a canonical temp directory. No assertion was
removed.

Red checks (each reverted): `takePrBodyProposal` via `Deno.readTextFile` →
symlink test red; `--output-last-message` back inside the clone → spawn-args
test red; responseFile guard removed → refusal test red; `applyPrBody` writing
with `Deno.writeTextFile` → planted-symlink test red; `maxBytes` pre-check
removed and the open-timeout race removed → their `file_utils_test.ts` cases
red. Review repair adds an open-seam device-stat test with the same inode and
a different device; removing the device comparisons makes it fail.

Review repair for PR #4752 also adds real hard-link and regular-file rename
races between lstat and open. Both tests fail before the fix. The reader now
refuses multiple links on the opened descriptor and checks it against the
original lstat as well as the fresh one. The production CLI repair fixture
writes a PR body proposal and records the actual `gh pr edit --body-file`
path and contents. It asserts that staging is outside both write grants
(clone and scratch). Changing `fix()` back to scratch staging makes this
end-to-end test fail. Existing assertions remain intact; no tests were removed.

The latest review repair exercises the real non-watch CLI with a FIFO swapped
into a read-only open, leaving a genuine pending open after the timeout. The
child exits with the failure after cleanup; without the explicit exit it times
out. The operator documentation and reader JSDoc describe the residual open.
The four affected suites pass (135 tests), as do whole-tree Deno formatting,
lint and type checking. No existing assertions were removed.
The local full gate passed its static checks but the parallel unit pass hit
the host Deno permission-pledge panic; the serial pass did not run. Base CI
run 41550561600 passed all four test shards. Semgrep and the pinned Checkov
version were unavailable locally; config integration had no configuration.

The subsequent review repair tests a real FIFO swapped into the open in a child
Deno process and requires the child to refuse it and exit. The test failed with
the prior read-only open; the bounded reader now opens read-write on Unix.
The file-utils and exchange suites pass (47 tests); formatter, lint, whole-tree
type check and Markdown checks pass. The full gate's parallel tests hit the
host Deno 2.9.5 permission-pledge panic described below; the serial pass did not
run. Base CI run 41550561600 passed all four test shards. Semgrep is absent and
the installed Checkov does not match the CI pin, so those local scans skipped.

Review-repair validation: the four targeted babysitter and file-utils suites
pass (134 tests), as do the shared reader's gh-wrapper and gitignore-enforcer
callers (52 tests). `deno task check:manifests` passes (847 tests).
The full `./quality.sh < /dev/null` passes completeness,
formatting, lint, whole-tree type checking, Markdown, Mermaid and static
checks. Its parallel unit pass crashes in host Deno 2.9.5 on macOS with
`pledge test permissions called before restoring previous pledge`; the serial
pass consequently does not run. Semgrep and Checkov are not installed, and
config integration has no local configuration. All four test shards pass in
base PR #4742's CI run 41550561600, verified with `gh`; all current PR #4752
checks are also green. The summary CI command reports zero blocked gates
(three issue-context gates not checked). No tests or checks were weakened.

Implementation-session results before the CI repair: `deno task test:unit` for `file_utils_test.ts` (30
passed), `fleet_babysitter_exchange_test.ts` (13 passed),
`fleet_babysitter_app_test.ts` and `fleet_pr_babysitter_test.ts` (69 passed, 1
failed: `babysitter default heartbeat resolves its checkout revision`, which
fails the same way on base `0a4d803a` because `jsr.io/@std/crypto` cannot be
fetched in the sandbox), `gh_wrapper_test.ts` and `gitignore_enforcer_test.ts`
(52 passed). `deno fmt --check`, `deno lint`, `deno check` pass on the touched
files.

Implementation-session `./quality.sh`: every stage passes (completeness checks, lint,
type check, fmt, semgrep, markdownlint) except `deno tests` (parallel pass),
which fails two tests in files this change does not touch:
`fleet_pr_babysitter_test.ts` "babysitter default heartbeat resolves its
checkout revision" (cannot fetch `jsr.io/@std/crypto`; it fails the same way on
base `0a4d803a`) and `milestone_resolution_gate_test.ts` "verifyResolvedTree -
the repository's own task sees only the allowlisted environment" (untrusted
`/tmp` account; not re-run on base). The serial pass did not run because the
parallel pass failed. A first gate run also failed `lib_sweep_coverage_test.ts`
for the new module; `docs/audits/lib-sweep-coverage/top-up-4731.json` fixes
that.

## Mutation and coverage carry-over checks

Both checks reported "failed to run", not a surviving mutant or an uncovered
line: they require the touched test files to pass on a clean baseline, and
`fleet_pr_babysitter_test.ts` "babysitter default heartbeat resolves its
checkout revision" fails there and at the merge base `0a4d803a`, because
`lib/stream_identity.ts` imports `jsr.io/@std/crypto`, which the sandbox cannot
fetch. Re-run on the final head: 87 passed, 1 failed (that test only). No
mutation was listed as unpinned, so no test was added for these items; they need
a runner with `jsr.io` access, or `skip_mutation_check` and
`skip_coverage_carryover_check` for this repo.
