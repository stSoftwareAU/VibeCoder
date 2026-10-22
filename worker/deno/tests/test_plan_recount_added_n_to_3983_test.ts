// Tests for "Added N tests to `file`" partial additions in Test Plan prose
// (Issue #3983). The single-figure bullet was read as a whole-file count, so a
// file with one more test than the bullet named reported a false mismatch.
import { assertEquals } from "@std/assert";
import {
  findTestPlanMismatches,
  findUncheckedRunResults,
  type TestDeclarationCounts,
} from "../lib/test_plan_recount.ts";
import { assertLinearGrowth } from "./support/growth.ts";

function counts(
  entries: Record<string, number>,
): Map<string, TestDeclarationCounts> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [k, { total: v, runnable: v }]),
  );
}

function plan(...lines: string[]): string {
  return "## Test Plan\n\n" + lines.join("\n") + "\n";
}

function mismatchesOf(
  summary: string,
  heads: Record<string, number>,
): unknown[] {
  return findTestPlanMismatches({ summary, headCounts: counts(heads) }).map(
    (m) => [m.files, m.claimed, m.actual],
  );
}

function uncheckedLines(
  summary: string,
  heads: Record<string, number>,
): string[] {
  return findUncheckedRunResults({ summary, headCounts: counts(heads) }).map(
    (u) => u.line,
  );
}

const PARTIAL =
  "the block describes partial test additions, not whole-file counts";

Deno.test("'Added N tests to `file`' is partial whatever the markup or wrap, at head N+1 and N (Issue #3983)", () => {
  const bullets = [
    "- Added 5 tests to `tests/a_test.ts`.",
    "- Added 5 test to `tests/a_test.ts`.",
    "- added 5 tests to `tests/a_test.ts` (retry path).",
    "- **Added** 5 tests to `tests/a_test.ts`.",
    "- Added 5 tests\n  to `tests/a_test.ts`.",
  ];
  for (const bullet of bullets) {
    const summary = plan(bullet);
    for (const head of [6, 5]) {
      assertEquals(
        mismatchesOf(summary, { "tests/a_test.ts": head }),
        [],
        `${bullet} at head ${head}`,
      );
      assertEquals(
        findUncheckedRunResults({
          summary,
          headCounts: counts({ "tests/a_test.ts": head }),
        }).map((u) => u.reason),
        [PARTIAL],
        `${bullet} at head ${head}`,
      );
    }
  }
});

Deno.test("regression controls: the existing whole-file and partial forms keep their reading (Issue #3983)", () => {
  // Partial: the figure precedes the file and "added to" follows it.
  const partial = plan("- 5 tests added to `tests/a_test.ts`.");
  assertEquals(mismatchesOf(partial, { "tests/a_test.ts": 6 }), []);
  assertEquals(
    findUncheckedRunResults({
      summary: partial,
      headCounts: counts({ "tests/a_test.ts": 6 }),
    }).map((u) => u.reason),
    [PARTIAL],
  );

  // Whole: a parenthesised count after the file is the file's count.
  assertEquals(
    mismatchesOf(plan("- Added `tests/a_test.ts` (5 tests)."), {
      "tests/a_test.ts": 6,
    }),
    [[["tests/a_test.ts"], 5, 6]],
  );

  // Whole: a "file has N tests" or "N tests in file" reading.
  assertEquals(
    mismatchesOf(plan("- `tests/a_test.ts` has 5 tests."), {
      "tests/a_test.ts": 6,
    }),
    [[["tests/a_test.ts"], 5, 6]],
  );
  assertEquals(
    mismatchesOf(plan("- 5 tests in `tests/a_test.ts`."), {
      "tests/a_test.ts": 6,
    }),
    [[["tests/a_test.ts"], 5, 6]],
  );

  // The "(N tests; the file now has M)" total is compared, not the partial N.
  assertEquals(
    mismatchesOf(
      plan("- Added to `tests/c_test.ts` (8 tests; the file now has 47)."),
      { "tests/c_test.ts": 54 },
    ),
    [[["tests/c_test.ts"], 47, 54]],
  );
});

Deno.test("a block mixing 'Added N tests to' with a whole-file count checks only the whole-file count (Issue #3983)", () => {
  const summary = plan(
    "- Added 3 tests to `tests/a_test.ts` (34 tests in all), and `tests/b_test.ts` (8 tests) passes.",
  );
  assertEquals(
    mismatchesOf(summary, { "tests/a_test.ts": 34, "tests/b_test.ts": 11 }),
    [[["tests/b_test.ts"], 8, 11]],
  );
});

Deno.test("'Added N tests for `file` to be kept' stays whole: the gap must read 'to' (Issue #3983)", () => {
  // Before-and-gap flip fixture: "added" is directly before the figure, but
  // the text up to the file is "for", not "to", so the figure is not partial.
  const summary = plan(
    "- Added 5 tests for `tests/a_test.ts` to be kept.",
  );
  assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 6 }), [
    [["tests/a_test.ts"], 5, 6],
  ]);
  assertEquals(uncheckedLines(summary, { "tests/a_test.ts": 6 }), []);
});

Deno.test("a figure not directly after 'added' stays whole even when 'to' follows (Issue #3983)", () => {
  // Before flip fixture: "to" follows the figure, but "added" is not the
  // word directly before it.
  const summary = plan("- Fixed the retry; 5 tests to `tests/a_test.ts`.");
  assertEquals(mismatchesOf(summary, { "tests/a_test.ts": 6 }), [
    [["tests/a_test.ts"], 5, 6],
  ]);
  assertEquals(uncheckedLines(summary, { "tests/a_test.ts": 6 }), []);
});

Deno.test("hostile runs of the 'Added N tests to' figure grow linearly (Issue #3983)", () => {
  const headCounts = counts({ "tests/c_test.ts": 47 });
  const cases: [string, (chars: number) => string][] = [
    [
      "added then spaces before the figure",
      (chars) =>
        plan(
          "- added" + " ".repeat(chars) + "5 tests to" + " ".repeat(chars) +
            "! `tests/c_test.ts`",
        ),
    ],
    [
      "repeated added-to figures",
      (chars) =>
        plan(
          "- " + "Added 5 tests to ".repeat(Math.floor(chars / 17)) +
            "`tests/c_test.ts`",
        ),
    ],
  ];
  for (const [label, build] of cases) {
    assertLinearGrowth(
      label,
      build,
      (summary) => findTestPlanMismatches({ summary, headCounts }),
      { baseChars: 5_000 },
    );
  }
});
