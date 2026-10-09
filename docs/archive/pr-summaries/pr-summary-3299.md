# PR Summary — Issue #3299

**Closes #3299**

## Summary

Moves the nine `review-fleet-prs` helpers (`run.sh`, `app_token.ts`,
`branch_update.ts`, `dependabot.ts`, `escalate.ts`, `gate.ts`,
`needs_human.ts`, `post.ts`, `review_log.ts`) into
`.claude/skills/review-fleet-prs/scripts/` with `git mv`. The relative imports,
`CHECKOUT` (one more `..`) and the location comments are fixed. A mode-755
forwarding shim stays at the old `run.sh` path, so hosts installed before the
move keep working. `--install` now writes the `scripts/run.sh` path, and
`SKILL.md` tells operators to re-run `--install`.

- [x] `git mv` the nine helpers into `scripts/`, keeping `run.sh` at mode 755
- [x] Fix the relative imports (`../../../../`), `CHECKOUT` and the round prompt's helper directory
- [x] Add the forwarding shim at `.claude/skills/review-fleet-prs/run.sh`
- [x] Repoint the 11 `review_fleet_prs_*_test.ts` files that name a helper path
- [x] Update the lib comments, `docs/CONFIGURATION.md` and `SKILL.md`
- [x] Add tests for the shim (forwarding, including a non-zero exit) and for the `--install` path (plist and unit)
- [x] Spec and standards review
- [x] `./quality.sh`

## Spec

### Intent and Rationale

- The skills guide keeps executable helpers under `scripts/`. `SKILL.md` and the `run.sh` shim were meant to be the only things left at the skill root; PR #3417's review added five more root-level forwarders (`app_token.ts`, `escalate.ts`, `gate.ts`, `post.ts`, `review_log.ts`), kept until every installed runner has restarted onto `scripts/run.sh` (see `.claude/skills/review-fleet-prs/app_token.ts`'s comment).
- Existing launchd and systemd services still start the old path. The shim keeps them running until the operator re-runs `--install`.

### Essential Design Decisions

- The shim is the issue's one-liner, `exec "$(dirname "${BASH_SOURCE[0]}")/scripts/run.sh" "$@"`. `exec` hands the exit status straight back, and a missing target fails loudly by default.
- `scripts/run.sh` builds the service command from its own `SCRIPTS_DIR`. A run that goes through the shim with `--install` therefore still writes `scripts/run.sh`, not the shim.
- `docs/archive/` is not changed, as the issue asks.

### Undiscoverable Facts

- `claude_credential.ts`, which the issue lists among the helpers that may exist, is no longer in the repo (#3293 removed it), so nothing was moved for it.
- `.claude/agents/fleet-pr-reviewer.md` names no helper file, so it is not changed.
- `review_fleet_prs_skill_labels_2882_test.ts` reads only `SKILL.md`, which did not move, so it is not changed.
- `worker/deno/lib/review_round.ts:5` is not in the issue's file list, but it named the old `run.sh` path and would have failed the acceptance grep.

## Evidence

This change touches only scripts, tests and docs; no UI is affected.

Acceptance grep on the final head:
`grep -rnE 'skills/review-fleet-prs/[a-z_]+\.(ts|sh)' --exclude-dir=archive --exclude-dir=.git .`
→ one hit, `./worker/deno/tests/review_fleet_prs_runner_test.ts:21`, which is the `SHIM` constant the criterion allows.

**Docs sweep** — grep: `skills/review-fleet-prs/[a-z_]+\.(ts|sh)`, `review-fleet-prs/(run\.sh|scripts)` and `SKILL_DIR` over the repo outside `docs/archive/`; section: `docs/CONFIGURATION.md#-reviewer-app-for-fleet-pr-reviews`. Updated: `.claude/skills/review-fleet-prs/SKILL.md:33-39`, `docs/CONFIGURATION.md:382`, `worker/deno/lib/review_round.ts:5`, `worker/deno/lib/pr_feedback_reviewer_no_change.ts:36`, `worker/deno/lib/change_request_quotes.ts:17` and `:58`, and `worker/deno/lib/integration_test_manifest.ts:76`. Remaining hits: `worker/deno/tests/review_fleet_prs_runner_test.ts:21` is still correct because it is the shim test's intended old path. No `SKILL_DIR` remains. `docs/CONFIGURATION.md:174` and `:406` are also still correct: they name the skill and link `SKILL.md`, not a helper path.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The forwarding `run.sh` shim remains at the skill root, and every helper's authoritative body is under `scripts/`. — evidence: `.claude/skills/review-fleet-prs/` holds `SKILL.md`, `run.sh` (shim) and `scripts/`; PR #3417's review added five more root-level forwarders (`app_token.ts`, `escalate.ts`, `gate.ts`, `post.ts`, `review_log.ts`) that each import their `scripts/` counterpart — reviewer: met
- **met** — Outside `docs/archive/`, the grep finds no root-level helper path, apart from the shim test. — evidence: the grep output above — reviewer: met
- **met** — `review_fleet_prs_runner_test.ts` passes against `scripts/run.sh`. — evidence: `worker/deno/tests/review_fleet_prs_runner_test.ts:11` (`RUNNER`), and the suite passes in `./quality.sh` — reviewer: met (by inspection)
- **met** — A new test runs the old path with `--once` under the stubbed PATH. It asserts the call reaches `scripts/run.sh` and returns its exit status, including a non-zero one. — evidence: `worker/deno/tests/review_fleet_prs_runner_test.ts:566` and `:580` — reviewer: met
- **met** — A test asserts `--install` writes the `scripts/run.sh` path into the plist and unit. — evidence: `worker/deno/tests/review_fleet_prs_runner_test.ts:617`, `:629` and `:646` — reviewer: met
- **met** — `./quality.sh` passes, including type-checking the moved helpers. — evidence: `Result: PASSED (with skipped checks)` on the final head, with `deno type check PASSED` — reviewer: not verified by execution — reason: the reviewer cannot run commands; the gate was run here

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no violations. Checked: every named test exists; the tests run the real shim and runner and do not grep source; `installStubs` only records calls to the OS service tools; no workflow file, persisted-data shape or destructive operation is touched. Optional nits, not taken: a comment on the shim's behaviour when `scripts/run.sh` is missing (`exec` already fails loudly), and a note in `SKILL.md` that a fresh install needs no migration step.

## Test Plan

- From `worker/deno`, the 11 touched test files: 119 passed, 0 failed. `deno fmt --check` and `deno lint` are clean.
- `./quality.sh < /dev/null` → `Result: PASSED (with skipped checks)`. Only `config integration` was skipped, because this checkout has no `.config.json`.
- Red checks. Each break below was made on purpose, the tests went red, and the source was then restored byte-identical:
  - Changing `args` in `scripts/run.sh:54` to `$SCRIPTS_DIR/../run.sh` made the three `--install` tests fail.
  - Changing the shim to `…; exit 0` made the non-zero-status test fail.
  - Changing the shim to a bare `exit 0` made the reaches-a-round test fail.
- No assertion was removed. The existing prompt assertion now expects the `scripts` directory.

**Branch outcomes:** none added. The shim is a single unconditional `exec`, and the move adds no condition. The changed call sites and the tests that go red when each is reverted:

- `.claude/skills/review-fleet-prs/run.sh:5`: shim forwards to `scripts/run.sh`. Test: "run.sh's root-level shim reaches scripts/run.sh and runs a headless round (Issue #3299)". Revert went red.
- `.claude/skills/review-fleet-prs/run.sh:5`: shim returns a non-zero exit status. Test: "run.sh's root-level shim forwards scripts/run.sh's non-zero exit status (Issue #3299)". Revert went red.
- `.claude/skills/review-fleet-prs/scripts/run.sh:54`: `--install` service path. Tests: the plist, unit and shim-install tests at `worker/deno/tests/review_fleet_prs_runner_test.ts:617`, `:629` and `:646`. Revert went red.

**Callers checked:** every file that names a moved helper path (the 11 `review_fleet_prs_*_test.ts` files in the diff). Every helper `deno run` in `scripts/run.sh` runs `cd "$SCRIPTS_DIR"` first; the one at `scripts/run.sh:129` runs `worker/deno/mod.ts` from `$CHECKOUT`, which resolves to the repo root through the extra `..` at `scripts/run.sh:25`. The round prompt's helper directory was also checked. No production caller outside the skill imports a helper.

**Related rules checked:** this change adds no rule. I applied **A Code Change Owes a Docs Change** and **Every changed call site needs a test that goes red without it** to this PR's own diff and found nothing outstanding.

## Security Self-Check

- [x] Input validation: no new external input. The shim passes `"$@"` through unchanged.
- [x] Secrets: no hidden file is staged outside `.claude/skills/`, which the repo's `.gitignore` re-allows.
- [x] Injection surface: `exec` uses a quoted path built from `BASH_SOURCE`, with no string evaluation.
- [x] Output encoding, auth, error handling and dependencies: not affected.
- [x] Path confinement: no new path guard.
