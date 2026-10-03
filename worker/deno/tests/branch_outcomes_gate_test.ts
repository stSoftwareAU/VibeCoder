/**
 * Unit tests for the PR-summary branch-outcomes gate (Issue #3147).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBranchOutcomesGateComment,
  namedTestPaths,
  parseBranchOutcomes,
  validateBranchOutcomes,
} from "../lib/branch_outcomes_gate.ts";

// ---------------------------------------------------------------------------
// parseBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - bold paragraph header with a list parses entries", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error — `worker/deno/tests/foo_test.ts::rejects bad input`\n" +
      "- `worker/deno/lib/foo.ts:48` — success — `worker/deno/tests/foo_test.ts::accepts good input`\n",
  );
  assert(record.present);
  assertEquals(record.noneDeclared, false);
  assertEquals(record.entries.length, 2);
  assertStringIncludes(record.entries[0]!, "worker/deno/lib/foo.ts:42");
  assertStringIncludes(record.entries[1]!, "worker/deno/lib/foo.ts:48");
});

Deno.test("parseBranchOutcomes - header as a list item with nested entries does not swallow a sibling bullet", () => {
  const record = parseBranchOutcomes(
    "- Branch outcomes:\n" +
      "  - entry one\n" +
      "  - entry two\n" +
      "- Docs sweep — section: none\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - markdown heading form with following list parses", () => {
  const record = parseBranchOutcomes(
    "#### Branch outcomes\n" +
      "- entry one\n" +
      "- entry two\n",
  );
  assert(record.present);
  assertEquals(record.entries, ["entry one", "entry two"]);
});

Deno.test("parseBranchOutcomes - continuation lines are joined onto the previous entry", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:42` — error —\n" +
      "  `worker/deno/tests/foo_test.ts::rejects bad input`\n",
  );
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assertStringIncludes(
    record.entries[0]!,
    "worker/deno/tests/foo_test.ts::rejects bad input",
  );
});

Deno.test("parseBranchOutcomes - 'none added' is recognised as an honest negative", () => {
  const record = parseBranchOutcomes("**Branch outcomes:** none added\n");
  assert(record.present);
  assert(record.noneDeclared);
  assertEquals(record.entries, []);
});

Deno.test("parseBranchOutcomes - first match wins", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:** none added\n\n" +
      "**Branch outcomes:**\n- entry one\n",
  );
  assert(record.present);
  assert(record.noneDeclared);
  assertEquals(record.entries, []);
});

Deno.test("parseBranchOutcomes - absent header reports not present", () => {
  const record = parseBranchOutcomes("## Summary\n\nFixed the thing.\n");
  assertEquals(record.present, false);
});

// ---------------------------------------------------------------------------
// namedTestPaths
// ---------------------------------------------------------------------------

Deno.test("namedTestPaths - path:line and path::name forms both resolve to the test path", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error — worker/deno/tests/foo_test.ts:42\n" +
      "- worker/deno/lib/foo.ts:48 — success — worker/deno/tests/foo_test.ts::accepts good input\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - URLs are ignored", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- see https://example.com/foo_test.ts for background — worker/deno/tests/foo_test.ts::case\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("namedTestPaths - non-test paths are not returned", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/lib/foo.ts:42 — error (no test named)\n",
  );
  assertEquals(namedTestPaths(record), []);
});

Deno.test("namedTestPaths - duplicate citations are deduplicated", () => {
  const record = parseBranchOutcomes(
    "**Branch outcomes:**\n" +
      "- worker/deno/tests/foo_test.ts::a — worker/deno/tests/foo_test.ts::b\n",
  );
  assertEquals(namedTestPaths(record), ["worker/deno/tests/foo_test.ts"]);
});

// ---------------------------------------------------------------------------
// validateBranchOutcomes
// ---------------------------------------------------------------------------

Deno.test("validateBranchOutcomes - missing list blocks when the diff changes code", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n\nDid a thing.\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "no `Branch outcomes:` list");
});

Deno.test("validateBranchOutcomes - a test absent from testsAtHead blocks and is named in missingTests", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/missing_test.ts::does not exist\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/missing_test.ts"]);
});

Deno.test("validateBranchOutcomes - testsAtHead null with named tests blocks (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: null,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "could not confirm");
});

Deno.test("validateBranchOutcomes - all named tests present passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n" +
      "- success — worker/deno/tests/foo_test.ts::case\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

// An inline (same-line) body — no list follows the header — is the one shape
// that only `namedTestPaths`' body arm reaches (PR #3160 review): a one-line
// `Branch outcomes:` summary naming a test that does not exist must still be
// caught, or the gate's own invented-test case (VibeCoder#3132) slips through.
Deno.test("validateBranchOutcomes - an inline body naming a missing test blocks (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/made_up_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/other_test.ts"]),
  });
  assertEquals(result.valid, false);
  assertEquals(result.missingTests, ["worker/deno/tests/made_up_test.ts"]);
});

Deno.test("validateBranchOutcomes - an inline body naming an existing test passes (Issue #3160)", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent:
      "**Branch outcomes:** `src/foo.ts:12` — error — `worker/deno/tests/foo_test.ts::x`\n",
    testsAtHead: new Set(["worker/deno/tests/foo_test.ts"]),
  });
  assert(result.valid);
  assertEquals(result.missingTests, []);
});

Deno.test("validateBranchOutcomes - 'none added' passes", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** none added\n",
    testsAtHead: new Set(),
  });
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - an empty list blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:**\n\n## Next heading\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "names no outcomes");
});

Deno.test("validateBranchOutcomes - a bare placeholder blocks", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "**Branch outcomes:** tbd\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "bare placeholder");
});

Deno.test("validateBranchOutcomes - a non-code diff (docs + test files only) is not applicable", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["README.md", "worker/deno/tests/foo_test.ts"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assertEquals(result.applicable, false);
  assert(result.valid);
});

Deno.test("validateBranchOutcomes - changedFiles null is applicable (fail closed)", () => {
  const result = validateBranchOutcomes({
    changedFiles: null,
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  assert(result.applicable);
  assertEquals(result.valid, false);
});

Deno.test("buildBranchOutcomesGateComment - names the problem and the required shape", () => {
  const result = validateBranchOutcomes({
    changedFiles: ["web/src/Foo.tsx"],
    prSummaryContent: "## Summary\n",
    testsAtHead: new Set(),
  });
  const comment = buildBranchOutcomesGateComment(result);
  assertStringIncludes(comment, "Branch outcomes not recorded");
  assertStringIncludes(comment, "none added");
});

// ---------------------------------------------------------------------------
// Hostile input (Issue #3147, CODING-STANDARDS "Guard super-linearity by
// behaviour first") — a behaviour assertion, not a wall-clock threshold. A
// quadratic parse would make this test exceed Deno's own test timeout rather
// than merely run slowly, which is the only signal this test needs.
// ---------------------------------------------------------------------------

Deno.test("parseBranchOutcomes - a 100k-char hostile line returns a bounded, well-formed result", () => {
  const hostileEntry = "a.a.a.".repeat(20_000); // ~120k chars, no newline
  const content = `**Branch outcomes:**\n- ${hostileEntry}\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
  assertEquals(record.entries.length, 1);
  assert(record.entries[0]!.length <= 4_000);
});

Deno.test("parseBranchOutcomes - a long run of spaces in the inline body returns a bounded result", () => {
  const spaces = " ".repeat(100_000);
  const content = `**Branch outcomes:**${spaces}none added\n`;
  const record = parseBranchOutcomes(content);
  assert(record.present);
});
