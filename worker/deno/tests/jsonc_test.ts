/**
 * Unit tests for stripJsonc (lib/jsonc.ts): line comments, block comments and
 * trailing commas are stripped, and comment markers inside strings survive.
 * Issue #5247 removed the deno_test_config tests that used to reach these
 * branches, so this file pins them directly.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { stripJsonc } from "../lib/jsonc.ts";

Deno.test("stripJsonc - a line comment is dropped up to the end of its line", () => {
  const text = `{\n  // a comment\n  "a": 1 // trailing\n}`;
  assertEquals(JSON.parse(stripJsonc(text)), { a: 1 });
});

Deno.test("stripJsonc - a block comment is dropped, including one spanning lines", () => {
  const text = `{ /* one */ "a": /* two\n lines */ 2 }`;
  assertEquals(JSON.parse(stripJsonc(text)), { a: 2 });
});

Deno.test("stripJsonc - trailing commas before } and ] are dropped", () => {
  const text = `{ "a": [1, 2, ], "b": { "c": 3, }, }`;
  assertEquals(JSON.parse(stripJsonc(text)), { a: [1, 2], b: { c: 3 } });
});

Deno.test("stripJsonc - comment markers inside strings are kept", () => {
  const text = `{ "url": "https://x/*y*/", "q": 'it\\'s // fine' }`;
  assertEquals(
    stripJsonc(text),
    `{ "url": "https://x/*y*/", "q": 'it\\'s // fine' }`,
  );
});

Deno.test("stripJsonc - an unterminated comment at end of input does not throw", () => {
  assertEquals(stripJsonc(`{"a":1}//`), `{"a":1}\n`);
  assertEquals(stripJsonc(`{"a":1}/* open`), `{"a":1}`);
});
