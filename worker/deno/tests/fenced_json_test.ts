/**
 * Unit tests for fenced_json.ts — shared fence-tolerant JSON unwrapping
 * (Issue #4115).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { unwrapJsonFence } from "../lib/fenced_json.ts";

Deno.test("unwrapJsonFence - bare JSON passes through unchanged", () => {
  const bare = '{"replacements": []}';
  assertEquals(unwrapJsonFence(bare), bare);
  assertEquals(JSON.parse(unwrapJsonFence(bare)), { replacements: [] });
});

Deno.test("unwrapJsonFence - json-tagged fence is unwrapped", () => {
  assertEquals(
    unwrapJsonFence('```json\n{"a": 1}\n```'),
    '{"a": 1}',
  );
});

Deno.test("unwrapJsonFence - plain fence is unwrapped", () => {
  assertEquals(unwrapJsonFence('```\n{"a": 1}\n```'), '{"a": 1}');
});

Deno.test("unwrapJsonFence - surrounding whitespace and CRLF are tolerated", () => {
  assertEquals(
    unwrapJsonFence('  \n```json\r\n{"a": 1}\r\n```\r\n  '),
    '{"a": 1}',
  );
});

Deno.test("unwrapJsonFence - prose around a fence is returned unchanged by default", () => {
  const before = 'Here you go:\n```json\n{"a": 1}\n```';
  const after = '```json\n{"a": 1}\n```\nThanks.';
  for (const text of [before, after]) {
    assertEquals(unwrapJsonFence(text), text);
    assertThrows(() => JSON.parse(unwrapJsonFence(text)));
  }
});

Deno.test("unwrapJsonFence - allowSurroundingProse unwraps the first fenced block", () => {
  const text = 'Here is my revision:\n```json\n{"a": 1}\n```\nUse {x} next.';
  assertEquals(
    unwrapJsonFence(text, { allowSurroundingProse: true }),
    '{"a": 1}',
  );
});

Deno.test("unwrapJsonFence - allowSurroundingProse without a fence returns the trimmed input", () => {
  assertEquals(
    unwrapJsonFence('  {"a": 1}\n', { allowSurroundingProse: true }),
    '{"a": 1}',
  );
  assertEquals(
    unwrapJsonFence("not json at all", { allowSurroundingProse: true }),
    "not json at all",
  );
});

Deno.test("unwrapJsonFence - malformed JSON inside a fence is unwrapped but still fails to parse", () => {
  const unwrapped = unwrapJsonFence('```json\n{"a": \n```');
  assertEquals(unwrapped, '{"a":');
  assertThrows(() => JSON.parse(unwrapped));
});

Deno.test("unwrapJsonFence - empty fence yields an empty string", () => {
  assertEquals(unwrapJsonFence("``````"), "");
  assertEquals(unwrapJsonFence("```json\n```"), "");
  assertEquals(
    unwrapJsonFence("``````", { allowSurroundingProse: true }),
    "``````",
  );
});

Deno.test("unwrapJsonFence - a bare run of three backticks is not a fence", () => {
  assertEquals(unwrapJsonFence("```"), "```");
  assertEquals(unwrapJsonFence("`````"), "`````");
});

Deno.test("unwrapJsonFence - long hostile backtick and whitespace runs are handled in linear time", () => {
  const ticks = "`".repeat(200000) + "x";
  assertEquals(unwrapJsonFence(ticks), ticks);
  assertEquals(
    unwrapJsonFence(ticks, { allowSurroundingProse: true }),
    ticks,
  );

  const spaces = " ".repeat(200000) + "x";
  assertEquals(unwrapJsonFence(spaces), spaces);
  assertEquals(
    unwrapJsonFence(spaces, { allowSurroundingProse: true }),
    "x",
  );

  const padded = "```" + " ".repeat(200000) + "x```";
  assertEquals(unwrapJsonFence(padded), "x");
  assertEquals(
    unwrapJsonFence(padded, { allowSurroundingProse: true }),
    "x",
  );
});
