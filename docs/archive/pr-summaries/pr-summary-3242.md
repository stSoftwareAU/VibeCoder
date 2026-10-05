# PR Summary — Issue #3242

## Summary

`worker/deno/tests/timing_assertion_policy_test.ts` now pins each phrase
against the section that carries the timing rule, not the whole prompt or the
whole of `CODING-STANDARDS.md`. Closes #3242.

- [x] Read each surface with `readRepoDoc`, narrow it with `section()`, then
      `flat()` it.
- [x] Keep the two "must not appear anywhere" checks whole-file.
- [x] Targeted tests and mutation checks.
- [x] Full quality gate.

## Spec

### Intent and Rationale

CODING-STANDARDS.md § Documentation-drift tests requires section-scoped pins.
This test flattened whole files inline, so a phrase could move out of the
rule's section, or survive elsewhere in the file, and the test stayed green.

### Essential Design Decisions

| Surface | Section (`section()` title) |
| --- | --- |
| `prompts/coding_guidelines/prompt.md` | `Unit Tests vs Benchmarks` |
| `prompts/test_audit/prompt.md` | `3. Performance / timing assertions inside unit tests` |
| `CODING-STANDARDS.md` | `Unit tests` |

- **Absence checks stay whole-file.** "Do not measure performance inside unit
  tests" and "Flag any wall-clock comparison inside a unit test" must not
  appear anywhere in the file, so narrowing them would weaken them. They run
  against the raw file through `phraseAnywhere()`. That helper collapses
  whitespace in both the file and the phrase before a substring check, so
  wrapped prose still matches.

### Undiscoverable Facts

- The old helper went through `loadPrompt`. The new code reads the raw
  `prompt.md` with `readRepoDoc` instead, because `section()` needs the
  markdown headings.
- Open PR #3240 (Issue #3234) adds a `DocSection` brand to `flat()` so that it
  refuses whole-file input. The absence checks therefore avoid `flat()`, which
  keeps this test compatible once #3240 lands.

## Evidence

- `deno task test:unit tests/timing_assertion_policy_test.ts` reported
  `ok | 4 passed | 0 failed`. `deno fmt`, `deno lint` and `deno check` were
  clean.
- Mutation checks (each doc was restored afterwards):
  1. Moving "Ratio assertions are not a finding" out of `test_audit` § 3
     turned the test red.
  2. Rewording "compare two readings of the same work" in CODING-STANDARDS
     § Unit tests turned test 1 red.
  3. Appending "Do not measure\nperformance inside unit tests" at the end of
     `coding_guidelines`, outside the section, turned test 2 red. So the
     absence check is whole-file and tolerates line wrapping.
- Docs sweep: no doc references the removed `promptCollapsed` or
  `standardsCollapsed` helpers. Only the helper doc comments in the test file
  were updated; the module doc comment is unchanged.
  `worker/deno/tests/documentation_drift_policy_test.ts:50` has its own local
  `promptCollapsed`. It is still true for that file, and it is out of scope
  here (see Follow-up).

## Test Plan

- Test: `worker/deno/tests/timing_assertion_policy_test.ts`.
- This is a refactor that only changes scope, so the test is **green on base
  by design**. `deno task drift-pins-on-base origin/main …` reports every
  literal pin `ALREADY ON BASE` in its section:
  - `Absolute`, `against a constant as a finding`,
    `Ratio assertions are not a finding` and
    `times the same work at two input sizes` in `test_audit` § 3;
  - `assertLinearGrowth` in `coding_guidelines`;
  - `compare two readings of the same work` in CODING-STANDARDS § Unit tests.

  In `coding_guidelines`, the `RULE` regex matches through its
  "another reading of the same work" alternative.
- Branch outcomes: none added.
- Removed from `worker/deno/tests/timing_assertion_policy_test.ts`:
  `` assertEquals(loaded.ok, true, `cannot load ${family}`); `` — #3242
  requires section-scoped pins, and `section()` needs the raw markdown
  headings, so the `loadPrompt`-based `promptCollapsed` helper that held this
  assertion is gone. The surfaces are now read with `readRepoDoc`, which
  throws if the file is missing, so a load failure still turns the test red.
- Removed from `worker/deno/tests/timing_assertion_policy_test.ts`:
  `assertEquals( collapsed.includes("Do not measure performance inside unit tests"), false, "coding_guidelines still carries the flat ban, which forbids the ratio " + "assertions CODING-STANDARDS.md requires", );`
  — #3242 narrows `collapsed` to the `Unit Tests vs Benchmarks` section, so
  this check would now only cover that section. It is replaced in the same
  test by a whole-file absence check (`phraseAnywhere` against the raw
  `coding_guidelines` prompt), with the same message.
- Removed from `worker/deno/tests/timing_assertion_policy_test.ts`:
  `assertEquals( collapsed.includes("Flag any wall-clock comparison inside a unit test"), false, "test_audit still flags every comparison without exception", );`
  — #3242 narrows `collapsed` to `test_audit` § 3, so this check would now
  only cover that section. It is replaced in the same test by a whole-file
  absence check (`phraseAnywhere` against the raw `test_audit` prompt), with
  the same message.

## Related rules checked

CODING-STANDARDS.md § Documentation-drift tests (condition 1, section-scoped
pins; condition 4, per-phrase base check). The change agrees with both.

## Follow-up

About 31 other `*_test.ts` files still flatten inline with
`.replace(/\s+/g, " ")`, for example
`worker/deno/tests/documentation_drift_policy_test.ts`. The optional lint
against that pattern was skipped as out of scope, because it would fail on
all of them. This overlaps #3234 and #3240.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
