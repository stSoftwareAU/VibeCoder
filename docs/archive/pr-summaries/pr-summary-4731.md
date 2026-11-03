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
- A FIFO swapped in between the lstat and the open blocks `open(2)`; the reader
  gives up after `openTimeoutMs` (5 s) and closes the abandoned descriptor, but
  the blocked thread cannot be cancelled.

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
red. The `dev` comparison is not testable on one filesystem (unreached).

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
