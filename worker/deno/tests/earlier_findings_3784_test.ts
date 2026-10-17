import { assertEquals, assertThrows } from "@std/assert";
import {
  earlierFindingGaps,
  extractEarlierFindings,
  parseEarlierVerdicts,
} from "../lib/earlier_findings.ts";

Deno.test("earlier findings - preserves every fleet problem and fix, with a whole-comment fallback", () => {
  assertEquals(
    extractEarlierFindings(
      "**`a.ts:2`**: first\n\n**Fix:** both paths\n\n**`b.ts`**: second\n\n**Fix:** also docs",
    ),
    [
      "**`a.ts:2`**: first\n\n**Fix:** both paths",
      "**`b.ts`**: second\n\n**Fix:** also docs",
    ],
  );
  assertEquals(extractEarlierFindings("Fix both cases\nand the manual."), [
    "Fix both cases\nand the manual.",
  ]);
  assertEquals(extractEarlierFindings("  "), []);
});

Deno.test("earlier findings - only one evidenced fixed verdict per expected index clears it", () => {
  const expected = ["first", "second"];
  const fixed = (index: number) => ({
    index,
    verdict: "fixed" as const,
    note: "Verified both paths and docs.",
  });
  assertEquals(earlierFindingGaps(expected, [fixed(1), fixed(2)]), []);
  assertEquals(earlierFindingGaps([], []), []);
  assertEquals(earlierFindingGaps(["first"], [fixed(1)]), []);
  for (
    const verdicts of [
      [],
      [fixed(1)],
      [fixed(1), fixed(1), fixed(2)],
      [fixed(1), { index: 2, verdict: "partly" as const, note: "docs remain" }],
      [fixed(1), {
        index: 2,
        verdict: "not fixed" as const,
        note: "still wrong",
      }],
    ]
  ) assertEquals(earlierFindingGaps(expected, verdicts).length > 0, true);
});

Deno.test("earlier findings - malformed verdicts never become a clean result", () => {
  assertEquals(parseEarlierVerdicts(undefined), []);
  assertEquals(
    parseEarlierVerdicts([{ index: 1, verdict: "fixed", note: "checked" }]),
    [{ index: 1, verdict: "fixed", note: "checked" }],
  );
  for (
    const value of [
      null,
      {},
      [null],
      [{ index: 0, verdict: "fixed", note: "x" }],
      [{ index: 1.5, verdict: "fixed", note: "x" }],
      [{ index: 1, verdict: "yes", note: "x" }],
      [{ index: 1, verdict: "fixed", note: " " }],
    ]
  ) {
    assertThrows(() => parseEarlierVerdicts(value));
  }
});
