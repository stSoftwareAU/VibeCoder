/**
 * Tests for the Mermaid `securityLevel` parser and the published Pages
 * head include (`_includes/head-custom.html`) — Issue #2489.
 *
 * The published config must not use `securityLevel: 'loose'`, which allows
 * unsanitised HTML and `javascript:` href/click directives in attacker-
 * influenced diagram content — a stored-XSS vector on GitHub Pages.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  extractMermaidSecurityLevel,
  isSafeSecurityLevel,
} from "../lib/mermaid_security_level.ts";

/** Resolve the repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

Deno.test("extractMermaidSecurityLevel - reads a single-quoted level", () => {
  const html =
    `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });`;
  assertEquals(extractMermaidSecurityLevel(html), "strict");
});

Deno.test("extractMermaidSecurityLevel - reads a double-quoted level", () => {
  const html = `mermaid.initialize({ securityLevel: "antiscript" });`;
  assertEquals(extractMermaidSecurityLevel(html), "antiscript");
});

Deno.test("extractMermaidSecurityLevel - tolerates extra whitespace", () => {
  const html = `securityLevel   :   'loose'`;
  assertEquals(extractMermaidSecurityLevel(html), "loose");
});

Deno.test("extractMermaidSecurityLevel - returns null when absent", () => {
  const html = `mermaid.initialize({ startOnLoad: false });`;
  assertEquals(extractMermaidSecurityLevel(html), null);
});

Deno.test("isSafeSecurityLevel - strict and antiscript are safe", () => {
  assert(isSafeSecurityLevel("strict"));
  assert(isSafeSecurityLevel("antiscript"));
});

Deno.test("isSafeSecurityLevel - loose and null are unsafe", () => {
  assert(!isSafeSecurityLevel("loose"));
  assert(!isSafeSecurityLevel(null));
});

Deno.test("head-custom.html - published Mermaid config is not 'loose'", async () => {
  const html = await Deno.readTextFile(
    `${repoRoot()}_includes/head-custom.html`,
  );
  const level = extractMermaidSecurityLevel(html);
  assert(
    isSafeSecurityLevel(level),
    `_includes/head-custom.html must use a safe Mermaid securityLevel ` +
      `(strict or antiscript); found ${JSON.stringify(level)}`,
  );
});
