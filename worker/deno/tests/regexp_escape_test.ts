/**
 * Tests for regexp_escape.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { escapeRegExp } from "../lib/regexp_escape.ts";

Deno.test("escapeRegExp - every metacharacter matches itself literally", () => {
  const literal = String.raw`a.b*c+d?e^f$g{h}i(j)k|l[m]n\o`;
  const re = new RegExp(`^${escapeRegExp(literal)}$`);
  assert(re.test(literal));
  assertEquals(re.test("aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o"), false);
});

Deno.test("escapeRegExp - a backslash cannot escape the character after it", () => {
  // Escaping `*` alone (the old pattern) turns `\*` into `\\*`: a literal
  // backslash then a quantifier, which no longer matches the input.
  const literal = String.raw`**RTK:**\*`;
  assert(new RegExp(escapeRegExp(literal)).test(literal));
});
