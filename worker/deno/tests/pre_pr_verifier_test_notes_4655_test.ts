/**
 * The reply parser's test-change notes (Issue #4655): a malformed note is
 * dropped, never a reason to reject the review, and a field of the wrong type
 * is left out rather than passed on.
 */

import { assertEquals } from "@std/assert";
import {
  parseReviewReply,
  parseTestChangeNotes,
} from "../lib/pre_pr_verifier.ts";

Deno.test("parseTestChangeNotes: a non-array is no notes", () => {
  for (const raw of [undefined, null, "x", 3, {}, { 0: { file: "a.ts" } }]) {
    assertEquals(parseTestChangeNotes(raw), []);
  }
});

Deno.test("parseTestChangeNotes: drops entries that are not objects or lack a file", () => {
  const kept = parseTestChangeNotes([
    null,
    "x",
    3,
    [],
    { line: 1, change: "no file" },
    { file: 5, line: 1, change: "file is a number" },
    { file: "   ", line: 1, change: "blank file" },
    { file: "a_test.ts", line: 2, change: "ok" },
  ]);
  assertEquals(kept, [{ file: "a_test.ts", line: 2, change: "ok" }]);
});

Deno.test("parseTestChangeNotes: a line is coerced as parseFinding does", () => {
  const lines = parseTestChangeNotes([
    { file: "a.ts", line: "7", change: "c" },
    { file: "a.ts", line: "abc", change: "c" },
    { file: "a.ts", change: "c" },
    { file: "a.ts", line: 4.5, change: "c" },
  ]).map((n) => n.line);
  assertEquals(lines, [7, 0, 0, 4.5]);
});

Deno.test("parseTestChangeNotes: keeps the well-typed optional fields, trimmed", () => {
  const kept = parseTestChangeNotes([{
    file: " tests/retry_test.ts ",
    line: 9,
    change: "  expects 3 retries  ",
    kind: "expected-value",
    criterionQuote: " old quote ",
    failsWithoutChange: " fails on the base branch ",
    verdict: "justified",
    obsolete: " the old default of 2 ",
    remaining: "the new default of 3",
    coverage: [
      { role: "existing", path: " tests/retry_test.ts ", name: " retries " },
      { role: "gone", path: "tests/old_test.ts" },
    ],
    requirementQuote: "retries three times",
    verification: "reverted the default; the test failed",
    ownerQuestion: "should it be 3?",
  }]);
  assertEquals(kept, [{
    file: "tests/retry_test.ts",
    line: 9,
    change: "expects 3 retries",
    kind: "expected-value",
    criterionQuote: "old quote",
    failsWithoutChange: "fails on the base branch",
    verdict: "justified",
    obsolete: "the old default of 2",
    remaining: "the new default of 3",
    coverage: [
      { role: "existing", path: "tests/retry_test.ts", name: "retries" },
      { role: "gone", path: "tests/old_test.ts" },
    ],
    requirementQuote: "retries three times",
    verification: "reverted the default; the test failed",
    ownerQuestion: "should it be 3?",
  }]);
});

Deno.test("parseTestChangeNotes: a field of the wrong type is left out", () => {
  const [note] = parseTestChangeNotes([{
    file: "a_test.ts",
    line: 1,
    change: "c",
    kind: "bogus",
    verdict: "maybe",
    failsWithoutChange: 3,
    obsolete: 5,
    remaining: "   ",
    requirementQuote: ["not", "a", "string"],
    coverage: "tests/a_test.ts",
  }]);
  assertEquals(note, { file: "a_test.ts", line: 1, change: "c" });
});

Deno.test("parseTestChangeNotes: a boolean failsWithoutChange is kept as it is", () => {
  const [note] = parseTestChangeNotes([{
    file: "a_test.ts",
    line: 1,
    change: "c",
    failsWithoutChange: true,
  }]);
  assertEquals(note?.failsWithoutChange, true);
});

Deno.test("parseTestChangeNotes: a coverage entry needs a valid role and a path", () => {
  const [note] = parseTestChangeNotes([{
    file: "a_test.ts",
    line: 1,
    change: "c",
    coverage: [
      { role: "replacement", path: "tests/new_test.ts", name: "" },
      { role: "neither", path: "tests/x_test.ts" },
      { role: "existing" },
      { role: "existing", path: "" },
      "tests/y_test.ts",
      null,
      { role: "gone", path: "tests/z_test.ts", name: 4 },
    ],
  }]);
  assertEquals(note?.coverage, [
    { role: "replacement", path: "tests/new_test.ts" },
    { role: "gone", path: "tests/z_test.ts" },
  ]);
});

Deno.test("parseTestChangeNotes: all coverage entries invalid leaves an empty list", () => {
  const [note] = parseTestChangeNotes([{
    file: "a_test.ts",
    line: 1,
    change: "c",
    coverage: [{ role: "nope", path: "x" }],
  }]);
  assertEquals(note?.coverage, []);
});

Deno.test("parseReviewReply: malformed notes do not reject the review", () => {
  const reply = parseReviewReply(JSON.stringify({
    summary: "s",
    findings: [],
    testChanges: "meaningful",
    testChangeNotes: [
      null,
      { file: "a.ts", line: 1, change: "c", verdict: "justified" },
      { line: 2, change: "no file" },
    ],
  }));
  assertEquals(reply.testChangeNotes, [
    { file: "a.ts", line: 1, change: "c", verdict: "justified" },
  ]);
});

Deno.test("parseReviewReply: a missing or non-array testChangeNotes is no notes", () => {
  for (const notes of [undefined, "none", { file: "a.ts" }]) {
    const body: Record<string, unknown> = {
      summary: "s",
      findings: [],
      testChanges: "none",
    };
    if (notes !== undefined) body.testChangeNotes = notes;
    assertEquals(parseReviewReply(JSON.stringify(body)).testChangeNotes, []);
  }
});
