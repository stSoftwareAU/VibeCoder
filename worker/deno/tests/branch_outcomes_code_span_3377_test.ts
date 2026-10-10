/**
 * Issue #3377: a prose line that opens with a code-span mention of
 * `Branch outcomes:` must not be read as a real header.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "../lib/branch_outcomes_gate.ts";

const MENTION = '`Branch outcomes:`, "example" and "helper doc comment".';
const REAL_ENTRY = "- lib/a.ts:3 ok arm → worker/deno/tests/real_test.ts";

Deno.test("validateBranchOutcomes - a code-span mention is not a list, so the gate blocks (#3377)", () => {
  const prSummaryContent = "## Test Plan\n" +
    "I grepped the diff for the nouns the rule governs:\n" +
    `${MENTION}\n`;
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent,
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
  assert(
    result.problems.some((p) => p.includes("no `Branch outcomes:` list")),
    `problems: ${JSON.stringify(result.problems)}`,
  );
  assertEquals(parseBranchOutcomes(prSummaryContent).present, false);
});

const NOT_HEADERS: Array<[string, string]> = [
  ["list item", "- `Branch outcomes:` list in its Test Plan."],
  [
    "indented continuation",
    "  `Branch outcomes:` list, an empty or placeholder one",
  ],
  [
    "whole line in a code span with bold inside",
    "`**Branch outcomes:** none added this round; the earlier rounds' arms:`",
  ],
  ["double-backtick span", "``Branch outcomes:`` and more"],
  ["heading quoted in a code span", "`### Branch outcomes`"],
];

for (const [name, line] of NOT_HEADERS) {
  Deno.test(`parseBranchOutcomes - ${name} is not a header (#3377)`, () => {
    const record = parseBranchOutcomes(`## Test Plan\n${line}\n`);
    assertEquals(record.present, false);
  });
}

Deno.test("parseBranchOutcomes - bold header with a list item still parses (#3377)", () => {
  const record = parseBranchOutcomes(`**Branch outcomes:**\n${REAL_ENTRY}\n`);
  assert(record.present);
  assertEquals(record.entries.length, 1);
});

Deno.test("parseBranchOutcomes - inline none declaration still parses (#3377)", () => {
  const record = parseBranchOutcomes("Branch outcomes: none added\n");
  assert(record.present);
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - bold list-item none declaration still parses (#3377)", () => {
  const record = parseBranchOutcomes("- **Branch outcomes:** none added\n");
  assert(record.present);
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - heading form with a list still parses (#3377)", () => {
  const record = parseBranchOutcomes(`### Branch outcomes\n${REAL_ENTRY}\n`);
  assert(record.present);
  assertEquals(record.entries.length, 1);
});

Deno.test("parseBranchOutcomes - dash-separated none declaration still parses (#3377)", () => {
  const record = parseBranchOutcomes("Branch outcomes — none added\n");
  assert(record.present);
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - a code span after the separator is still a real header (#3377)", () => {
  const summary =
    "**Branch outcomes:** `lib/foo.ts:12` error arm → worker/deno/tests/real_test.ts, flipped red.\n";
  const record = parseBranchOutcomes(summary);
  assert(record.present);
  assertStringIncludes(record.body, "lib/foo.ts:12");
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: summary,
    testsAtHead: new Set(["worker/deno/tests/real_test.ts"]),
  });
  assertEquals(result.valid, true, JSON.stringify(result.problems));
});

Deno.test("parseBranchOutcomes - a mention after a none header is not a second header (#3377)", () => {
  const record = parseBranchOutcomes(
    `**Branch outcomes:** none added\n${MENTION}\n`,
  );
  assert(record.present);
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - a mention in an entry's continuation does not end the list (#3377)", () => {
  const record = parseBranchOutcomes(
    `**Branch outcomes:**\n${REAL_ENTRY}\n` +
      "  `Branch outcomes:` is quoted in this entry's continuation\n",
  );
  assertEquals(record.entries.length, 1);
  assertStringIncludes(record.entries[0]!, "is quoted");
});

Deno.test("parseBranchOutcomes - a mention inside a none header's region stays in scanText (#3377)", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added\n" +
      "`Branch outcomes:` see worker/deno/tests/after_mention_test.ts\n",
  );
  assert(record.noneDeclared);
  assertStringIncludes(record.scanText, "after_mention_test.ts");
});

Deno.test("parseBranchOutcomes - a bare backticked header with a list is still a header (#3377)", () => {
  const record = parseBranchOutcomes(`\`Branch outcomes:\`\n${REAL_ENTRY}\n`);
  assert(record.present);
  assertEquals(record.entries.length, 1);
});

Deno.test("parseBranchOutcomes - a backticked none header is still a header (#3377)", () => {
  const record = parseBranchOutcomes("`Branch outcomes: none added`\n");
  assert(record.present);
  assert(record.noneDeclared);
});

Deno.test("parseBranchOutcomes - a backticked label followed by none is still a header (#3377)", () => {
  const record = parseBranchOutcomes("`Branch outcomes:` none added\n");
  assert(record.present);
  assert(record.noneDeclared);
});
