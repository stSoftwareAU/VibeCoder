# 🔎 Security sweep — the stale-verdict ladder's rebase rung (`conflict_rebase_rung.ts`)

**Issue:** [#2279](https://github.com/stSoftwareAU/VibeCoder/issues/2279)
(chunk top-up-2279) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2279:

- `worker/deno/lib/conflict_rebase_rung.ts` — added by #2279.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record. The module is
claimed by **top-up-2279**, and this file is the reading of it.

## `worker/deno/lib/conflict_rebase_rung.ts`

One exported async function (`runRebaseRung`) and one exported pure builder
(`buildSquashCommitMessage`). The module runs git through an **injected**
runner — it constructs no `Deno.Command` itself — and touches neither the
network nor the filesystem directly. It is the only module in the ladder that
rewrites a remote branch, so the sweep is mostly about what reaches git's argv
and what licences the force-push.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `branchName` | GitHub's head ref — **attacker-influenceable** on a fork PR | never a bare positional: it reaches git only through `buildPushArgs`, which runs `assertSafeGitRef` and inserts `--end-of-options` (CWE-88, Issue #12). It is also interpolated into the lease flag, which `buildPushArgs` places *before* that separator |
| `baseBranch` | the PR's base branch | reaches git as `origin/<base>` through `buildRebaseArgs` (`assertSafeGitRef` + `--end-of-options`) and as a `commit-tree -p` value; a dash-leading value is refused by the same assertion before any git runs |
| `oldHead` | the sha `gh pr view` reported | trimmed, lower-cased and checked against `isConflictHeadSha` (`^[0-9a-f]{7,40}$`) **before the first git call**; an unusable value throws with nothing run |
| `git commit-tree` stdout | git | re-checked with `isConflictHeadSha` before it can be reset to or pushed — git's own output is not trusted to be a sha |
| `stderr` / `stdout` of a failed command | git | folded into error messages and the `push-refused` detail. The detail reaches a PR comment through the `gh` body chokepoint, which redacts secrets (`redactGhBodyArgs`) |

| Property | Result |
| -------- | ------ |
| spawn chokepoints | none of its own — every git call goes through the injected runner, which the caller wires to `runGitCommand` (`git_timeout.ts`), so the timeout, credential-helper and message-redaction chokepoints all still apply |
| ref-argv safety | `push` and `rebase` argv come from `git_ref_args.ts`; the remaining argv (`rev-parse`, `diff`, `reset`, `commit-tree`, `rebase --abort`) carry no attacker-derived positional — only validated shas and fixed flags |
| filesystem | none |
| network | only git's own push, through the injected runner |
| regex safety | none — the module builds no `RegExp`; the one pattern it relies on (`isConflictHeadSha`) is a fixed literal in `merge_conflict_markers.ts` |
| commit message | built by `buildSquashCommitMessage` from the base branch name and a validated sha, and carries the `Vibe-Coder-Run-Id` trailer. It reaches git as a `-m` value, which `runGitCommand` redacts before the process starts (Issue #1284) |
| fail direction | every fault restores `OLD` and throws; a spawn failure is folded into exit 1 so "could not run git" can never read as success; a rebase failure with **no** unmerged paths refuses the fallback rather than hiding a broken clone behind a green push |
| secret surface | holds no credential and emits none |

## The invariant this module exists to hold

**Every outcome leaves the branch at `OLD` or at a head whose tree equals
`OLD`'s.** That is what keeps the rung inside the resolver's
no-destructive-force-push contract (Issues #1076, #4373): nothing is pushed
until `git diff --quiet OLD NEW` exits 0, so the push provably replaces a
commit graph and no file content. The fallback's identity holds by
construction — its tree *is* `OLD`'s — and is asserted anyway, because "by
construction" is a claim about code and the push is irreversible.

The second half is the lease. The push is always
`--force-with-lease=<branch>:<OLD>`, never a bare `--force`, so a branch that
moved on the remote since GitHub judged it refuses the push instead of being
overwritten. `conflict_rebase_rung_test.ts` and
`pr_merge_conflict_processor_test.ts` both assert the lease is present and that
no bare force is.

## The caller contract this module cannot enforce

Two things the rung takes on trust from its caller
(`pr_merge_conflict_processor.ts`):

- **`origin/BASE` is already an ancestor of `OLD`.** The processor establishes
  this with `git merge-base --is-ancestor` before the ladder runs at all. It is
  what makes the fallback safe — `OLD`'s tree already contains the base, so
  carrying it whole cannot lose a base change. Called on a branch that is
  genuinely behind, the fallback would silently drop the base's commits from
  the graph while keeping a tree that never had them.
- **The PR is fleet-authored.** The processor gates the rung on
  `isFleetAuthor` with a *positive* attribution (an unreadable author declines),
  and `assertPushTargetAllowed` refuses a push to the read-only default branch
  before the rung starts. The rung itself would rewrite whatever branch it is
  handed.

Both are documented in the module's header and asserted at the call site.

## Verdict

**Swept, no findings.** One injected-runner git routine with no spawn,
filesystem, network or secret surface of its own; every ref reaches git through
the validated builders; git's own output is re-validated before it is pushed;
and the one irreversible action is gated on a proven tree identity and a pinned
lease.
