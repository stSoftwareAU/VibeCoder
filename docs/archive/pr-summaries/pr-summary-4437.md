## Summary

The CI-fix prompt's sentence on how to apply the audit-quarantine exemption now matches the limit it already states: the zero age covers the advisory-clearing version only, and every other version the change moves in the lockfile (including crates a parent bump pulls in) keeps the 24h floor. The same wording change is made in `docs/security-advisory-triage.md`. Closes #4437.

## Spec

### Intent and Rationale

- On Cargo, `cargo update -p <parent>` resolves every crate the new parent version pulls in at its newest release, and the CI-fix path runs no age check, so the agent read the whole resolution as "the advisory-clearing change". The prompt now gives a mechanism to hold those versions (`cargo update -p <crate> --precise <version>`).
- Rewording only; no gate or check is added, as the issue asks.

### Essential Design Decisions

- The issue's open question (does `deno outdated --update --minimum-dependency-age=0 <pkg>` resolve new transitive dependencies at zero age?) was not verified. `deno outdated --help` (deno 2.9.8) shows `--min-dep-age` as a cutoff for the whole command, so the prompt says the flag is command-wide, to name only that package, and to read the lockfile diff afterwards.
- The existing pinned phrase "reaches no further than the advisory-clearing change" is kept, and the sentence extended: it also asks the agent to name other moved versions and its age check in the `.pr_response_message` reply.

### Undiscoverable Facts

- Evidence is NEAT-AI-Discovery#2429 (an hour-old brotli 9.1.1 entered via a parquet/arrow bump).

## Evidence

Prompt-only change; backed by a rendered-prompt test: `worker/deno/tests/ci_fix_prompt_v4_test.ts` (`deno task test:unit`: 10 passed, 0 failed). markdownlint-cli2 on the two edited docs: 0 issues.

## Test Plan

- Added `ci_fix - the zero age covers the advisory-clearing version only, not the crates a parent bump pulls in (Issue #4437)`. Each pinned phrase is absent from the base prompt (the base had "Apply the exemption by passing an explicit zero age for that package"), and the negative assertion on the removed "or by editing the manifest and lockfile directly" wording is red against the base.
- Existing #1847 tests unchanged and still passing. Related rules checked: the #1847 tests in the same file; `CODING-STANDARDS.md` lines ~1986-1989 (CI-fix audit deferral) are unaffected.
- Full `./quality.sh` was not run in this session; CI runs it on the PR.
