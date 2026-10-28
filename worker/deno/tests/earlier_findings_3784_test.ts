import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  type EarlierFinding,
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

const original = {
  file: "a.ts",
  line: 2,
  problem: "two paths broken",
  fix: "fix both call sites",
};

Deno.test("earlier findings - a gap quotes the original as text with the reviewer's note and the original Fix", () => {
  const [gap] = earlierFindingGaps([original], [
    { index: 1, verdict: "partly", note: "the second call site is unchanged" },
  ]);
  assertEquals(gap!.file, "(earlier review)");
  assertStringIncludes(gap!.problem, "a.ts:2 — two paths broken");
  assertStringIncludes(
    gap!.problem,
    "verdict is partly: the second call site is unchanged",
  );
  assertEquals(gap!.problem.includes("{"), false);
  assertEquals(gap!.problem.includes("\\"), false);
  assertEquals(gap!.fix, "fix both call sites");
  assertEquals(gap!.earlier, original);
  assertStringIncludes(
    earlierFindingGaps([original], [])[0]!.problem,
    "returned no verdict",
  );
  const fixed = { index: 1, verdict: "fixed" as const, note: "ok" };
  assertStringIncludes(
    earlierFindingGaps([original], [fixed, fixed])[0]!.problem,
    "more than one verdict",
  );
});

Deno.test("earlier findings - a gap of a gap carries the original, never the wrapper", () => {
  const partly = (n: string) => [{
    index: 1,
    verdict: "partly" as const,
    note: n,
  }];
  let finding: EarlierFinding = original;
  for (let round = 0; round < 4; round++) {
    finding = earlierFindingGaps([finding], partly(`round ${round}`))[0]!;
  }
  assertEquals(finding.earlier, original);
  assertEquals(finding.fix, original.fix);
  assertEquals(
    finding.problem.split("Earlier finding").length - 1,
    1,
  );
  assertStringIncludes(finding.problem, "round 3");
  assertEquals(finding.problem.includes("round 2"), false);
});

Deno.test("earlier findings - a posted gap quoted as text unwraps to the original", () => {
  const verdicts = [{ index: 1, verdict: "not fixed" as const, note: "no" }];
  const first = earlierFindingGaps(
    ["**`a.ts:2`**: broken\n\n**Fix:** both"],
    verdicts,
  )[0]!;
  const posted =
    `**\`(earlier review)\`**: ${first.problem}\n\n**Fix:** ${first.fix}`;
  const second = earlierFindingGaps([posted], verdicts)[0]!;
  assertEquals(second.problem.split("Earlier finding").length - 1, 1);
  assertStringIncludes(second.problem, "**`a.ts:2`**: broken");
  assertStringIncludes(second.problem, "**Fix:** both");
});

Deno.test("earlier findings - a posted text gap does not grow over several rounds", () => {
  const verdicts = [{ index: 1, verdict: "not fixed" as const, note: "no" }];
  const originalText = "**`a.ts:2`**: broken\n\n**Fix:** both";
  let text = originalText;
  const quoted: string[] = [];
  for (let round = 0; round < 4; round++) {
    const gap = earlierFindingGaps([text], verdicts)[0]!;
    quoted.push(gap.problem.slice(gap.problem.indexOf("Original finding: ")));
    text = `**\`(earlier review)\`**: ${gap.problem}\n\n**Fix:** ${gap.fix}`;
    text = extractEarlierFindings(text).join("\n");
  }
  assertEquals(quoted[3], quoted[1]);
  assertEquals(quoted[1], `Original finding: ${originalText}`);
  assertEquals(text.split("Resolve every ask").length - 1, 1);
  assertEquals(text.split("**Fix:** both").length - 1, 1);
});

Deno.test("earlier findings - a gap pins its file and line, and only a real gap is unwrapped", () => {
  const [textGap] = earlierFindingGaps(["plain finding"], []);
  assertEquals(textGap!.file, "(earlier review)");
  assertEquals(textGap!.line, 0);
  const [structured] = earlierFindingGaps([original], []);
  assertEquals(structured!.file, "(earlier review)");
  assertEquals(structured!.line, 0);
  // A non-gap finding that carries `earlier` data is itself the original.
  const other = { file: "b.ts", line: 3, problem: "other", fix: "do b" };
  const carrying = { ...original, earlier: other };
  const [gap] = earlierFindingGaps([carrying], []);
  assertEquals(gap!.earlier, carrying);
  assertStringIncludes(gap!.problem, "a.ts:2 — two paths broken");
  // A legacy gap without `earlier` is quoted as it is.
  const legacy = {
    file: "(earlier review)",
    line: 0,
    problem: "legacy problem",
    fix: "legacy fix",
  };
  const [legacyGap] = earlierFindingGaps([legacy], []);
  assertEquals(legacyGap!.earlier, legacy);
  assertStringIncludes(legacyGap!.problem, "(earlier review) — legacy problem");
});
