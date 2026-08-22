/**
 * Tests for the GitHub Pages CSP parser and the published head include
 * (`_includes/head-custom.html`) — Issue #271.
 *
 * GitHub Pages cannot set response headers, so the include must ship a
 * `<meta http-equiv="Content-Security-Policy">` that permits the pinned
 * Mermaid CDN origin and the existing inline init/theme, and nothing else
 * unexpected.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isTightPagesCsp,
  MERMAID_CDN_ORIGIN,
  parseCspDirectives,
  parsePagesCspMeta,
  permitsExistingPagesInlineAssets,
} from "../lib/pages_csp.ts";

/** Resolve the repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const TIGHT_POLICY =
  `default-src 'none'; script-src 'unsafe-inline' ${MERMAID_CDN_ORIGIN}; ` +
  `style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'`;

Deno.test("parsePagesCspMeta - reads http-equiv then content", () => {
  const html =
    `<meta http-equiv="Content-Security-Policy" content="${TIGHT_POLICY}">`;
  const csp = parsePagesCspMeta(html);
  assert(csp !== null);
  assertEquals(csp.content, TIGHT_POLICY);
});

Deno.test("parsePagesCspMeta - reads content then http-equiv", () => {
  const html =
    `<meta content="${TIGHT_POLICY}" http-equiv="Content-Security-Policy">`;
  const csp = parsePagesCspMeta(html);
  assert(csp !== null);
  assertEquals(csp.content, TIGHT_POLICY);
});

Deno.test("parsePagesCspMeta - returns null when no CSP meta present", () => {
  const html =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width">`;
  assertEquals(parsePagesCspMeta(html), null);
});

Deno.test("parseCspDirectives - splits names and source lists", () => {
  const directives = parseCspDirectives(TIGHT_POLICY);
  assertEquals(directives.get("default-src"), ["'none'"]);
  assertEquals(directives.get("script-src"), [
    "'unsafe-inline'",
    MERMAID_CDN_ORIGIN,
  ]);
  assertEquals(directives.get("object-src"), ["'none'"]);
});

Deno.test("isTightPagesCsp - accepts the published-shape policy", () => {
  assert(isTightPagesCsp({ content: TIGHT_POLICY }));
});

Deno.test("isTightPagesCsp - rejects missing, wildcard, or eval policies", () => {
  assert(!isTightPagesCsp(null));
  assert(
    !isTightPagesCsp({
      content:
        `default-src *; script-src ${MERMAID_CDN_ORIGIN}; object-src 'none'`,
    }),
  );
  assert(
    !isTightPagesCsp({
      content:
        `default-src 'none'; script-src * ${MERMAID_CDN_ORIGIN}; object-src 'none'`,
    }),
  );
  assert(
    !isTightPagesCsp({
      content:
        `default-src 'none'; script-src 'unsafe-eval' ${MERMAID_CDN_ORIGIN}; object-src 'none'`,
    }),
  );
  assert(
    !isTightPagesCsp({
      content:
        `default-src 'none'; script-src 'unsafe-inline'; object-src 'none'`,
    }),
  );
});

Deno.test("permitsExistingPagesInlineAssets - requires inline script/style and favicon img-src", () => {
  assert(permitsExistingPagesInlineAssets({ content: TIGHT_POLICY }));
  assert(
    !permitsExistingPagesInlineAssets({
      content:
        `default-src 'none'; script-src ${MERMAID_CDN_ORIGIN}; object-src 'none'`,
    }),
  );
});

Deno.test("head-custom.html - published Pages CSP is present and tight", async () => {
  const html = await Deno.readTextFile(
    `${repoRoot()}_includes/head-custom.html`,
  );
  const csp = parsePagesCspMeta(html);
  assert(
    isTightPagesCsp(csp),
    `_includes/head-custom.html must ship a tight ` +
      `<meta http-equiv="Content-Security-Policy"> that permits the ` +
      `pinned Mermaid CDN origin; found ${JSON.stringify(csp)}`,
  );
  assert(
    permitsExistingPagesInlineAssets(csp),
    `_includes/head-custom.html CSP must keep 'unsafe-inline' for the ` +
      `existing theme <style> and Mermaid init <script>, plus img-src ` +
      `'self' and data: for the layout favicons; found ` +
      `${JSON.stringify(csp)}`,
  );
});
