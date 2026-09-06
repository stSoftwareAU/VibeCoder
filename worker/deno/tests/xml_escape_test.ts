/**
 * Tests for lib/xml_escape.ts (Issue #1220).
 *
 * The module has one stated invariant — `&` is replaced first, or the
 * entities the other four introduce would themselves be re-escaped — and it
 * is the single owner of the escape both OS-level persistence descriptors
 * depend on. Both are pinned here rather than incidentally from a consumer's
 * suite.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { escapeXml } from "../lib/xml_escape.ts";

Deno.test("escapeXml - replaces all five XML metacharacters", () => {
  assertEquals(
    escapeXml(`&<>"'`),
    "&amp;&lt;&gt;&quot;&apos;",
  );
});

Deno.test("escapeXml - an ampersand is escaped once, never twice", () => {
  // The order invariant: had `&` been replaced last, the `&` of `&lt;` would
  // have been re-escaped into `&amp;lt;`.
  assertEquals(escapeXml("<"), "&lt;");
  assertEquals(escapeXml("&lt;"), "&amp;lt;");
  assertEquals(escapeXml("&amp;"), "&amp;amp;");
});

Deno.test("escapeXml - a value that closes an element cannot survive", () => {
  assertEquals(
    escapeXml("</string><key>Program</key><string>/tmp/evil"),
    "&lt;/string&gt;&lt;key&gt;Program&lt;/key&gt;&lt;string&gt;/tmp/evil",
  );
});

Deno.test("escapeXml - leaves text with nothing to escape untouched", () => {
  assertEquals(escapeXml(""), "");
  assertEquals(escapeXml("/opt/vibe/run.sh"), "/opt/vibe/run.sh");
  assertEquals(escapeXml("naïve — ünïcode ✓"), "naïve — ünïcode ✓");
});

Deno.test("escapeXml - escapes every occurrence, not just the first", () => {
  assertEquals(escapeXml("a<b<c"), "a&lt;b&lt;c");
  assertEquals(escapeXml("R&D & Co"), "R&amp;D &amp; Co");
});
