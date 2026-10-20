# Stop formatting-only failures escaping the formatter-before-gate path

## Summary

The pre-push gate still reported `cargo fmt --all --check` and `deno fmt
--check` diffs in a private Rust/Deno fleet repo despite the
formatter-before-gate path (`formatBeforeGate` in `repo_formatters.ts`).
Reconstructing the Rust and nested-Deno cases against the current worker build
(`formatBranchChanges` then `gateUnpushedCommits` on a real git fixture) showed
the format-then-gate happy path already works for both on main, so the
historical failures were deployment lag, not a live defect in that path. The
one real defect found is that the cargo formatter staged its whole root
(`paths: [root]` became `git add -u -- :(literal).`), sweeping unrelated edits
into the `style: apply repository formatters` commit. This PR scopes cargo
staging to the branch's changed `.rs` files, matching the deno formatter and
the already-documented "only the formatted paths are staged" contract, and adds
regression fixtures for the Rust and nested-Deno happy paths and for the
unrelated-edit preservation guarantee.

Closes #3978.

## Spec

### Intent and Rationale

- A formatting-only miss must be fixed by the formatter-before-gate path, not
  escape to the gate and cost a round of review or CI.
- The formatter commit must stage only what the formatter formatted for the
  branch's own changes — never the whole tree, and never an unrelated edit the
  run left uncommitted.
- The recovery path (a rejected push that merges remote work, or a later
  approved edit) must re-check the final head, so the head that is checked and
  pushed is the head that was formatted.

### Essential Design Decisions

- Scope cargo staging to `changedRs` — the changed `.rs` files under each
  outermost `Cargo.toml` root — instead of `[root]`
  (`worker/deno/lib/pre_push_gate.ts:527,535`). `cargo fmt --all` still runs
  with no file arguments, so its formatting scope is unchanged; only the
  `git add -u -- :(literal)<paths>` staging narrows. This is the same
  shape the deno loop already used.
- No second formatter implementation: `planFormatterFixes` and
  `runRepoFormatters` are reused unchanged apart from the one staging change.
- The recovery path is left as-is. The completion phase already re-runs
  `gateBeforePush()` (which re-runs `formatBeforeGate` then the gate with the
  comparable base) after `recoverFromPushRejection`
  (`worker/deno/lib/phases/completion_phase.ts:2164`), and the PR-feedback and
  CI-fix processors re-run `finalise()` (format + gate) on retry. A recovery
  merge therefore cannot leave the checked/pushed head different from the
  formatted head unnoticed.

### Undiscoverable Facts

- `cargo fmt --all` rewrites the whole workspace, not just the branch's files.
  The `paths` field is used only to build the `git add -u` pathspec, so scoping
  it narrows staging without narrowing formatting.
- `git add -u -- <pathspec>` stages only tracked files that already differ in
  the working tree, so the scoped pathspec never stages an untouched file.
- The deno loop was always scoped (`paths: files.map((f) => f.repoPath)`), so
  the nested-Deno JSON case needed no code change — a regression fixture only.
- The whole-workspace reformat of a `.rs` file the branch did not change is
  deliberately not staged (see "no broad formatting across unrelated files").
  That case only arises when the base already carries unformatted `.rs` debt,
  which is itself a red `cargo fmt --all --check` on main, outside the branch's
  scope.

## Evidence

**Docs sweep** — grep: `planFormatterFixes`, `cargo fmt`, `:(literal)`,
`whole tree`, `formatted paths`; section: `repo_formatters.ts` module and
`runRepoFormatters` doc comments, `pre_push_gate.ts` `planFormatterFixes` doc
and `FormatterFix.paths`, `docs/CONFIGURATION.md` formatter-scope prose;
siblings: none — no existing set gained a member; the change narrows a staging
pathspec rather than adding a symbol, enum variant, field or list element.

Hits, all accurate:

- `worker/deno/lib/repo_formatters.ts:10-14, 149-151`: already described the
  scoped contract ("Only those paths are staged (`git add -u -- <paths>`) …
  an unrelated edit elsewhere in the tree stays out of the commit"). Fix A
  makes the code match the doc; unchanged.
- `worker/deno/lib/pre_push_gate.ts:483`: `FormatterFix.paths` doc comment
  edited in this PR to "Repo-relative pathspecs staged after the formatter
  runs" (previously "the formatter may rewrite", which is imprecise now that
  `cargo fmt --all` rewrites the whole workspace while `paths` lists only the
  changed `.rs` files).
- `worker/deno/lib/pre_push_gate.ts:489-493`: `planFormatterFixes` doc still
  accurate — `cargo fmt --all` runs for a cargo root whose `.rs` files changed.
- `docs/CONFIGURATION.md:4779-4781`: "Only the formatted paths are staged" and
  "`cargo fmt --all` for a cargo root whose `.rs` files changed" now describe
  the actual code; unchanged.

**Callers checked**: `planFormatterFixes` is called only from
`runRepoFormatters` (`worker/deno/lib/repo_formatters.ts:177`), which is called
by `formatBranchChanges` (`repo_formatters.ts`) — itself wired into the
quality-gate phase, the completion phase's `gateBeforePush`, and
`commitAndPushPending` Step 1a. The staging pathspec it produces is consumed
only by `runRepoFormatters`'s `git add -u` (`repo_formatters.ts:246-248`). No
other caller reads `FormatterFix.paths` expecting the old whole-root value.

## Reproduction

- symptom: with an unformatted Rust change and an unrelated uncommitted edit in
  the same tree, `formatBranchChanges` folded the unrelated edit into the
  `style: apply repository formatters` commit because cargo staged
  `:(literal).` (the whole root).
- status: verified
- regression tests (all run against the real worker build, not mocks):
  - `worker/deno/tests/completion_phase_repo_formatters_test.ts` —
    `completion - cargo fmt stages only the branch's .rs files, not an
    unrelated uncommitted edit`
  - `worker/deno/tests/completion_phase_repo_formatters_test.ts` —
    `completion - an unformatted Rust change is formatted and committed, then
    passes the gate`
  - `worker/deno/tests/completion_phase_repo_formatters_test.ts` —
    `completion - an unformatted nested-Deno JSON change is formatted and
    committed, then passes the gate`

- The Rust happy-path fixture seeds a formatted `src/lib.rs`, commits an
  unformatted `src/lib.rs` on the branch, and asserts the bare gate fails, the
  formatter commits, the file bytes equal `FORMATTED_RS`, and the gate then
  passes. The nested-Deno fixture does the same for an unformatted
  `worker/deno/data.json`.
- The staging test leaves an unrelated uncommitted `README.md` edit in the
  tree, runs `formatBranchChanges`, and asserts `git show --name-only HEAD`
  touches only `src/lib.rs` while `git status --porcelain` still lists the
  `README.md` edit. Against the pre-fix `paths: [root]` this assertion failed
  (the old `:(literal).` staged `README.md` too).
- The pre-existing unit test `repo formatters - formatter that changes files
  commits once` (`worker/deno/tests/repo_formatters_test.ts:176`) pinned the
  old `:(literal).` staging; it went red against Fix A and its expected value
  was updated to `:(literal)src/main.rs`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — reproduction explains why the formatter did not prevent each historical failure — evidence: `worker/deno/tests/completion_phase_repo_formatters_test.ts::completion - an unformatted Rust change is formatted and committed, then passes the gate` — reviewer: partial — reason: the narrative was absent from the diff the reviewer saw; it is now in the Reproduction section above (deployment lag plus the cargo broad-staging defect).
- **met** — valid unformatted Rust and nested-Deno/JSON fixtures pass the gate after auto-formatting, without a coding-failure attempt — evidence: `worker/deno/tests/completion_phase_repo_formatters_test.ts::completion - an unformatted nested-Deno JSON change is formatted and committed, then passes the gate` — reviewer: met
- **partial** — a recovery merge or later approved edit cannot leave the final checked/pushed head different from the formatted head unnoticed — evidence: `worker/deno/lib/phases/completion_phase.ts:2164` — reviewer: partial — reason: the recovery re-gate pre-exists and is unchanged; the only residual is a whole-workspace reformat of a branch-untouched `.rs` file, deliberately left unstaged and only arising from pre-existing red-on-main debt.
- **met** — missing tooling, invalid syntax, and real lint/test failures stay visible and blocking — evidence: `worker/deno/lib/repo_formatters.ts` failures record and the `hasCargo()` skip guard in `worker/deno/tests/completion_phase_repo_formatters_test.ts` — reviewer: met
- **met** — repair is idempotent and preserves unrelated edits, with no second formatter implementation — evidence: `worker/deno/tests/completion_phase_repo_formatters_test.ts::completion - cargo fmt stages only the branch's .rs files, not an unrelated uncommitted edit` — reviewer: met
- **partial** — where current main already fixes the historical failure, provide deployed-build evidence plus a regression fixture — evidence: `worker/deno/tests/completion_phase_repo_formatters_test.ts::completion - an unformatted nested-Deno JSON change is formatted and committed, then passes the gate` — reviewer: partial — reason: the nested-Deno case needed no code change (the deno loop was always scoped); the three fixtures, run against the real worker build, are the deployed-build evidence.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — the `FormatterFix.paths` doc comment described the staging pathspec as "the formatter may rewrite", imprecise once cargo staging narrowed — evidence: `worker/deno/lib/pre_push_gate.ts:483` — reason: fixed in this diff
- **clean** — new and edited tests drive real code (`formatBranchChanges`, `gateUnpushedCommits`, a real git repo) and assert on results, file bytes, `git show`/`git status`; no source-text inspection
- **clean** — no secrets, no hidden files, no `git add -f`/`--no-verify`; the scratch repro file was created and removed within the branch and is not in the final diff
- **clean** — the deliberate Markdown restriction is preserved (`DENO_CODE_FORMAT_EXTENSIONS` and the "never Markdown" logic untouched)
- **clean** — Australian English in all new comments and messages; no second formatter implementation (a four-line edit inside the existing `planFormatterFixes`/`runRepoFormatters`)

## Test Plan

- `./quality.sh < /dev/null` — full gate GREEN: deno tests, deno lint, deno
  type check, deno fmt all PASSED (`Result: PASSED (with skipped checks)`).
- Rust and nested-Deno fixtures run in the gate's deno-test pass and skip only
  when `cargo`/`rustfmt` are absent from the host; in this container both are
  present, so all three new tests executed.
- Flip checks: reverting `paths: changedRs` to `paths: [root]` made the new
  staging test fail and the pre-existing `repo_formatters_test.ts:191`
  assertion go red before it was updated; forcing `changedRs.length === 0` to
  `!== 0` made "cargo fmt runs only when a Rust file under its root changed"
  run cargo fmt on a README-only change.

<!-- vibe-branch-outcomes -->
