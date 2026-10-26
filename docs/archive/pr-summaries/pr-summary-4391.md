## Summary

Issue #4391 was closed on `main` by #4400 (commit 6c656c53), which accepts a
JSON or TOML `version` line re-bump as a version-only change. This PR now keeps
that design and adds only what the earlier iteration did better: the JSON
pattern in `isVersionIncrement`
(`.claude/skills/review-fleet-prs/scripts/gate.ts`) no longer backtracks
quadratically, and hostile-input tests cover each version pattern. The earlier,
incompatible `isVersionIncrement` design was dropped in favour of `main`'s.

## Spec

### Intent and Rationale

- `main`'s JSON shape ended `"[ \t]*,?[ \t]*$`: two blank runs with only an
  optional comma between them. A `"version": "1.2.3"` line followed by 100,000
  blanks and then a rejected character took about 17 s in V8, and the cost grows
  with the square of the run. The gate reads untrusted patch text.
- The group is now `"[ \t]*(?:,[ \t]*)?`, so the comma separates the two runs
  and the language accepted is unchanged.

### Essential Design Decisions

- The owner decision in the PR sweep note offered two options; this PR takes the
  second, rebased on `main`'s design: `main`'s version stays, and the hardening
  and hostile-input tests are ported onto it.
- The other patterns were checked for the same shape: the TOML pattern has one
  blank run after the quote; the bare and suffix patterns separate their repeats
  with `.` or `-`; the hunk header's counts are single `\d+` runs. They stay as
  they are and each gets a hostile case.

## Evidence

- Merged `origin/main` and took its `gate.ts`, `SKILL.md`,
  `references/edge-cases.md`, test file and summary, then re-applied the change
  above. Read `SKILL.md` rule 8 and `edge-cases.md` **Version-only re-bumps**:
  neither names the JSON pattern's shape, so no doc text changed.
- Red check: with the old `,?[ \t]*` group restored, the new hostile test did
  not finish within 60 s (killed); with the fix it passes in well under a
  second. The test uses 1,000,000 blanks, so the old pattern cannot finish
  inside the unit-test budget on any host; it asserts results, not timings.
- `review_fleet_prs_gate_2675_test.ts`: 25 tests passed, 0 failed at head.

## Test Plan

- `worker/deno/tests/review_fleet_prs_gate_2675_test.ts`, test "manifest version
  exception refuses hostile long inputs, accepting the same shape when well
  formed (Issue #4391)": for the JSON, TOML and bare-suffix patterns, the
  well-formed shape is accepted (`awaiting-fix` path, `true`) and the same shape
  followed by a rejected `!` is refused (`false`); a 100,000-digit hunk line
  count is refused.
- Existing tests from #4400 are unchanged.

Branch outcomes:

- JSON blanks then rejected character: refused, covered by the hostile case in
  that test (red-checked above by restoring `,?[ \t]*`).
- JSON well formed: accepted, covered by the control in the same test.
- TOML, bare-suffix: same accepted/refused pair in the same test; hunk header
  with huge count: refused in the same test.
