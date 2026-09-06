/**
 * Tests for the NUL framing shared by the agent-side guard shims (Issue #1284).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { encodeNulFields } from "../lib/guard_field_encoding.ts";

Deno.test("encodeNulFields - terminates every field with a NUL", () => {
  assertEquals(encodeNulFields(["MARKER", "a", "b"]), "MARKER\0a\0b\0");
});

Deno.test("encodeNulFields - carries newlines, quotes and backslashes verbatim", () => {
  const body = 'line one\nline "two"\\three\r\n';
  assertEquals(encodeNulFields(["MARKER", body]), `MARKER\0${body}\0`);
});

Deno.test("encodeNulFields - an empty field is still framed", () => {
  assertEquals(encodeNulFields(["MARKER", ""]), "MARKER\0\0");
});

Deno.test("encodeNulFields - no fields encodes to nothing", () => {
  assertEquals(encodeNulFields([]), "");
});
