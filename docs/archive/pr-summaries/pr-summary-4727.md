## Summary

The fleet PR babysitter cloned the target repository from scratch
(`gh repo clone … -- --no-checkout`) for every repair, so a large repository
such as GRQ could cross gh's 600 s limit. `cloneForRepair` now keeps one bare
mirror per repository under the babysitter state directory, fetches into it, and
clones the repair's checkout from it locally. Closes #4727.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

```mermaid
flowchart LR
    A[repair starts] --> B{mirror exists?}
    B -- no --> C[git clone --bare into .tmp, rename]
    B -- yes --> D[git fetch --prune heads and tags]
    C --> E[git clone --no-checkout --no-hardlinks mirror dir]
    D --> E
    E --> F[git remote set-url origin GitHub URL]
```

## Spec

### Intent and Rationale

- Only the first download of a repository is network-heavy; later repairs fetch
  new objects and copy locally, so the 600 s gh limit no longer decides the
  outcome. The bare mirror is built with git directly (30-minute bound) because
  gh's timeout is fixed.

### Essential Design Decisions

- The repair's clone is a full local clone with `--no-hardlinks`: the agent's
  checkout holds complete history (merge bases, `git diff` against the base)
  with no lazy fetch, and no object file is shared with the mirror, so nothing
  the agent does in its checkout can reach the mirror.
  `--reference`/`--dissociate` was not used because it contacts GitHub on every
  repair.
- `origin` is reset to the GitHub URL after the local clone (ssh when
  `gh config get git_protocol` says `ssh`, otherwise https), so the existing
  fetch and push steps in `fix` are unchanged.
- The mirror fetches `refs/heads/*` and `refs/tags/*` only, not the thousands of
  `refs/pull/*` refs a `--mirror` would carry.
- Serialisation is in-process per mirror (`SIMPLE-ON-PURPOSE` marker in the
  code); two babysitter processes sharing one state directory rely on git's own
  ref locks, and a failed fetch is retried next pass.

### Undiscoverable Facts

- The issue's "sandbox denies the host SSH key" constraint is why partial clones
  were not used; the mirror lives under
  `$XDG_STATE_HOME/vibe-coder/fleet-pr-babysitter/mirrors`, outside the agent's
  only write grants (clone and scratch directory, `buildBabysitterSandboxArgs`).

## Evidence

Backend-only change; no UI file is touched. Real git is run in temporary
directories against a local bare upstream (nothing is mocked except the remote
URL, which points at that local repository).

- `worker/deno/tests/fleet_pr_babysitter_test.ts`:
  - `failed clone is attempted once and preserves its original error`
  - `first repair clones full history from a local mirror, with origin reset to GitHub`
  - `a later repair fetches into the mirror and clones from it, without a second bare clone`
  - `a clone keeps its full history after the mirror is deleted`
  - `the clone copies its objects, so no object file is hardlinked to the mirror`
  - `a failed fetch keeps git's cause and leaves the mirror in place`
  - `a repository name that is not owner/name is refused before any git runs`
  - `concurrent repairs of one repo never mutate its mirror at the same time`
  - `defaultRemoteUrl follows gh's git_protocol, falling back to https with a warning`
  - `a later repair prunes deleted branches and fetches new tags into the clone`
  - `a stale partial download is cleared before the first download`
  - `the mirror root exists before the bare clone starts`
  - `every network git call is bounded by the 30-minute clone timeout`
  - `a call that arrives while another is queued still waits for the running fetch`
- `worker/deno/tests/fleet_babysitter_app_test.ts`
  (`production repair forwards CONFIG_PATH and denies canonical credential targets`)
  now asserts the real CLI clones `--bare` then `--no-checkout --no-hardlinks`
  and resets `origin` to `git@github.com:owner/repo.git` when gh reports `ssh`.
- Docs: `docs/workflows/fleet-pr-babysitter.md` gains a mirror paragraph beside
  the temporary-clone paragraph and a line in the state-directory paragraph.
  Sections read: temporary clones, sandbox profile, attempt records. The other
  clone mentions (lines 7, 102, 124, 131) still hold.
- Callers of `cloneForRepair`: only `fix` (`fleet_pr_babysitter.ts`), unchanged;
  it takes the default seams.
- Siblings checked: the other two `owner/repo` validators in the file
  (`withBabysitterWriteScope`, the repository-list check) keep the older
  dotted-owner pattern; they are not touched.

## Test Plan

- `deno task test:unit tests/fleet_pr_babysitter_test.ts` (from `worker/deno`):
  `tests/fleet_pr_babysitter_test.ts` (47 tests at head): 47 passed, 0 failed.
- Edited test `failed clone is attempted once and preserves its original error`:
  rewritten for the new `deps` argument (the old third argument was a gh
  runner). Removed from `worker/deno/tests/fleet_pr_babysitter_test.ts`:
  `assertEquals(attempts, 1)`
  - Replaced by:
    `assertEquals(calls.filter((args) => args.includes("clone")).length, 1)` in
    the same test; the rejection still asserts the original `clone timed out`
    message.
  - Required by: "downloading the whole history of the target repository each
    time" — the clone is no longer a gh call, so the count is of the git clone
    calls. Red check: retrying the bare clone gave two clone calls and the test
    failed.
- Red checks (each break applied, test run, then restored):
  - dropping `set-url` → first-repair test red;
  - skipping the fetch → later-repair test red (the failed-fetch test also red);
  - replacing `--no-hardlinks` with `--shared` → deleted-mirror test and
    first-repair test red; removing `--no-hardlinks` → the hardlink test red
    ("is hardlinked");
  - swallowing fetch errors → failed-fetch test red;
  - old `[\w.-]+` owner pattern → repository-name test red (`../x` passed it);
  - serialiser replaced by `Promise.resolve()` → concurrency test red.
- Mutation follow-up (each break applied, test run, restored): removing
  `--prune`, removing the tag refspec, `recursive: true` → `false` in
  `removeIfPresent`, deleting `removeIfPresent(partial)`, deleting the
  `Deno.mkdir(mirrorRoot)`, negating the `mirrorTails` clean-up condition, and
  dropping `timeoutSeconds` from the bare clone or the local clone each turned a
  test red. `defaultRemoteUrl` now takes a gh seam (default `runGhCommand`) and
  is exported for its test.
- Fixture mutations: the `gh config get git_protocol` branch now answers `ssh`
  and the `clone` branch records its argv (`clone-calls.log`) and the `set-url`
  branch records the URL it is given (`origin-url`), which the app test asserts,
  so replacing the return value or the matcher goes red. Mutation-check
  follow-up (PR #4730): the fixture's `mkdirSync` no longer passes
  `{ recursive: true }` (the code under test creates the mirror root first, so
  the flag was inert) and the `set-url` branch is one comparison,
  `args.slice(0, 3).join(" ") === "remote set-url origin"`, so no operand is
  droppable without turning the app test red (it reads `origin-url`). The
  `args.includes("--bare")` → true mutant remains exempt (untestable): it only
  makes the fake also create the already-existing local clone directory, which
  no observable behaviour distinguishes.
- Failure-reason test: the failed-fetch test asserts git's real stderr text
  (observed from real git) appears in the error.
- `deno task test:unit tests/fleet_pr_babysitter_test.ts
  tests/fleet_babysitter_app_test.ts`:
  `tests/fleet_pr_babysitter_test.ts` (47 tests at head) and
  `tests/fleet_babysitter_app_test.ts` (17 tests at head), all passed, 0 failed.
  `deno fmt --check`, `deno lint` and `deno check` on the changed files: clean.
- `./quality.sh`: the first run failed only in `deno tests` on
  `tests/fleet_babysitter_app_test.ts` ("production repair forwards CONFIG_PATH
  and denies canonical credential targets"), whose fixture
  `tests/fixtures/fleet_babysitter_repair_preload.ts` faked `gh repo clone` and
  now fakes `gh config get git_protocol`, `git clone --bare` and
  `git remote
  set-url`; that test passes after the fixture update. Two reruns
  of the full gate then passed every stage up to `deno tests` and were killed by
  the 590 s command cap there, so the final full gate did not complete.

<!-- vibe-quality-gate-skipped: full gate exceeded the 590 s command cap in `deno tests` on two reruns after the fixture fix; the touched suites, fmt, lint and type check pass; CI runs the full gate -->

Fixture edit: `tests/fixtures/fleet_babysitter_repair_preload.ts` — removed the
`gh repo clone` branch (no longer called by the code); no assertion removed.

## Known gaps

- Two babysitter processes sharing one state directory are not serialised across
  processes (git's ref locks decide; the next pass retries).
- A `.tmp` sibling left by an interrupted first download is removed before the
  next first download of that repository; it is not cleaned by
  `recoverTemporaryClones`.
