## Summary

The entrypoint now gives each shared repository clone root the sticky bit
(`g+rwxs,+t`) and strips group/other write from the clone's git metadata at
every launch, then checks git ownership in worker-owned clones and quarantines
those with foreign metadata, leaving agent-owned tier-2 data siblings in place.
Closes #4737.

Version bump: `VERSION` is not edited by this change; the merged commit records
the final version.

## Spec

### Intent and Rationale

- Directory write lets the `agent` account (uid 1001) rename or unlink
  vibe-owned entries, including `.git`. The worker's git, under
  `safe.directory '*'`, would then read config and hooks from a substitute git
  directory. `+t` limits rename and unlink to the entry's owner, as the work
  root already does (Issue #1442).
- The sticky bit does not stop writes into `.git`, so the entrypoint also
  removes group/other write bits from `.git` and a linked worktree's `.git`
  pointer file.
- That chmod fails silently on files `agent` already owns (a `.git` swapped on a
  persistent volume before this fix). So the entrypoint also looks for any path
  within two levels of `.git` (so `.git` itself, `config`, `hooks` and its
  entries) not owned by the worker's uid. For a worker-owned clone it warns and
  moves the clone into a private random `.untrusted-<name>-*` directory. A
  failed move warns and disables clone access. Skipped when run as root.
  Both clone reuse paths refuse a foreign-owned root or `.git` before running git.

### Essential Design Decisions

- `safe.directory '*'` is kept. The worker's git needs it for mounted clones;
  the control prevents the untrusted account replacing or writing git metadata
  in worker-owned clones. Tier-2 sibling trust is tracked in Issue #4756.
- No broad chmod grants, and the untrusted-account drop is untouched. Group
  write on the clone stays, so quality-gate output (#4697, #4705 paths) still
  works.
- Cost accepted: `agent` cannot rename over a vibe-owned top-level file such as
  a lockfile.

### Undiscoverable Facts

- The entrypoint is the only place these modes are set, so a clone created after
  launch is covered only from the next launch (documented in
  `docs/CONTAINMENT.md`).

## Evidence

Backend/container change only; no UI files. Tests assert the mode bits that
produce the kernel's sticky-directory denial. They do not switch uid, so no real
rename denial was exercised.

```mermaid
flowchart LR
    A[agent runs repo code in clone] -->|rename .git| B{clone root sticky?}
    B -- no, before --> C[.git swapped; worker git trusts it]
    B -- yes, now --> D[denied: not owner]
    A -->|write into .git| E{metadata g/o-writable?}
    E -- stripped at launch --> D
```

## Test Plan

- Review fix: recheck ownership after setup's reuse probe and refuse a missing
  root in the lane's ownership check. Previously an absent or replaced path
  could be treated as reusable; trusted existing clones remain reusable.
  Coverage: `worker/deno/tests/clone_ownership_test.ts::setup refuses a clone planted after the entry check`
  and `worker/deno/tests/clone_ownership_test.ts::ensure refuses a clone that disappears after the directory probe`.
  Both failed before the fix. The mocked existing-clone fixture now supplies
  its ownership result; real trusted-clone coverage remains in
  `worker/deno/tests/ensure_repo_clone_test.ts::ensureRepoClone - default directory probe reuses a real clone untouched`.
  Both clone reuse paths were checked for the same missing-root decision. The
  broken-clone and corruption probes also check ownership before running Git;
  `worker/deno/tests/clone_ownership_test.ts::clone probes refuse a symlinked root before running git`
  covers both, while `worker/deno/tests/broken_clone_test.ts` covers trusted
  clone and recovery behaviour.

- CI repair: inject the Git runner into `setupRepo` so the fresh-clone
  ownership test can assert that no Git call follows a refusal without changing
  process-wide `PATH`. The safety cap test reproduced the CI failure before
  this change; it and the clone ownership tests pass afterwards (5 tests).
  The exact shard command `.github/scripts/deno-test-shard.sh 2 4` was
  attempted before and after the fix, but macOS `mktemp -t` writes outside
  this sandbox's writable directory and is denied. Linux CI runs the shard.
  No twin of the test's PATH mutation was found in this file.
  The local gate passed formatting, lint, type checking, Markdown lint,
  Mermaid and completeness checks; `deno task check:manifests` passed 847
  tests. Its parallel test pass hit the macOS Deno permission-pledge panic,
  so the serial pass did not run. Semgrep and the pinned Checkov were
  unavailable; config integration lacked configuration. All four unit
  shards passed on the base-producing PR's CI run 41555343824.

- Review fix: fresh clones are checked again before any subsequent git call;
  a foreign-owned clone is moved into a private quarantine and setup fails.
  The obsolete behaviour trusted the destination after cloning; trusted clones
  still proceed normally. The corrupt-clone and object-store recovery paths
  both use `setupRepo`. Coverage:
  `worker/deno/tests/clone_ownership_test.ts::fresh clone refuses and quarantines a foreign root before git`.
  The test failed before the guard because the second check was never made.

- Review fix: the shared-clone ref sweep checks ownership before running Git,
  records and logs refusals, and continues to sweep trusted clones. The
  obsolete behaviour ran Git in any path with a `.git` entry. Coverage:
  `worker/deno/tests/shared_clone_ref_sweep_test.ts::#4737 - foreign-owned clone is refused before git`
  injects a foreign uid into the shared check and asserts no Git call. The
  closed-milestone and milestone-sync checks use the same ownership policy.

- Review fix: closed-milestone housekeeping now checks clone ownership before
  any git call and logs and records a refusal. The obsolete behaviour ran git
  in any existing checkout; trusted checkouts remain eligible for sweeping.
  `worker/deno/tests/milestone_close_housekeeping_test.ts::sweepClosedMilestones - refuses a foreign-owned clone before git`
  injects a foreign uid into the shared ownership check and verifies no git
  invocation. The milestone sync twins already use the same ownership check.

- Review fix: both milestone maintenance entry points use the shared clone
  ownership check before running git, logging and skipping a refused clone.
  The obsolete behaviour reused any path with a `.git` entry; trusted clones
  remain eligible for sync and self-healing. Coverage:
  `worker/deno/tests/clone_ownership_test.ts::clone ownership refuses foreign and symlinked git metadata`.
  This exercises a foreign `.git` owner via injected `lstat`, a real symlink,
  and the logged refusal. Both former copies of the existence check now call
  the same helper.

- CI repair: bounded the default ownership check's `id -u` subprocess with a
  five-second timeout. A hung uid probe now reaches the existing error path
  instead of waiting indefinitely. The spawn-timeout source check flagged the
  previously unbounded command; `deno test --allow-all
  tests/spawn_timeout_check_test.ts` verifies the timeout rule.
- Review fix: test failed quarantine and access removal, foreign `.git` with a
  worker-owned root, and both clone reuse paths rejecting a foreign root.
  Both reuse paths call the shared ownership check before their git probes.
  Targeted tests: 125 passed; two existing setgid tests fail on macOS.
  Base Linux CI run 41555343824 passed all four shards and integration tests.
  Deno formatting, lint and repository-wide type checking passed.

- Review fix: quarantine only worker-owned clone roots, retaining agent-owned
  tier-2 data siblings. The new regression test simulates a foreign worker uid
  and verifies both directory and linked-worktree siblings remain in place; it
  failed before the fix. The quarantine test simulates foreign git metadata
  within worker-owned roots and still checks both forms. No twin was found for
  this ownership decision.
- Integration CI repair for PR #4754: derive the quarantine fixture's worker
  uid from `Deno.stat(dir).uid` instead of `Deno.uid()`. The integration runner
  grants file read access but no sys access to uid; no permission grants or
  assertions changed. The same test failed locally with `NotCapable` before
  the fix and passes afterwards with `deno task test
  tests/work_root_group_grant_test.ts --filter 'does not own'`.
  The exact workflow command, `setsid --wait deno task test:integration`, was
  attempted before and after the fix but cannot start on this macOS host
  because `setsid` is missing. The full file now has six passes and two
  host-specific setgid failures; both cases passed in this PR's Linux CI
  run 41584237838. Base-producing PR #4715 also passed all unit shards and
  integration tests in run 41555343824 (confirmed with `gh`).
  Local gate: type checking, lint, formatting, Markdown lint, Mermaid and
  completeness checks passed; `deno task check:manifests` also passed
  (847 tests). The full gate's parallel test pass panicked in Deno with
  `pledge test permissions called before restoring previous pledge`, so its
  serial pass did not run. Semgrep and Checkov were unavailable, and config
  integration was skipped because no local configuration was present.
  No twin of the fixture's `Deno.uid()` call needs changing.
- CI repair for PR #4754: kept the egress-proxy footprint phrase
  `opens no files and keeps no cache` on one line in `docs/CONTAINMENT.md`.
  Rewrapping had split the phrase and broken the existing documentation
  contract test; no runtime behaviour or tests changed. Reproduced with
  `deno task test tests/containment_docs_test.ts` (11 passed, 1 failed), then
  reran the same command after the fix (12 passed, 0 failed).
  The exact CI command, `.github/scripts/deno-test-shard.sh 2 4`, cannot start
  on this macOS host because `setsid` is unavailable; CI runs that shard on
  Linux after the babysitter commits the fix and this summary together.
  Local Markdown lint, Mermaid validation, manifest checks, type checking,
  lint and formatting passed. The full local gate's parallel test process
  panicked inside Deno 2.9.5 on macOS with `pledge test permissions called
  before restoring previous pledge`; its serial pass did not run. All four
  unit shards and integration tests passed on base-producing PR #4715
  (Actions run 41555343824). Semgrep and Checkov were unavailable locally;
  config integration had no local configuration and was skipped.
- `worker/deno/tests/work_root_group_grant_test.ts`: added tests for clone roots
  (sticky, group write, setgid, including a linked-worktree clone), for git
  metadata having no group/other write while staying readable, and for reserved
  names taking no sticky bit. The four existing tests are unchanged.
- Red checks: removing `,+t` fails the clone-root test; removing the
  `find`/`chmod` block fails the metadata test; removing only the `elif` file
  arm fails the metadata test on the linked clone; adding `+t` to the reserved
  branch fails the reserved-names test.
- `deno test` on this file and `container_entrypoint_test.ts`: 50 passed, 0
  failed.
- New test
  `a clone whose git directory the worker does not own is
  quarantined`: stubs
  `id` to report the fixture owner as the worker uid and uses a `find` stub
  to simulate foreign `.git` ownership. The real two-level ownership predicate
  is not exercised in the positive case. Both directory and linked-worktree
  clones leave their place inside private quarantine directories; a clone with
  no `.git` is untouched. Run after the fix: 51 passed, 0 failed on this file plus
  `container_entrypoint_test.ts`.
- `./quality.sh`: FAILED on the parallel deno-test pass with 4 failures
  unrelated to this diff: two Rust-formatter tests
  (`formatter should commit the Rust fix`), one test needing a JSR download
  (`@std/crypto/meta.json`, no network) and
  `tests/milestone_resolution_gate_test.ts`
  (`untrusted account cannot use ...`). The last also fails on the unmodified
  base (33 passed, 1 failed). All other stages passed, including markdownlint,
  semgrep, lint, type check and fmt.
- Callers and twins: grep found `g+rwxs` and `vibework` only in
  `container/entrypoint.sh` and `container/Containerfile`.

## Not done

- No real uid-switch test of the rename denial (needs root and a second
  account).
- Ownership is checked to two levels below `.git`; deeper foreign-owned files
  (for example under `objects/`) do not trigger quarantine, and are non-writable
  to `agent` only if the chmod could reach them.
- A clone whose `.git` is a symlink is not hardened.
- `find` over `.git` runs on each launch and can be slow on very large object
  stores.
