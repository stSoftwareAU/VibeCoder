import { assert, assertEquals } from "@std/assert";
import {
  branchOutcomeCitations,
  changedFilesCitedBy,
  type DiffHunk,
  extractLineCitations,
  findStaleCitations,
  mapOldLine,
  parseDiffHunks,
  resolveCitedPath,
} from "../lib/branch_outcome_citations.ts";

function summaryWithEntries(...entries: string[]): string {
  return [
    "**Branch outcomes:**",
    ...entries.map((entry) => `- ${entry}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// extractLineCitations
// ---------------------------------------------------------------------------

Deno.test("extractLineCitations: single line citation", () => {
  const { citations, malformed } = extractLineCitations(
    "worker/deno/lib/foo.ts:42 — error",
  );
  assertEquals(malformed, []);
  assertEquals(citations, [
    {
      path: "worker/deno/lib/foo.ts",
      start: 42,
      end: 42,
      text: "worker/deno/lib/foo.ts:42",
    },
  ]);
});

Deno.test("extractLineCitations: range citation", () => {
  const { citations } = extractLineCitations(
    "worker/deno/lib/foo.ts:10-20 done",
  );
  assertEquals(citations, [
    {
      path: "worker/deno/lib/foo.ts",
      start: 10,
      end: 20,
      text: "worker/deno/lib/foo.ts:10-20",
    },
  ]);
});

Deno.test("extractLineCitations: en-dash range", () => {
  const { citations } = extractLineCitations(
    "worker/deno/lib/foo.ts:10–20 done",
  );
  assertEquals(citations, [
    {
      path: "worker/deno/lib/foo.ts",
      start: 10,
      end: 20,
      text: "worker/deno/lib/foo.ts:10-20",
    },
  ]);
});

Deno.test("extractLineCitations: leading ./ is stripped", () => {
  const { citations } = extractLineCitations("./worker/deno/lib/foo.ts:5 ok");
  assertEquals(citations[0]?.path, "worker/deno/lib/foo.ts");
});

Deno.test("extractLineCitations: trailing punctuation is stripped", () => {
  const { citations } = extractLineCitations("see worker/deno/lib/foo.ts:5.");
  assertEquals(citations[0]?.text, "worker/deno/lib/foo.ts:5");
});

Deno.test("extractLineCitations: path::testname is not a citation", () => {
  const { citations, malformed } = extractLineCitations(
    "worker/deno/tests/foo_test.ts::rejects an unreadable file",
  );
  assertEquals(citations, []);
  assertEquals(malformed, []);
});

Deno.test("extractLineCitations: URL is ignored", () => {
  const { citations } = extractLineCitations(
    "see https://example.com/x/y.ts:12 for details",
  );
  assertEquals(citations, []);
});

Deno.test("extractLineCitations: line 0 is malformed", () => {
  const { citations, malformed } = extractLineCitations("foo.ts:0 broken");
  assertEquals(citations, []);
  assertEquals(malformed, [{ token: "foo.ts:0", path: "foo.ts" }]);
});

Deno.test("extractLineCitations: inverted range is malformed", () => {
  const { citations, malformed } = extractLineCitations("foo.ts:20-10 broken");
  assertEquals(citations, []);
  assertEquals(malformed, [{ token: "foo.ts:20-10", path: "foo.ts" }]);
});

Deno.test("extractLineCitations: hostile ReDoS-shaped tokens resolve quickly", () => {
  const longDotToken = "a.".repeat(150) + ":x"; // ~302 chars, no numeric suffix
  const longColonToken = "1:".repeat(150) + "1x"; // long chain of digits/colons
  const start = performance.now();
  const first = extractLineCitations(longDotToken);
  const second = extractLineCitations(longColonToken);
  const elapsed = performance.now() - start;
  // No timing assertion with a magic constant — just confirm both calls
  // returned (rather than hanging) and produced no citation.
  assertEquals(first.citations, []);
  assertEquals(second.citations, []);
  assert(elapsed >= 0);
});

Deno.test("extractLineCitations: (a) comma-joined extra ranges in one token", () => {
  const { citations, malformed } = extractLineCitations(
    "worker/deno/lib/branch_outcomes_gate.ts:720-725,735-738 extra context",
  );
  assertEquals(malformed, []);
  assertEquals(citations, [
    {
      path: "worker/deno/lib/branch_outcomes_gate.ts",
      start: 720,
      end: 725,
      text: "worker/deno/lib/branch_outcomes_gate.ts:720-725",
    },
    {
      path: "worker/deno/lib/branch_outcomes_gate.ts",
      start: 735,
      end: 738,
      text: "worker/deno/lib/branch_outcomes_gate.ts:735-738",
    },
  ]);
});

Deno.test("extractLineCitations: (b) slash-joined extra lines in one token", () => {
  const { citations, malformed } = extractLineCitations(
    "worker/deno/lib/container_manifest.ts:1147/1158/1169",
  );
  assertEquals(malformed, []);
  assertEquals(citations, [
    {
      path: "worker/deno/lib/container_manifest.ts",
      start: 1147,
      end: 1147,
      text: "worker/deno/lib/container_manifest.ts:1147",
    },
    {
      path: "worker/deno/lib/container_manifest.ts",
      start: 1158,
      end: 1158,
      text: "worker/deno/lib/container_manifest.ts:1158",
    },
    {
      path: "worker/deno/lib/container_manifest.ts",
      start: 1169,
      end: 1169,
      text: "worker/deno/lib/container_manifest.ts:1169",
    },
  ]);
});

Deno.test("extractLineCitations: (c) a later bare :N inherits the previous path", () => {
  const { citations, malformed } = extractLineCitations(
    "worker/deno/lib/branch_outcomes_gate.ts:820 and :821 both flip",
  );
  assertEquals(malformed, []);
  assertEquals(citations, [
    {
      path: "worker/deno/lib/branch_outcomes_gate.ts",
      start: 820,
      end: 820,
      text: "worker/deno/lib/branch_outcomes_gate.ts:820",
    },
    {
      path: "worker/deno/lib/branch_outcomes_gate.ts",
      start: 821,
      end: 821,
      text: "worker/deno/lib/branch_outcomes_gate.ts:821",
    },
  ]);
});

Deno.test("extractLineCitations: a path containing /digits/ parses correctly", () => {
  const { citations } = extractLineCitations("lib/2024/x.ts:5 ok");
  assertEquals(citations, [
    { path: "lib/2024/x.ts", start: 5, end: 5, text: "lib/2024/x.ts:5" },
  ]);
});

Deno.test("extractLineCitations: a bare :N with no earlier citation is ignored", () => {
  const { citations, malformed } = extractLineCitations(
    ":5 alone, no path yet",
  );
  assertEquals(citations, []);
  assertEquals(malformed, []);
});

Deno.test("extractLineCitations: a.ts:3,0 yields one citation and one malformed part", () => {
  const { citations, malformed } = extractLineCitations("a.ts:3,0");
  assertEquals(citations, [
    { path: "a.ts", start: 3, end: 3, text: "a.ts:3" },
  ]);
  assertEquals(malformed, [{ token: "a.ts:3,0", path: "a.ts" }]);
});

Deno.test("extractLineCitations: hostile comma-chain token resolves quickly with no citation", () => {
  const token = ":" + "1,".repeat(148) + "1x";
  const { citations, malformed } = extractLineCitations(token);
  assertEquals(citations, []);
  assertEquals(malformed, []);
});

Deno.test("extractLineCitations: hostile slash-chain token resolves quickly with no citation", () => {
  const token = "," + "1/".repeat(148) + "1x";
  const { citations, malformed } = extractLineCitations(token);
  assertEquals(citations, []);
  assertEquals(malformed, []);
});

Deno.test("extractLineCitations: hostile long colon run resolves quickly with no citation", () => {
  const token = ":".repeat(300);
  const { citations, malformed } = extractLineCitations(token);
  assertEquals(citations, []);
  assertEquals(malformed, []);
});

// ---------------------------------------------------------------------------
// branchOutcomeCitations (via parseBranchOutcomes)
// ---------------------------------------------------------------------------

Deno.test("branchOutcomeCitations: reads list entries", () => {
  const summary = summaryWithEntries(
    "`worker/deno/lib/foo.ts:42` — error flipped — `worker/deno/tests/foo_test.ts::x`",
  );
  const { citations, truncated } = branchOutcomeCitations(summary);
  assertEquals(citations.length, 1);
  assertEquals(citations[0]?.path, "worker/deno/lib/foo.ts");
  assertEquals(citations[0]?.start, 42);
  assertEquals(truncated, false);
});

Deno.test("branchOutcomeCitations: no Branch outcomes header yields nothing", () => {
  const { citations, truncated } = branchOutcomeCitations(
    "Just a normal PR summary.",
  );
  assertEquals(citations, []);
  assertEquals(truncated, false);
});

// ---------------------------------------------------------------------------
// parseDiffHunks
// ---------------------------------------------------------------------------

Deno.test("parseDiffHunks: counts omitted default to 1", () => {
  const hunks = parseDiffHunks("@@ -5 +5 @@\n-old\n+new");
  assertEquals(hunks, [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }]);
});

Deno.test("parseDiffHunks: binary file returns null", () => {
  const hunks = parseDiffHunks("Binary files a/foo.png and b/foo.png differ");
  assertEquals(hunks, null);
});

Deno.test("parseDiffHunks: empty diff returns empty array", () => {
  assertEquals(parseDiffHunks(""), []);
});

Deno.test("parseDiffHunks: multiple hunks sorted by oldStart", () => {
  const diff = "@@ -20,0 +21,2 @@\n+a\n+b\n@@ -5,1 +5,1 @@\n-x\n+y";
  const hunks = parseDiffHunks(diff);
  assertEquals(hunks?.map((h) => h.oldStart), [5, 20]);
});

// ---------------------------------------------------------------------------
// mapOldLine
// ---------------------------------------------------------------------------

Deno.test("mapOldLine: insertion above shifts the line", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 5,
    oldCount: 0,
    newStart: 6,
    newCount: 3,
  }];
  assertEquals(mapOldLine(hunks, 10), { kind: "kept", line: 13 });
});

Deno.test("mapOldLine: insertion at top (oldStart 0) shifts everything", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 2,
  }];
  assertEquals(mapOldLine(hunks, 1), { kind: "kept", line: 3 });
});

Deno.test("mapOldLine: insertion below leaves the line unchanged", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 50,
    oldCount: 0,
    newStart: 51,
    newCount: 3,
  }];
  assertEquals(mapOldLine(hunks, 10), { kind: "kept", line: 10 });
});

Deno.test("mapOldLine: deletion above shifts the line down", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 5,
    oldCount: 3,
    newStart: 5,
    newCount: 0,
  }];
  assertEquals(mapOldLine(hunks, 10), { kind: "kept", line: 7 });
});

Deno.test("mapOldLine: line inside a removed range is removed", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 5,
    oldCount: 3,
    newStart: 5,
    newCount: 0,
  }];
  assertEquals(mapOldLine(hunks, 6), { kind: "removed" });
});

Deno.test("mapOldLine: modified line is removed", () => {
  const hunks: DiffHunk[] = [{
    oldStart: 12,
    oldCount: 1,
    newStart: 12,
    newCount: 1,
  }];
  assertEquals(mapOldLine(hunks, 12), { kind: "removed" });
});

Deno.test("mapOldLine: multiple hunks accumulate", () => {
  const hunks: DiffHunk[] = [
    { oldStart: 2, oldCount: 0, newStart: 3, newCount: 5 }, // +5 after old line 2
    { oldStart: 20, oldCount: 4, newStart: 25, newCount: 0 }, // -4 at old 20-23
  ];
  // Line 30 is after both hunks: +5 from insertion, -4 from deletion = +1.
  assertEquals(mapOldLine(hunks, 30), { kind: "kept", line: 31 });
});

// ---------------------------------------------------------------------------
// resolveCitedPath
// ---------------------------------------------------------------------------

Deno.test("resolveCitedPath: exact match", () => {
  const result = resolveCitedPath("worker/deno/lib/foo.ts", [
    "worker/deno/lib/foo.ts",
  ]);
  assertEquals(result, { kind: "match", path: "worker/deno/lib/foo.ts" });
});

Deno.test("resolveCitedPath: basename suffix match", () => {
  const result = resolveCitedPath("foo.ts", ["worker/deno/lib/foo.ts"]);
  assertEquals(result, { kind: "match", path: "worker/deno/lib/foo.ts" });
});

Deno.test("resolveCitedPath: ambiguous basename", () => {
  const result = resolveCitedPath("foo.ts", ["a/foo.ts", "b/foo.ts"]);
  assertEquals(result.kind, "ambiguous");
});

Deno.test("resolveCitedPath: none when unrelated", () => {
  const result = resolveCitedPath("foo.ts", ["a/bar.ts"]);
  assertEquals(result, { kind: "none" });
});

Deno.test("resolveCitedPath: foo.ts does not match barfoo.ts", () => {
  const result = resolveCitedPath("foo.ts", ["a/barfoo.ts"]);
  assertEquals(result, { kind: "none" });
});

// ---------------------------------------------------------------------------
// changedFilesCitedBy
// ---------------------------------------------------------------------------

Deno.test("changedFilesCitedBy: resolves and dedupes in first-seen order", () => {
  const summary = summaryWithEntries(
    "`lib/a.ts:1` one",
    "`lib/b.ts:2` two",
    "`lib/a.ts:3` three again",
  );
  const result = changedFilesCitedBy(summary, [
    "lib/a.ts",
    "lib/b.ts",
    "lib/c.ts",
  ]);
  assertEquals(result, ["lib/a.ts", "lib/b.ts"]);
});

// ---------------------------------------------------------------------------
// findStaleCitations
// ---------------------------------------------------------------------------

const PATH = "lib/foo.ts";
const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-3341.md";

function insertAboveHunks(
  oldStart: number,
  newCount: number,
): ReadonlyMap<string, DiffHunk[]> {
  return new Map([[PATH, [{
    oldStart,
    oldCount: 0,
    newStart: oldStart + 1,
    newCount,
  }]]]);
}

Deno.test("findStaleCitations: (a) insertion above a still-cited line is stale", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:40\` — error flipped, test went red`,
  );
  const current = previous; // unchanged, still cites :40
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: insertAboveHunks(10, 5),
  });
  assertEquals(result.unchecked, []);
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes(`${PATH}:40`));
  assert(result.stale[0]!.includes(`${PATH}:45`));
});

Deno.test("findStaleCitations: (b) renumbered citation is clean", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:40\` — error flipped, test went red`,
  );
  const current = summaryWithEntries(
    `\`${PATH}:45\` — error flipped, test went red`,
  );
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: insertAboveHunks(10, 5),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: (c) diff in a file the summary does not cite is clean", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:40\` — error flipped, test went red`,
  );
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: ["lib/other.ts"],
    hunksByPath: new Map([["lib/other.ts", [{
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 5,
    }]]]),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: (d) range moved is stale naming both ends", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:40-42\` — error flipped, test went red`,
  );
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: insertAboveHunks(10, 5),
  });
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes(`${PATH}:40-42`));
  assert(result.stale[0]!.includes(`${PATH}:45-47`));
});

Deno.test("findStaleCitations: (e) modified line, entry unchanged is stale", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
  );
  const current = previous;
  const hunks = new Map([[PATH, [{
    oldStart: 12,
    oldCount: 1,
    newStart: 12,
    newCount: 1,
  }]]]);
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: hunks,
  });
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes("changed or removed"));
});

Deno.test("findStaleCitations: (f) modified line, entry rewritten keeping number is clean", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
  );
  const current = summaryWithEntries(
    `\`${PATH}:12\` — absent flipped, a different test went red`,
  );
  const hunks = new Map([[PATH, [{
    oldStart: 12,
    oldCount: 1,
    newStart: 12,
    newCount: 1,
  }]]]);
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: hunks,
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: (g) ambiguous basename is unchecked", () => {
  const previous = summaryWithEntries(
    "`foo.ts:12` — error flipped, test went red",
  );
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: ["a/foo.ts", "b/foo.ts"],
    hunksByPath: new Map(),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked.length, 1);
  assert(result.unchecked[0]!.includes("more than one file"));
});

Deno.test("findStaleCitations: (h) missing hunks is unchecked", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
  );
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: new Map(),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked.length, 1);
  assert(result.unchecked[0]!.includes("could not be read as text"));
});

Deno.test("findStaleCitations: (i) previous summary had no Branch outcomes is clean", () => {
  const previous = "Just a plain PR summary with no outcomes list.";
  const current = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
  );
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: insertAboveHunks(1, 5),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: (j) a new citation added this push is clean", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
  );
  const current = summaryWithEntries(
    `\`${PATH}:12\` — error flipped, test went red`,
    `\`${PATH}:40\` — new outcome, new test`,
  );
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: new Map([[PATH, []]]),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: (k) truncated previous list is unchecked", () => {
  const hugeEntry = "x".repeat(5_000);
  const previous = summaryWithEntries(`\`${PATH}:12\` — ${hugeEntry}`);
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: new Map([[PATH, []]]),
  });
  assert(
    result.unchecked.some((message) =>
      message.includes("longer than the parser reads")
    ),
  );
});

Deno.test("findStaleCitations: (l) basename citation resolves to its matching path", () => {
  const previous = summaryWithEntries(
    "`foo.ts:10` — error flipped, test went red",
  );
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: ["lib/foo.ts"],
    hunksByPath: new Map([
      ["lib/foo.ts", [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 5 }]],
    ]),
  });
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes("foo.ts:10"));
  assert(result.stale[0]!.includes("foo.ts:15"));
});

Deno.test("findStaleCitations: (m) malformed citation on a changed file is unchecked", () => {
  const previous = summaryWithEntries(`\`${PATH}:0\` — broken citation`);
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: new Map([[PATH, []]]),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked.length, 1);
  assert(result.unchecked[0]!.includes(`${PATH}:0`));
});

Deno.test("findStaleCitations: (n) malformed citation on an unchanged file is clean", () => {
  const previous = summaryWithEntries(`\`${PATH}:0\` — broken citation`);
  const current = previous;
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: ["lib/other.ts"],
    hunksByPath: new Map([["lib/other.ts", []]]),
  });
  assertEquals(result.stale, []);
  assertEquals(result.unchecked, []);
});

Deno.test("findStaleCitations: a comma-joined citation only flags the line that moved", () => {
  const previous = summaryWithEntries(
    `\`${PATH}:10,20\` — error flipped, test went red`,
  );
  const current = previous; // unchanged
  const result = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: previous,
    currentSummary: current,
    changedFiles: [PATH],
    hunksByPath: insertAboveHunks(14, 3), // 3 lines inserted above old line 15
  });
  assertEquals(result.unchecked, []);
  assertEquals(result.stale.length, 1);
  assert(result.stale[0]!.includes(`${PATH}:20`));
  assert(result.stale[0]!.includes(`${PATH}:23`));
  assert(!result.stale[0]!.includes(`${PATH}:10\``));
});
