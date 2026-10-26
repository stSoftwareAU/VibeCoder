## Summary

`review-fleet-prs` now treats a version re-bump in a JSON or TOML package
manifest as a version-only change, so a sent-back PR whose only own-diff change
after a base merge is the manifest's `"version"` line stays `awaiting-fix`
instead of getting another full review. `isVersionIncrement` in
`.claude/skills/review-fleet-prs/scripts/gate.ts` accepts the existing
bare-version form or a new manifest form. Closes #4391.

Version bump: no `VERSION` file is touched by this change; the merged commit
records the final version.

## Spec

### Intent and Rationale

- The #3713 exception accepted only a no-context hunk of two bare version lines.
  A manifest bump is a context-bearing hunk whose lines wrap the version in
  `"version": "…",`, so the gate reported the PR `ready` and the reviewer
  repeated a full review on every base merge.
- The bare form is kept byte-for-byte; the manifest form is a second branch
  behind the same entry point, so `ownDiffUnchanged` and its guards are
  unchanged.

### Essential Design Decisions

- Manifest form: exactly one `-` line immediately followed by one `+` line;
  context lines allowed; both lines are a `version` key (`"version": "<ver>"`
  with optional trailing comma, or TOML `version = "<ver>"`); prefix and suffix
  around the token must be identical; the token must strictly increase under the
  shared numeric rule (`isStrictNumericIncrease`, the former inline comparison).
- Fail closed: any body line not starting with space, `+` or `-` (including
  `\ No newline at end of file`), a second hunk, or header line counts that
  differ from context lines plus one gives a fresh review. A pin on another key
  (for example `jsr:@std/path@1.2.3` to `@1.2.4`) never matches.
- Assumption: a nested `version` key in a manifest is indistinguishable from the
  top-level one in a patch, so it is accepted; the issue asks for "a key named
  `version`".

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI change; no UI files. Tests exercise the real `ownDiffUnchanged` and
`skipReason` with a fake `gh` that returns compare responses shaped like
GitHub's (the existing `fakeGh`/`compareFiles` helpers from the #3713 tests).

Existing guards kept: an earlier finding naming the manifest forces a fresh
review, findings must be known, and every other file must still match exactly
(the new table has a row for each).

## Test Plan

Added to `worker/deno/tests/review_fleet_prs_gate_2675_test.ts` (all named
"(Issue #4391)"):

- JSON manifest `"version"` bump in a context hunk, with and without a separate
  bump commit, through `skipReason` gives `awaiting-fix`.
- TOML `version = "…"` bump through `ownDiffUnchanged` gives `true`.
- A table of rows through `ownDiffUnchanged`: the first row is the positive
  control (accepted); the others are refused by the rule they name: another file
  differs, a second changed pair, a second hunk, a context-adjacent changed
  line, non-`version` keys (`jsr:@std/path` pin, `schemaVersion`, `versions`),
  different indentation or comma, JSON vs TOML line, equal or decreasing
  version, suffix-only change, wrong header count, `\ No newline` marker, and
  earlier findings naming `package.json`, `./package.json` or unknown
  (`undefined`).
- A hostile case: 100000 spaces after the colon on a `version` line returns
  `false` (output asserted, no timing).

No existing assertion was removed or edited (diff of the test file is additions
only).

Red-checks on `gate.ts` (each restored afterwards): dropping the key-name
requirement → "schemaVersion key" row red; removing prefix/suffix identity →
"indentation differ" row red; relaxing exactly-one-pair → "second changed pair"
row red; removing strict increase → "equal version" row red; removing the header
count check → "old header count is wrong" row red; forcing the manifest branch
to `false` → the three positive tests red.

Initial implementation validation:
`deno task test:unit tests/review_fleet_prs_gate_2675_test.ts` passed (26
passed, 0 failed); with `review_fleet_prs_upkeep_failure_2891_test.ts` also
passed (30 passed). `./quality.sh`: every static stage passed (fmt, lint, type
check, markdownlint, mermaid, semgrep). The `deno tests` parallel pass failed on
two tests in `tests/completion_phase_repo_formatters_test.ts` (the Rust format
cases, `cargo` formatting in this container); these tests are in no file this
change touches, but I did not run them on the base branch to confirm they fail
there too. The serial pass did not run because the parallel pass failed.

Docs updated: `.claude/skills/review-fleet-prs/references/edge-cases.md`
("Version-only re-bumps", read in full) and
`.claude/skills/review-fleet-prs/SKILL.md` item 8. No other doc mentions the
exception (grepped `version re-bump`, `version increment`, `bare version`,
`isVersionIncrement`).

Not done: the issue's log-based check (no consecutive `changes_requested` on one
PR) was not run; it needs the live `log.jsonl`. Real GitHub patches were not
fetched; fixtures follow the shape in the issue.

### Review follow-up

Commit `c5de76414` adds the two hostile-input cases requested by the independent
review: a TOML `version` key followed by 100,000 spaces and a rejected character,
and a hunk line count containing 100,000 digits and a rejected character. Both
call `ownDiffUnchanged` and assert `false`. Existing assertions and production
behaviour are unchanged; the current parser already rejects these inputs.

Each case was checked independently by temporarily adding an overlapping
quantifier to its intended regex. Each mutated run reached the new test and
stalled until an external eight-second bound killed it; the production parser
was restored byte-for-byte. This demonstrates the new coverage, not a defect
in the current parser. No timing assertion was added to the unit tests.

Validation after restoring the parser: 58 focused gate/audit/backlog/upkeep
tests passed; manifest checks passed with 867 tests and one existing ignore;
format, lint, type-check and `git diff --check` passed. The full local quality
gate was not repeated for this test-only follow-up.

The first follow-up CI run, `40283079367`, passed format, lint and type-check
but the summary-freshness check rejected the test commit because this summary
predated it. This update records the review fix and its evidence. CI and
independent re-review remain outstanding for the resulting head.
