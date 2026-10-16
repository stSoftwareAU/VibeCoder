/**
 * Tests for the finding entries parser: each finding's line and `**Fix:**`
 * text (Issue #3784).
 *
 * The producer body is built by the real `reviewBody` from
 * `.claude/skills/review-fleet-prs/scripts/review_log.ts`, so these tests pin
 * the contract the parser reads.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  parseChangeRequestFindingEntries,
  parseChangeRequestFindings,
} from "../lib/change_request_quotes.ts";
import {
  type FableReview,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-3232.md";
const PROBLEM_ONE =
  'Line 146 still says "so pinning each would be a vacuous pin per the rule".';
const FIX_ONE = "Rewrite line 146 so it no longer claims the pin is vacuous.";
const PROBLEM_TWO = 'The absolute-claim rule misses "every" and "all".';
const SUMMARY =
  "This PR fixes the drift check gating issue so review-fix pushes get a model pass too.";

const fableReview = (over: Partial<FableReview> = {}): FableReview => ({
  summary: SUMMARY,
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [],
  checklist: [],
  ...over,
});

/** A producer body: one finding with a line and Fix, one with neither, then notes and summary. */
const REVIEW_BODY = reviewBody(
  "changes_requested",
  fableReview({
    findings: [
      { file: SUMMARY_PATH, line: 146, problem: PROBLEM_ONE, fix: FIX_ONE },
      { file: "CODING-STANDARDS.md", line: 0, problem: PROBLEM_TWO },
    ],
    testChanges: "meaningful",
    testChangeNotes: [
      {
        file: "worker/deno/tests/x_test.ts",
        line: 5,
        change: "expected value changed",
      },
    ],
  }),
  [],
);

Deno.test("parseChangeRequestFindingEntries - a producer body gives each finding's file, line, problem and fix", () => {
  const entries = parseChangeRequestFindingEntries(REVIEW_BODY);
  assertEquals(entries, [
    { file: SUMMARY_PATH, line: 146, problem: PROBLEM_ONE, fix: FIX_ONE },
    { file: "CODING-STANDARDS.md", line: 0, problem: PROBLEM_TWO },
  ]);
});

Deno.test("parseChangeRequestFindingEntries - the notes and closing summary never reach a problem or fix", () => {
  const entries = parseChangeRequestFindingEntries(REVIEW_BODY);
  assertEquals(entries.length, 2);
  for (const entry of entries) {
    assert(!entry.problem.includes(SUMMARY));
    assert(!(entry.fix ?? "").includes(SUMMARY));
    assert(!entry.problem.includes("Also note"));
    assert(!(entry.fix ?? "").includes("Also note"));
    assert(!entry.problem.includes("x_test.ts"));
  }
});

Deno.test("parseChangeRequestFindingEntries - a multi-line Fix joins its lines and stops at the blank line", () => {
  const body = [
    "**`a.ts:3`**: Problem text here.",
    "",
    "**Fix:** first part of the fix",
    "continues on the next line",
    "",
    "Summary paragraph that must not join the fix.",
  ].join("\n");
  const entries = parseChangeRequestFindingEntries(body);
  assertEquals(entries, [
    {
      file: "a.ts",
      line: 3,
      problem: "Problem text here.",
      fix: "first part of the fix continues on the next line",
    },
  ]);
});

Deno.test("parseChangeRequestFindingEntries - a Fix directly followed by the next header stops there", () => {
  const body = [
    "**`a.ts`**: Problem one here.",
    "",
    "**Fix:** fix one text",
    "**`b.ts:9`**: Problem two here.",
    "",
    "**Fix:** fix two.",
  ].join("\n");
  const entries = parseChangeRequestFindingEntries(body);
  assertEquals(entries, [
    {
      file: "a.ts",
      line: 0,
      problem: "Problem one here.",
      fix: "fix one text",
    },
    { file: "b.ts", line: 9, problem: "Problem two here.", fix: "fix two." },
  ]);
});

Deno.test("parseChangeRequestFindingEntries - an empty Fix is omitted", () => {
  const body = [
    "**`a.ts`**: Problem text here.",
    "",
    "**Fix:**",
    "",
    "Summary paragraph.",
  ].join("\n");
  const entries = parseChangeRequestFindingEntries(body);
  assertEquals(entries.length, 1);
  assert(!("fix" in entries[0]!));
});

Deno.test("parseChangeRequestFindingEntries - the :line is read only when it is all digits", () => {
  const body = [
    "**`a.ts:12`**: First.",
    "",
    "**`b.ts`**: Second.",
    "",
    "**`C:path/x.ts`**: Third.",
    "",
    "**`d.ts:12:3`**: Fourth.",
  ].join("\n");
  const entries = parseChangeRequestFindingEntries(body);
  assertEquals(
    entries.map((e) => [e.file, e.line]),
    [
      ["a.ts", 12],
      ["b.ts", 0],
      ["C", 0],
      ["d.ts", 0],
    ],
  );
});

Deno.test("parseChangeRequestFindingEntries - a body with no findings gives []", () => {
  assertEquals(
    parseChangeRequestFindingEntries("Looks good.\n\nAll checks pass."),
    [],
  );
  assertEquals(parseChangeRequestFindingEntries(""), []);
});

Deno.test("parseChangeRequestFindings - still returns only file and problem for the producer body", () => {
  assertEquals(parseChangeRequestFindings(REVIEW_BODY), [
    { file: SUMMARY_PATH, problem: PROBLEM_ONE },
    { file: "CODING-STANDARDS.md", problem: PROBLEM_TWO },
  ]);
});

Deno.test("parseChangeRequestFindingEntries - a long run of spaces and asterisks with no match still returns", () => {
  const run = " *".repeat(25_000);
  const body = [
    `**\`${run}!`,
    "**`a.ts`**: a real finding here.",
    "",
    `**Fix:** ${run}!`,
  ].join("\n");
  const entries = parseChangeRequestFindingEntries(body);
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.file, "a.ts");
});
