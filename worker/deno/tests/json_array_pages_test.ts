/**
 * Shared `gh --paginate` page parser (Issue #2895).
 *
 * The regression this guards against is string-blind splitting: a body that
 * contains `[text][ref]`, an escaped `]\n[`, or an escaped quote followed by
 * `][` used to be mistaken for a page boundary and broke `JSON.parse`. These
 * tests drive the parser against exactly that shape of input.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { parseJsonArrayPages } from "../lib/json_array_pages.ts";

Deno.test("parses a single page", () => {
  const raw = `[{"number":1},{"number":2}]`;
  assertEquals(parseJsonArrayPages(raw), [{ number: 1 }, { number: 2 }]);
});

Deno.test("parses two pages concatenated with no separator", () => {
  const raw = `[{"number":1}][{"number":2}]`;
  assertEquals(parseJsonArrayPages(raw), [{ number: 1 }, { number: 2 }]);
});

Deno.test("parses two pages separated by a newline", () => {
  const raw = `[{"number":1}]\n[{"number":2}]`;
  assertEquals(parseJsonArrayPages(raw), [{ number: 1 }, { number: 2 }]);
});

Deno.test("parses two pages separated by spaces", () => {
  const raw = `[{"number":1}]   [{"number":2}]`;
  assertEquals(parseJsonArrayPages(raw), [{ number: 1 }, { number: 2 }]);
});

Deno.test("does not split inside a body containing [text][ref]", () => {
  const raw =
    `[{"number":1,"body":"see [docs][ref]"}][{"number":2,"body":"ok"}]`;
  const result = parseJsonArrayPages(raw) as Array<Record<string, unknown>>;
  assertEquals(result.map((r) => r.number), [1, 2]);
  assertEquals(result[0]!.body, "see [docs][ref]");
});

Deno.test("does not split inside a body containing an escaped ]\\n[", () => {
  const raw = `[{"number":1,"body":"a]\\n[b"}][{"number":2,"body":"ok"}]`;
  const result = parseJsonArrayPages(raw) as Array<Record<string, unknown>>;
  assertEquals(result.map((r) => r.number), [1, 2]);
  assertEquals(result[0]!.body, "a]\n[b");
});

Deno.test(
  "does not split inside a body containing an escaped quote followed by ][",
  () => {
    const raw =
      `[{"number":1,"body":"he said \\"x\\"][y"}][{"number":2,"body":"ok"}]`;
    const result = parseJsonArrayPages(raw) as Array<Record<string, unknown>>;
    assertEquals(result.map((r) => r.number), [1, 2]);
    assertEquals(result[0]!.body, 'he said "x"][y');
  },
);

Deno.test("parses a body with unbalanced { and [ inside a string", () => {
  const raw = `[{"number":1,"body":"[unclosed {"}]`;
  const result = parseJsonArrayPages(raw) as Array<Record<string, unknown>>;
  assertEquals(result[0]!.body, "[unclosed {");
});

Deno.test("empty input returns an empty array", () => {
  assertEquals(parseJsonArrayPages(""), []);
});

Deno.test("whitespace-only input returns an empty array", () => {
  assertEquals(parseJsonArrayPages("   \n\t  "), []);
});

Deno.test("a single empty page returns an empty array", () => {
  assertEquals(parseJsonArrayPages("[]"), []);
});

Deno.test("two empty pages return an empty array", () => {
  assertEquals(parseJsonArrayPages("[][]"), []);
});

Deno.test("throws on a page truncated inside a string", () => {
  assertThrows(
    () => parseJsonArrayPages(`[{"number":1,"body":"abc`),
    Error,
    "mid-page",
  );
});

Deno.test("throws on a page truncated inside an array", () => {
  assertThrows(
    () => parseJsonArrayPages("[1,2"),
    Error,
    "mid-page",
  );
});

Deno.test("throws on a non-array top-level page", () => {
  assertThrows(
    () => parseJsonArrayPages(`{"message":"Not Found"}`),
    Error,
    "not a JSON array page",
  );
});

Deno.test("throws on garbage between pages", () => {
  assertThrows(
    () => parseJsonArrayPages("[1] x [2]"),
    Error,
    "not a JSON array page",
  );
});

Deno.test("throws on a malformed page", () => {
  assertThrows(
    () => parseJsonArrayPages("[1,,2]"),
    Error,
    "malformed JSON array page",
  );
});
