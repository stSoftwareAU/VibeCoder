## Summary

The pre-commit safety gate refused every hidden path missing from the
worker's canonical allowlist (`ALLOWED_HIDDEN_PATHS`), even a file the
repo's own `.gitignore` re-allows and tracks on purpose. That made #3293
fail twice, on `.claude/skills/review-fleet-prs/SKILL.md`, `run.sh` and
`review_log.ts`. The gate now also exempts a refused hidden path when an
ancestor-directory walk finds an explicit `!`-negation decided by the
repo's tracked, unmodified root `.gitignore` itself, **and** that root
`.gitignore` is byte-identical to `.gitignore` on the local
`origin/<default>` ref (Issue #3309 hardening and its PR #3308 review
follow-up — a re-allow committed only on the branch under review, never
published on the repo's own default branch, no longer exempts anything).
Secret patterns and credential-store paths (`FORBIDDEN_STAGED_PATTERNS`)
are never exempt this way, and every failure to read the answer leaves the
path refused. `REQUIRED_GITIGNORE_PATTERNS` is not widened. Closes #3296.

- [x] Failing real-repo regression test first (verified red on base)
- [x] `gitignoreReallowed` helper, wired into `assertSafeToCommit`
- [x] Fail-closed seam and stub tests; every guard broken on purpose
- [x] Docs sweep across the standards, security and merge manuals
- [x] Spec and Standards reviews
- [x] Full `./quality.sh`

## Spec

### Intent and Rationale

- A repo may track hidden files of its own: this repo re-allows
  `.claude/skills` and `.claude/agents` (#2675, #2976). The repo's own
  `.gitignore` already records that choice, so the gate reads it rather
  than growing a second list.
- `ALLOWED_HIDDEN_PATHS` stays the worker's canonical fleet-wide list. A
  per-repo opt-in must not widen what every other repo accepts.

### Essential Design Decisions

- The exemption is the last one in `assertSafeToCommit`, after the
  `mergedInUnchanged` and default-ref exemptions. `classifyStagedPath` is
  unchanged, so its other callers keep the strict answer.
- The `.gitignore` must exist at `HEAD` (`cat-file -e HEAD:.gitignore`),
  its index must match `HEAD` (`diff --cached --quiet HEAD -- .gitignore`)
  and its working tree must match `HEAD`
  (`diff --quiet HEAD -- .gitignore`). The index check catches a
  staged-only edit whose working-tree file has been put back (Issue #3309
  hardening of the gap noted in Standards Review below).
- An ancestor-directory walk finding an explicit `!`-negation decided by
  the root `.gitignore` itself is the only exempting answer. No decision
  anywhere in the chain, a decision from a nested or untracked
  `.gitignore`, a non-negation decision, or a spawn failure leaves the
  path refused (Issue #3309). A `run` test seam exists only because
  `runGitCommand` reports a timeout as `ok:true` with code 124.
- `HEAD:.gitignore`'s blob must also equal `origin/<default>:.gitignore`'s
  (PR #3308 review follow-up to #3309). `.gitignore` is itself on
  `ALLOWED_HIDDEN_PATHS`, so a worker commit could carry an agent's
  `!`-negation and a later commit on the same branch then stage the path
  it re-allows — without this check the repo's own choice would be
  decided by the branch under review, not by what the repo's default
  branch actually publishes. `originDefaultRef` (already used by the
  #2774 exemption) gained a test-seam `run` parameter so this check shares
  it. An unresolvable `origin/HEAD`, a missing `.gitignore` on either ref,
  or a mismatched blob all leave nothing exempt (fail closed).
- `assertAdoptedMergeIsSafe` (`worker/deno/lib/milestone_merge_state.ts`)
  is deliberately excluded: an agent-committed merge stays held to the
  strict classifier plus `mergedInUnchanged`.

### Undiscoverable Facts

- `--no-index` is load-bearing. Without it, `check-ignore` reports any
  *tracked* path as not ignored, so every tracked hidden file would be
  exempt.
- `-z` without `--stdin` is fatal in `check-ignore`, so paths are checked
  one call each.
- `.git/info/exclude` and `core.excludesFile` can only add ignores, never
  re-allow, and `gitignore_enforcer.ts` never writes `info/exclude`.
  Reading them through `check-ignore` therefore cannot widen the
  exemption.
- The ancestor-walk and root-source requirement (Issue #3309) closes the
  risk that a bare `check-ignore` exit 1 would otherwise cover a hidden
  path no rule mentions, or a path re-allowed by an untracked nested
  `.gitignore`. The previously-noted residual risk — the gate read
  `.gitignore` at `HEAD` only, so a re-allow committed earlier on the same
  branch (never published on the repo's default branch) would still
  count, since `.gitignore` is itself on `ALLOWED_HIDDEN_PATHS` — is now
  closed by the `origin/<default>` blob-match requirement above (PR #3308
  review follow-up).

## Evidence

Backend-only change: no UI file is touched.

```mermaid
flowchart TD
    S[staged hidden path refused by classifyStagedPath] --> M{merged-in or published unchanged?}
    M -->|yes| OK[accepted]
    M -->|no| F{matches FORBIDDEN_STAGED_PATTERNS?}
    F -->|yes| R[refused]
    F -->|no| G{.gitignore tracked at HEAD and unmodified?}
    G -->|no or unreadable| R
    G -->|yes| C{ancestor walk: root .gitignore !-negation?}
    C -->|found| OK
    C -->|no decision, other source, or spawn failure| R
```

Observed `git check-ignore` against this repo's `.gitignore`:

```text
$ git check-ignore -q --no-index -- .claude/skills/review-fleet-prs/SKILL.md; echo $?
1
$ git check-ignore -q --no-index -- .claude/settings.local.json; echo $?
0
$ git check-ignore -q --no-index -- .env; echo $?
0
$ git check-ignore -v -n --no-index -- .claude/skills/review-fleet-prs/SKILL.md; echo $?
::	.claude/skills/review-fleet-prs/SKILL.md
1
```

The code no longer treats a bare exit 1 as sufficient: it also requires the
deciding rule found by the ancestor walk to be a root-`.gitignore`
`!`-negation, not just the exit code (Issue #3309), and requires that root
`.gitignore` to match `origin/<default>`'s copy (PR #3308 review
follow-up).

- `worker/deno/tests/pre_commit_safety_gitignore_reallow_3296_test.ts`: 28
  tests. Real-repo fixtures (built as an upstream-plus-clone pair, so
  `origin/<default>` is configured and matches `HEAD` by construction)
  cover the acceptance criteria and the `.gitignore` guards, including the
  branch-only-reallow and no-origin cases. Stub tests cover a spawn
  failure, an unexpected exit code, an unresolvable `origin/HEAD`, and a
  `HEAD`/`origin/<default>` blob mismatch.
- That file, `worker/deno/tests/pre_commit_safety_test.ts` and
  `worker/deno/tests/hidden_files_safety_integration_test.ts`: 86 passed,
  0 failed. `deno fmt --check`, lint and check are clean.
- **Docs sweep** — grep: `ALLOWED_HIDDEN_PATHS`, `classifyStagedPath`,
  `REQUIRED_GITIGNORE_PATTERNS`, `hidden path`, `Pre-commit safety gate`,
  `allowlist`; section: `docs/MERGE.md#read-only-default-branch` (the
  staged-path gate's exemption bullets) and `SECURITY.md` "Configuration
  File (.config.json)" (the `assertSafeToCommit()` exemption paragraphs);
  updated: `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md`,
  `SECURITY.md`, `docs/MERGE.md`, `docs/THREAT-MODEL.md` (C26),
  `prompts/coding_guidelines/prompt.md`, and the module and helper doc
  comments in `worker/deno/lib/pre_commit_safety.ts`. `README.md` and
  `docs/CONFIGURATION.md`: no hits. Still true:
  - `docs/AGENT-ACCOUNTABILITY.md:729` — still true because it describes
    the enforcer's allowlist, which is unchanged;
  - `worker/deno/lib/git_push.ts:453` — still true because it describes
    worker state files, which no repo re-allows;
  - `worker/deno/lib/milestone_merge_state.ts:188` — still true because
    the adopted-merge check keeps the strict classifier.

  The hits in `milestone_conflict_ladder.ts:247`,
  `milestone_gate_repair.ts:246`, `preserved_wip_branch.ts:29`,
  `session_manager.ts:134`, `worker_state_paths.ts:6` and
  `commands/git_operations.ts:518` name the gate without saying what it
  accepts, so they stay true.
- Related existing rules checked: Commit Safety in
  `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` ("Never
  stage or commit hidden files", the five-entry allowlist, "If a hidden
  file legitimately needs to be tracked, raise an issue first"), the
  `SECURITY.md` hidden-file controls, and `docs/THREAT-MODEL.md` C26. Each
  now names the per-repo opt-in and keeps the secret patterns absolute. I
  applied the reworded rule to this PR's own diff: it stages no hidden
  path at all, so nothing is flagged.
- Pre-existing, out of scope: `DESIGN-PRINCIPLES.md` omits `.vscode/`;
  `CODING-STANDARDS.md:967` has an MD018-style line.

## Reproduction

- Symptom: `assertSafeToCommit` refused
  `.claude/skills/review-fleet-prs/SKILL.md` in a repo whose `.gitignore`
  re-allows `.claude/skills` (#3293, twice).
- Status: verified. On base `416fd710`, `classifyStagedPath` returned
  `violation` for `SKILL.md`, `.claude/settings.local.json` and `.env`,
  and no later exemption applied.
- Regression test: "assertSafeToCommit - an edited committed SKILL.md
  passes when the repo's own .gitignore re-allows .claude/skills (Issue
  #3296)" failed on base and passes after the fix.

## Test Plan

- Removed assertions: none. `makeSkillRepo` in
  `pre_commit_safety_gitignore_reallow_3296_test.ts` was changed from a
  plain `git init` fixture to an upstream-plus-clone pair (so
  `origin/<default>` exists and matches `HEAD`); every existing test using
  it was re-run and still reaches its original assertion (see below).
- New file `worker/deno/tests/pre_commit_safety_gitignore_reallow_3296_test.ts`
  (28 tests; 4 added for the PR #3308 review follow-up). The existing
  tests expecting the hidden-path refusal were re-run and still reach it:
  `worker/deno/tests/pre_commit_safety_test.ts` and
  `worker/deno/tests/hidden_files_safety_integration_test.ts` (86 passed
  in total).
- Named tests checked with `git ls-files` from the repository root: all
  three are tracked.
- Full `./quality.sh < /dev/null` re-run on this head after the PR #3308
  review follow-up: see the PR reply for the actual outcome of this run.

**Branch outcomes:**

- `worker/deno/lib/pre_commit_safety.ts:310` forbidden filter: reached by
  "never exempts a FORBIDDEN_STAGED_PATTERNS path" and ".env,
  .config.local.json and key.pem stay refused even when the repo's
  .gitignore re-allows them". Dropping the filter turned 2 red.
- `worker/deno/lib/pre_commit_safety.ts:311` empty candidates: reached by
  "empty candidates short-circuits without running git".
- `worker/deno/lib/pre_commit_safety.ts:320` `.gitignore` not at `HEAD`:
  reached by "an untracked .gitignore exempts nothing", "no .gitignore at
  all exempts nothing" and "a non-repo cwd (check-ignore cannot run)
  exempts nothing".
- `worker/deno/lib/pre_commit_safety.ts:325` `.gitignore` modified:
  reached by "a working-tree-modified .gitignore exempts nothing" and "a
  staged-modified .gitignore exempts nothing". Bypassing both guards
  turned 4 red.
- `worker/deno/lib/pre_commit_safety.ts:332` check-ignore cannot run:
  reached by "a check-ignore call that cannot run at all exempts
  nothing". Treating `!ok` as exempt turned it red.
- `worker/deno/lib/pre_commit_safety.ts:333` exit 1 exempts: reached by
  "exempts a path check-ignore reports as not ignored (exit 1)", the
  positive stub control, and the AC1 regression test.
- `worker/deno/lib/pre_commit_safety.ts:333` exit 0 or another code:
  reached by "does not exempt a path check-ignore reports as ignored
  (exit 0)" and "a check-ignore exit code other than 0 or 1 exempts
  nothing". Exempting any code turned 3 red; exempting `code !== 0`
  turned the exit-128 test red. Dropping `--no-index` turned 2 red.
- `worker/deno/lib/pre_commit_safety.ts:413` wiring: the AC1 regression
  test goes red on base without it.
- `worker/deno/lib/pre_commit_safety.ts:443` unresolvable `origin/HEAD`:
  reached by "an unresolvable origin/HEAD exempts nothing even with a
  decided root negation" and "a repo with no origin configured exempts
  nothing" (PR #3308 review follow-up).
- `worker/deno/lib/pre_commit_safety.ts:455` blob mismatch: reached by "a
  HEAD .gitignore blob that differs from origin/<default>'s exempts
  nothing" and "a re-allow committed only on this branch, absent from
  origin/<default>, exempts nothing" (PR #3308 review follow-up). Removing
  the whole default-ref-match block (lines 438-457) turned all four new
  tests red; restored.

All mutations were restored.

**Guards kept and excluded:** kept: the secret patterns stay absolute;
the merged-in and default-ref exemptions run first, unchanged; the Issue
#1758 message is unchanged. Excluded: `assertAdoptedMergeIsSafe`
(`worker/deno/lib/milestone_merge_state.ts:234`), which still calls
`classifyStagedPath` directly and is not touched by this diff; no new test
exercises it. The "(Issue #3296 sanity)" test only stages `.env` in a plain
commit and checks `assertSafeToCommit` still refuses it.

**Callers checked:** `assertSafeToCommit` is called by
`commitAndPushPending` (`worker/deno/lib/git_push.ts:625`),
`stageAgentResolution` (`worker/deno/lib/milestone_conflict_ladder.ts:275`)
and `worker/deno/tests/hidden_files_safety_integration_test.ts:182`. All
three gain the exemption by intent. `classifyStagedPath` is unchanged, so
`assertAdoptedMergeIsSafe` and `unstageWorkerStateFiles`
(`worker/deno/lib/git_push.ts:468`) are unaffected.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A modified .claude/skills/<x>/SKILL.md in a repo whose .gitignore re-allows .claude/skills passes the gate. — evidence: `worker/deno/tests/pre commit safety gitignore reallow 3296 test.ts::assertSafeToCommit - an edited committed SKILL.md passes when the repo's own .gitignore re-allows .claude/skills (Issue #3296)` — reviewer: met
- **met** — The same path in a repo whose .gitignore does not re-allow it is still refused. — evidence: `worker/deno/tests/pre commit safety gitignore reallow 3296 test.ts::assertSafeToCommit - an edited committed SKILL.md is refused when the repo's .gitignore does not re-allow .claude/skills (Issue #3296)` — reviewer: met
- **met** — .claude/settings.local.json , which stays ignored under .claude/ , is still refused. — evidence: `worker/deno/tests/pre commit safety gitignore reallow 3296 test.ts::assertSafeToCommit - .claude/settings.local.json stays refused even though .claude/skills is re-allowed (Issue #3296)` — reviewer: met
- **met** — Secret patterns ( .env , .config .json , .pem , …) are refused even if a repo's .gitignore re-allows them. — evidence: `worker/deno/tests/pre commit safety gitignore reallow 3296 test.ts::assertSafeToCommit - .env, .config.local.json and key.pem stay refused even when the repo's .gitignore re-allows them (Issue #3296); gitignoreReallowed - never exempts a FORBIDDEN STAGED PATTERNS path` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **fixed (Issue #3309)** — The docs said the root .gitignore must be unmodified 'in both the index and the working tree', but the code only ran git diff --quiet HEAD -- .gitignore, which compares HEAD with the working tree. A staged .gitignore edit whose working-tree copy had been put back would have passed. — evidence: `worker/deno/lib/pre_commit_safety.ts` now also runs `git diff --cached --quiet HEAD -- .gitignore`, and Case 11 in `worker/deno/tests/pre_commit_safety_gitignore_reallow_3296_test.ts` covers the index-only edit.
- **fixed (Issue #3309)** — The docs said a path is exempt when the .gitignore 're-allows' it, but exit 1 from git check-ignore -q --no-index only means 'not ignored', which would also exempt a hidden path no rule mentions and a path re-allowed by an untracked nested .gitignore. — evidence: `gitignoreReallowed` now requires an ancestor-walk decision from the root `.gitignore` itself that is an explicit `!`-negation; Case 9 and Case 10 in the same test file cover both previously-untested scenarios.
- **clean** — Australian English spelling, JSDoc on the new exported function, fail-closed handling when git cannot run or returns other exit codes, TDD (a dedicated 3296 test file with positive and negative controls), and secret patterns checked before any .gitignore exemption

**PR #3308 review follow-up (hand-added, not a re-run of the automated
reviews above):** a later review round found that `HEAD`'s `.gitignore`
alone was still trusted, so a `!`-negation committed only on the branch
under review — never published on the repo's own default branch — could
still exempt a later commit on that branch, even though the two findings
the same round raised about exit-1-alone and nested/untracked
`.gitignore` were already fixed by the entries above. `gitignoreReallowed`
now also requires `HEAD:.gitignore` to match `origin/<default>:.gitignore`
byte for byte, fail-closed when `origin/HEAD` cannot be resolved or either
`.gitignore` is missing. See the four new tests this adds, listed in
Branch outcomes below.
