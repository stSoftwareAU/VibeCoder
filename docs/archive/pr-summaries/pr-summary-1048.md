# A squash-style main → milestone sync silently resurrects files main deleted

## Summary

The milestone sync raises a `sync/milestone-*` PR when a ruleset refuses its
direct push, and armed that PR with `gh pr merge --auto --squash`. Squashed,
the sync commit carries `main`'s content under a single parent, so `main` is
never an ancestor of the milestone branch: every later merge computes its base
from before the sync, and a deletion `main` made in the meantime arrives as a
modify/delete conflict rather than a deletion. The conflict resolver then took
the branch's side, because `git checkout --theirs` cannot produce a version
that was deleted and the working-tree copy got staged instead. That is how 1984
lines of the fleet-health subsystem returned to `milestone/863`.

Three independent defences, so no one of them has to be perfect. Closes #1048.

1. **The sync lands as a merge commit.** `mergeMethodFlagForHead` answers
   `--merge` for a `sync/milestone-*` head and `--squash` for every other PR;
   `pr_auto_merge.ts`, `direct_merge.ts` and `commands/pr_manager.ts` all route
   their `gh pr merge` through it.
2. **Modify/delete resolves as a delete.** `merge_conflict_stages.ts` reads
   `git ls-files -u` per conflicted path: no incoming stage means the default
   branch deleted the file, so the resolution is `git rm`. Every deletion is
   named in the sync's outcome; a path whose stages cannot be read fails the
   whole resolution rather than being guessed at.
3. **A resurrection is detected directly.** `resurrected_file_check.ts` and the
   `check-resurrected-files` command report every file present on a branch,
   absent on the default branch, and deleted by the default branch — where
   either the deleting commit is already in the branch's ancestry, or the
   branch's own commits put the file there. The `milestone-resurrection` CI job
   runs it on PRs into `milestone/*` and on the milestone → `main` rollup PR.

```mermaid
gitGraph
    commit id: "shared base"
    branch milestone/863
    checkout main
    commit id: "delete subsystem"
    checkout milestone/863
    merge main id: "sync (merge commit)"
    commit id: "milestone work"
    checkout main
    commit id: "more main work"
    checkout milestone/863
    merge main id: "later merge: deletion is history"
```

### One human step remains

`stSoftwareAU/VibeCoder` has `allow_merge_commit: false`, so GitHub refuses
`--merge` here. The worker therefore arms the sync as a squash **with a warning
naming the setting** (`squashedSyncWarning`) rather than stalling the branch or
downgrading quietly. Changing the setting needs repository-administration
scope, which the run does not have (`gh api -X PATCH repos/…` returned 404), so
it is recorded in stSoftwareAU/VibeCoder#1161 for a human. Until it is flipped,
defence 3 is what catches the consequence in this repo.

## Evidence

Backend/CLI only — no web interface to screenshot. The evidence is the fixture
tests and the live audit.

**Live audit of every milestone branch** (Acceptance criterion 4), with the
command this PR adds:

```
$ for b in $(git branch -r | grep origin/milestone/); do
    deno run --allow-read --allow-env --allow-run worker/deno/mod.ts \
      check-resurrected-files --repo-dir . --branch "$b" --default-branch origin/main
  done
```

| Milestone branch | Branch-only files | Verdict |
| --- | --- | --- |
| `milestone/1076-resolve-worker-pr-merge-conflicts-without-nee` | 0 | clean |
| `milestone/722-codex-on-ubuntu-with-podman-setup-sh-and-launc` | 353 | **1 resurrection** |
| `milestone/933-extension-framework-for-private-per-deployment` | 0 | clean |
| `milestone/ci-gates-and-repository-rulesets` | 16 | clean |
| `milestone/configuration-one-source-of-truth` | 5 | clean |
| `milestone/container-image-build` | 0 | clean |
| `milestone/fleet-throughput-keep-every-slot-busy` | 0 | clean |
| `milestone/launcher-and-host-resilience` | 12 | clean |
| `milestone/pr-phase-custom-labels` | 0 | clean |
| `milestone/test-suite-trustworthiness` | 1 | clean |

The one finding is reported in stSoftwareAU/VibeCoder#1160:
`worker/deno/tests/fixtures/provider_env.ts` on `milestone/722`, deleted on
`main` by `db9383dd` (#1079). The 353 branch-only files on that same branch are
a branch that is merely behind, and are correctly **not** reported — the
negative direction the issue asks for.

**Full gate:** `./quality.sh` — `Result: PASSED (with skipped checks)`; the
skips are `config integration`, `pages-liquid` and `mermaid built output`,
which need toolchains absent from this container.

## Reproduction

- **symptom** — a file `main` deleted came back on `milestone/863` after a
  squash sync, because the modify/delete conflict was resolved by keeping the
  file
- **status** — `verified` — with `resolveTowardsIncoming` forced to
  `"take-incoming"` (the pre-fix behaviour: `checkout --theirs` fails, `add`
  stages the branch's own copy), the regression test fails with the file still
  in the tree; with the fix it passes
- **regression test** —
  `worker/deno/tests/milestone_sync_ancestry_test.ts::syncMilestoneBranchWithDefault - a file the default branch deleted stays deleted`

The detector is pinned separately against the exact live shape —
`worker/deno/tests/resurrected_file_check_test.ts::findResurrectedFiles - names a file a squash sync let the milestone branch revive`
builds a temp repo, deletes on `main`, squash-syncs, edits the file on the
branch, merges keeping it, and asserts the check names the file and the
deleting commit.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the main → milestone sync produces a merge commit with main as a
  parent — evidence: `worker/deno/lib/milestone_sync_pr.ts::mergeMethodFlagForHead`,
  wired at `worker/deno/lib/pr_auto_merge.ts`, `worker/deno/lib/direct_merge.ts`
  and `worker/deno/commands/pr_manager.ts`; asserted by
  `worker/deno/tests/merge_method_arming_test.ts` on all three paths and by
  `worker/deno/tests/milestone_sync_ancestry_test.ts::syncMilestoneBranchWithDefault - leaves the default branch an ancestor of the milestone branch`
  — reviewer: partial — reason: the reviewer saw the diff before the last two
  commits and named two real holes — `pr_manager` arming without a head ref,
  and no handling of a repo that forbids merge commits. Both are fixed here:
  `pr_manager` now reads the head on both routes and errors rather than
  defaulting, and a repo that refuses `--merge` gets a squash with a warning
  naming the setting, tracked for a human in stSoftwareAU/VibeCoder#1161.
- **met** — a file deleted on main and present on a milestone branch fails a
  check that names the file and the commit that deleted it — evidence:
  `worker/deno/tests/check_resurrected_files_command_test.ts::check-resurrected-files - fails and names the file and deleting commit`
  — reviewer: partial — reason: the reviewer reproduced the squash window (a
  branch that re-added the file before any later merge) and showed the
  ancestry-only rule reported it clean. The rule is widened here to the union
  of ancestry and the branch's own work, pinned by
  `resurrected_file_check_test.ts::findResurrectedFiles - catches the squash window, before any later merge`;
  it is what found the live `milestone/722` finding.
- **met** — the check runs on PRs into a milestone branch and on the milestone
  → main PR — evidence: the `milestone-resurrection` job in
  `.github/workflows/validate-scripts.yml`, whose trigger already covers
  `[Develop, main, milestone/*]` and whose `if:` fires when either the base or
  the head is a `milestone/*` branch — reviewer: partial — reason: the reviewer
  is right that it reports rather than blocks: it is in `EXEMPT_CONTEXTS`
  because a job with an `if:` cannot be a required check on `main` without
  blocking every ordinary PR on a check that never reports. The criterion as
  stated is "runs"; making it a required context is a ruleset change
  (`infra/rulesets/main.json`) that belongs to whoever owns the milestone
  rulesets, not to this fix.
- **met** — existing milestone branches are audited and any resurrection
  reported — evidence: the table above, and stSoftwareAU/VibeCoder#1160 for the
  one finding — reviewer: missing — reason: the reviewer saw only the diff,
  which cannot contain a live audit; the audit was run here and its result is
  recorded above and in the follow-up issue.
- **met** — `./quality.sh` passes — evidence: full gate run after the final
  edit, `Result: PASSED (with skipped checks)` — reviewer: partial — reason:
  the reviewer could not run the full gate from a diff and ran targeted suites
  instead; it was run here and passed.
- **unrequested** — `EXEMPT_CONTEXTS` gains a `milestone-resurrection` entry
  (`worker/deno/lib/pr_check_contexts.ts`) — reviewer: unrequested — reason:
  the repository's own gate (`tests/pr_check_contexts_test.ts`) requires every
  job that runs on a `main` PR to be required or carry a recorded reason; a new
  conditional job cannot be added without one.
- **unrequested** — the deletion note is spliced into the sync's outcome
  message (`worker/deno/lib/git_pull.ts`) — reviewer: unrequested — reason: a
  file the sync deletes must not be deleted silently; the note is how the
  operator log names it.
- **unrequested** — `pr_manager` reads the PR head before arming auto-merge —
  reviewer: unrequested — reason: without it that route squashes a milestone
  sync, so the criterion above would not hold on the CLI path.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — catch-and-ignore on the head-ref lookup — evidence:
  `worker/deno/commands/pr_manager.ts:265` (reviewed revision) — reason: fixed
  here; `fetchHeadRefName` throws, so an unreadable head is an error rather
  than a silent squash of a milestone sync.
- **violation** — `checkout --theirs` and `add` exit codes discarded in the new
  resolver — evidence: `worker/deno/lib/git_pull.ts:453` (reviewed revision) —
  reason: fixed here; both are checked and a failure returns `takeSideError`,
  which refuses to commit a resolution that would keep this branch's side.
- **violation** — `buildRemovePathArgs` had no tests — evidence:
  `worker/deno/lib/git_conflict_args.ts:58` — reason: fixed here; three cases
  added to `worker/deno/tests/git_conflict_args_test.ts`, including the
  dash-leading filename.
- **violation** — the new command had no test file — evidence:
  `worker/deno/commands/check_resurrected_files.ts` — reason: fixed here;
  `worker/deno/tests/check_resurrected_files_command_test.ts` covers the
  failing verdict, the clean verdict, the missing `--default-branch` refusal
  and the unreadable-repository path.
- **violation** — the merge-method change was untested on all three arming
  paths — evidence: `worker/deno/lib/pr_auto_merge.ts`,
  `worker/deno/lib/direct_merge.ts`, `worker/deno/commands/pr_manager.ts` —
  reason: fixed here; `worker/deno/tests/merge_method_arming_test.ts` asserts
  the `gh` argv each path produced, in both directions.
- **violation** — docs still stated `--squash` as absolute — evidence:
  `docs/INTERNALS.md:1697`, `docs/MERGE.md:232`, `docs/MERGE.md:45`,
  `docs/MERGE.md:311`, `worker/deno/lib/direct_merge.ts:523` and `:808` —
  reason: fixed here; every surface now names the milestone-sync exception.
- **violation** — no PR summary — evidence: `docs/archive/pr-summaries/` —
  reason: fixed here; this file.
- **violation** — DRY: `git_conflict_resolution.ts::resolveFiles` picks a side
  without reading stages — evidence:
  `worker/deno/lib/git_conflict_resolution.ts:103` — reason: stands. That is
  the rebase resolver, and it stages nothing when `checkout --<side>` fails, so
  it stalls the rebase rather than reviving a file — a different, already-loud
  outcome, and changing it is outside this issue. The claim in
  `merge_conflict_stages.ts` was narrowed to say so rather than overstate.
- **clean** — Australian English throughout; `assertSafeGitRef` on both refs
  before any git process starts, with a test proving no git runs for an
  option-shaped ref; `--` end-of-options before every untrusted path and
  pathspec; pathspecs batched to bound argv; the workflow job is SHA-pinned,
  checks out with credentials not persisted, runs `--frozen --lock`, and
  inherits read-only `contents` permission; no hidden paths staged; both new
  lib modules added to the `docs/INTERNALS.md` module table; every commit
  carries its `Vibe-Coder-Run-Id` trailer.

## Test Plan

Added:

- `worker/deno/tests/resurrected_file_check_test.ts` — 9 tests over real temp
  repositories: the exact `milestone/863` shape; the squash window before any
  later merge; legitimately-new files not reported; a branch merely behind not
  reported; a re-delete clearing the report; an unknown ref failing loud; an
  option-shaped ref refused before git runs; both parsers.
- `worker/deno/tests/milestone_sync_ancestry_test.ts` — the ancestry assertion
  after a real sync; a file the default branch deleted stays deleted; an
  ordinary content conflict still takes the default branch's side; the sync PR
  arms `--merge`; a repo that forbids merge commits gets a loud squash.
- `worker/deno/tests/merge_method_arming_test.ts` — `enableAutoMerge` and
  `directMergePr` pick their method from the head branch, in both directions;
  the loud downgrade; `isMergeCommitNotAllowed` and `squashedSyncWarning`.
- `worker/deno/tests/merge_conflict_stages_test.ts` — stage parsing including a
  path with spaces, and the resolution decision in both directions.
- `worker/deno/tests/check_resurrected_files_command_test.ts` — the command's
  verdicts and its two refusals.

Modified:

- `worker/deno/tests/git_conflict_args_test.ts` — three cases for
  `buildRemovePathArgs`.
- `worker/deno/tests/mod_test.ts` — command count 146 → 147, with a membership
  assertion for `check-resurrected-files`.

No existing test was removed or disabled.
