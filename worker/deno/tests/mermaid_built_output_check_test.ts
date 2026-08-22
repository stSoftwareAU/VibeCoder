/**
 * Tests for the built-output Mermaid gate (Issue #272).
 *
 * The existing `mermaid_security_level_test.ts` and
 * `mermaid_cdn_integrity_test.ts` assert `_includes/head-custom.html`, the
 * source include. `pages.yml` asserts structural files on the artifact and
 * never looks at `securityLevel` or the SRI hash. A regression during a
 * Mermaid bump that loosened `strict` or dropped `integrity` in the *served*
 * HTML would pass all of it. These tests pin the built output instead.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkBuiltMermaidOutput,
  checkBuiltPage,
  pageUsesMermaid,
} from "../lib/mermaid_built_output_check.ts";

const HARDENED_SCRIPT =
  `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.6/dist/mermaid.min.js" ` +
  `integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ` +
  `crossorigin="anonymous"></script>`;

const STRICT_INIT =
  `<script>mermaid.initialize({ startOnLoad: true, securityLevel: "strict" });</script>`;

function page(...parts: string[]): string {
  return `<!doctype html><html><head>${
    parts.join("")
  }</head><body></body></html>`;
}

/** Write a throwaway `_site` and hand its path to `fn`. */
async function withSite(
  files: Record<string, string>,
  fn: (siteDir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const siteDir = `${root}/_site`;
  for (const [rel, content] of Object.entries(files)) {
    const full = `${siteDir}/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  try {
    await fn(siteDir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Page classification
// ---------------------------------------------------------------------------

Deno.test("pageUsesMermaid - a page with neither the script nor initialize is out of scope", () => {
  assert(!pageUsesMermaid(page("<title>x</title>")));
});

Deno.test("pageUsesMermaid - the CDN script alone brings a page in scope", () => {
  assert(pageUsesMermaid(page(HARDENED_SCRIPT)));
});

Deno.test("pageUsesMermaid - mermaid.initialize alone brings a page in scope", () => {
  assert(pageUsesMermaid(page(STRICT_INIT)));
});

// ---------------------------------------------------------------------------
// Per-page assertions
// ---------------------------------------------------------------------------

Deno.test("checkBuiltPage - a hardened strict page is clean", () => {
  assertEquals(
    checkBuiltPage(page(HARDENED_SCRIPT, STRICT_INIT), "i.html"),
    [],
  );
});

Deno.test("checkBuiltPage - a non-Mermaid page yields nothing", () => {
  assertEquals(checkBuiltPage(page("<title>x</title>"), "i.html"), []);
});

Deno.test("checkBuiltPage - securityLevel loosened in the built page is caught (Issue #272)", () => {
  const html = page(
    HARDENED_SCRIPT,
    `<script>mermaid.initialize({ securityLevel: "loose" });</script>`,
  );
  const findings = checkBuiltPage(html, "index.html");
  assertEquals(findings.length, 1);
  assert(findings[0]!.problem.includes("securityLevel"));
});

Deno.test("checkBuiltPage - a dropped SRI hash in the built page is caught (Issue #272)", () => {
  const html = page(
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.6/dist/mermaid.min.js"></script>`,
    STRICT_INIT,
  );
  const findings = checkBuiltPage(html, "index.html");
  assertEquals(findings.length, 1);
  assert(findings[0]!.problem.includes("SRI-hardened"));
});

Deno.test("checkBuiltPage - a floating major-version pin in the built page is caught", () => {
  const html = page(
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" ` +
      `integrity="sha384-AAAA" crossorigin="anonymous"></script>`,
    STRICT_INIT,
  );
  assertEquals(checkBuiltPage(html, "index.html").length, 1);
});

Deno.test("checkBuiltPage - initialising Mermaid with no verifiable script tag is reported", () => {
  const findings = checkBuiltPage(page(STRICT_INIT), "index.html");
  assertEquals(findings.length, 1);
  assert(findings[0]!.problem.includes("no CDN script tag"));
});

Deno.test("checkBuiltPage - both problems on one page are reported separately", () => {
  const html = page(
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>`,
    `<script>mermaid.initialize({ securityLevel: "loose" });</script>`,
  );
  assertEquals(checkBuiltPage(html, "index.html").length, 2);
});

// ---------------------------------------------------------------------------
// Whole-site scan
// ---------------------------------------------------------------------------

Deno.test("checkBuiltMermaidOutput - a hardened site passes and counts what it saw", async () => {
  await withSite({
    "index.html": page(HARDENED_SCRIPT, STRICT_INIT),
    "docs/OVERVIEW.html": page(HARDENED_SCRIPT, STRICT_INIT),
    "about.html": page("<title>no mermaid here</title>"),
  }, async (siteDir) => {
    const result = await checkBuiltMermaidOutput(siteDir);
    assertEquals(result.status, "PASSED");
    assertEquals(result.pagesScanned, 3);
    assertEquals(result.pagesWithMermaid, 2);
  });
});

Deno.test("checkBuiltMermaidOutput - one loosened page fails the whole site and is named", async () => {
  await withSite({
    "index.html": page(HARDENED_SCRIPT, STRICT_INIT),
    "docs/OVERVIEW.html": page(
      HARDENED_SCRIPT,
      `<script>mermaid.initialize({ securityLevel: "loose" });</script>`,
    ),
  }, async (siteDir) => {
    const result = await checkBuiltMermaidOutput(siteDir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.findings.length, 1);
    assertEquals(result.findings[0]?.page, "docs/OVERVIEW.html");
    assert(result.output.includes("docs/OVERVIEW.html"));
  });
});

Deno.test("checkBuiltMermaidOutput - a missing build is SKIPPED, never PASSED (Issue #272)", async () => {
  const result = await checkBuiltMermaidOutput("/nonexistent/_site");
  assertEquals(result.status, "SKIPPED");
  assertEquals(result.pagesScanned, 0);
  // The whole point: a check that passes when it inspected nothing is how the
  // regression window in #272 stayed open.
  assert(result.output.includes("SKIPPED"));
});

Deno.test("checkBuiltMermaidOutput - a build with no HTML at all is SKIPPED", async () => {
  await withSite({ "assets/x.css": "body{}" }, async (siteDir) => {
    const result = await checkBuiltMermaidOutput(siteDir);
    assertEquals(result.status, "SKIPPED");
  });
});
