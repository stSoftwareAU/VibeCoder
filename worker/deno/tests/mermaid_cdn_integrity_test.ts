/**
 * Tests for the Mermaid CDN integrity parser and the published Pages head
 * include (`_includes/head-custom.html`) — Issue #3169.
 *
 * The published Mermaid `<script>` must pin an exact version and carry a
 * matching Subresource Integrity (SRI) hash alongside `crossorigin`, so the
 * browser rejects a tampered CDN asset — a supply-chain XSS defence.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isExactVersionPin,
  isHardenedMermaidCdnScript,
  isValidSriHash,
  parseMermaidCdnScript,
} from "../lib/mermaid_cdn_integrity.ts";

/** Resolve the repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

Deno.test("parseMermaidCdnScript - extracts src, version, integrity, crossorigin", () => {
  const html =
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.6/dist/mermaid.min.js"
        integrity="sha384-abc123=="
        crossorigin="anonymous"></script>`;
  const script = parseMermaidCdnScript(html);
  assert(script !== null);
  assertEquals(
    script.src,
    "https://cdn.jsdelivr.net/npm/mermaid@10.9.6/dist/mermaid.min.js",
  );
  assertEquals(script.version, "10.9.6");
  assertEquals(script.integrity, "sha384-abc123==");
  assertEquals(script.crossorigin, "anonymous");
});

Deno.test("parseMermaidCdnScript - reads a floating-major tag with no integrity", () => {
  const html =
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" crossorigin="anonymous"></script>`;
  const script = parseMermaidCdnScript(html);
  assert(script !== null);
  assertEquals(script.version, "10");
  assertEquals(script.integrity, null);
  assertEquals(script.crossorigin, "anonymous");
});

Deno.test("parseMermaidCdnScript - returns null when no mermaid script present", () => {
  const html = `<script src="https://example.com/other.js"></script>`;
  assertEquals(parseMermaidCdnScript(html), null);
});

Deno.test("isExactVersionPin - X.Y.Z is exact, floating tags are not", () => {
  assert(isExactVersionPin("10.9.6"));
  assert(!isExactVersionPin("10"));
  assert(!isExactVersionPin("10.9"));
  assert(!isExactVersionPin("latest"));
  assert(!isExactVersionPin(null));
});

Deno.test("isValidSriHash - accepts sha256/384/512, rejects malformed", () => {
  assert(isValidSriHash("sha384-qX9VvWkP79m+O121ZE6sOYp0nf/pldQ="));
  assert(isValidSriHash("sha256-abc123=="));
  assert(isValidSriHash("sha512-abc123"));
  assert(!isValidSriHash("md5-abc123"));
  assert(!isValidSriHash("sha384-"));
  assert(!isValidSriHash(null));
});

Deno.test("isHardenedMermaidCdnScript - requires pin, SRI, and crossorigin", () => {
  assert(isHardenedMermaidCdnScript({
    src: "x",
    version: "10.9.6",
    integrity: "sha384-abc=",
    crossorigin: "anonymous",
  }));
  // Floating tag → not hardened.
  assert(
    !isHardenedMermaidCdnScript({
      src: "x",
      version: "10",
      integrity: "sha384-abc=",
      crossorigin: "anonymous",
    }),
  );
  // Missing integrity → not hardened.
  assert(
    !isHardenedMermaidCdnScript({
      src: "x",
      version: "10.9.6",
      integrity: null,
      crossorigin: "anonymous",
    }),
  );
  // Missing crossorigin → not hardened.
  assert(
    !isHardenedMermaidCdnScript({
      src: "x",
      version: "10.9.6",
      integrity: "sha384-abc=",
      crossorigin: null,
    }),
  );
  assert(!isHardenedMermaidCdnScript(null));
});

Deno.test("head-custom.html - published Mermaid CDN script is pinned + SRI-hardened", async () => {
  const html = await Deno.readTextFile(
    `${repoRoot()}_includes/head-custom.html`,
  );
  const script = parseMermaidCdnScript(html);
  assert(
    isHardenedMermaidCdnScript(script),
    `_includes/head-custom.html must load Mermaid from an exact version pin ` +
      `with a valid SRI integrity hash and crossorigin; found ` +
      `${JSON.stringify(script)}`,
  );
});
