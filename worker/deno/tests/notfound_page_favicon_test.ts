/**
 * Tests for the favicon link on the standalone 404 page.
 * Issue #1539.
 *
 * `404.html` uses `layout: null`, so it bypasses `_layouts/default.html`
 * entirely and therefore does not inherit the site-wide favicon fallback
 * added in #1538. To avoid a blank favicon on the 404 page, `404.html`
 * must declare its own `<link rel="icon">` referencing the site-wide
 * `assets/favicon.svg` asset.
 *
 * The existing README.md → README.html redirect script must be preserved.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const NOTFOUND_PATH = `${repoRoot()}404.html`;

Deno.test("404.html keeps layout: null front matter", async () => {
  const page = await Deno.readTextFile(NOTFOUND_PATH);
  // The page deliberately bypasses the default layout — this is the whole
  // reason the favicon link must live inside 404.html itself.
  assertStringIncludes(
    page,
    "layout: null",
    "404.html must retain its `layout: null` front matter",
  );
});

Deno.test("404.html declares a favicon link to the site-wide asset", async () => {
  const page = await Deno.readTextFile(NOTFOUND_PATH);

  // Extract the <head> block so we can assert the link lives inside <head>.
  const headMatch = page.match(/<head>([\s\S]*?)<\/head>/i);
  assert(headMatch, "404.html must contain a <head> section");
  const head = headMatch?.[1] ?? "";

  // There must be exactly one <link rel="icon"> element in <head>.
  const iconLinks = head.match(/<link\s+[^>]*rel=["']icon["'][^>]*>/gi) ?? [];
  assertEquals(
    iconLinks.length,
    1,
    `404.html <head> must contain exactly one <link rel="icon"> (found ${iconLinks.length})`,
  );

  const iconLink = iconLinks[0] ?? "";
  assertStringIncludes(
    iconLink,
    "{{ site.baseurl }}/assets/favicon.svg",
    "favicon link must reference the site-wide assets/favicon.svg via site.baseurl",
  );
  assertStringIncludes(
    iconLink,
    'type="image/svg+xml"',
    "favicon link must declare the SVG MIME type",
  );
});

Deno.test("404.html declares a responsive viewport meta in <head>", async () => {
  const page = await Deno.readTextFile(NOTFOUND_PATH);

  // `404.html` uses `layout: null`, so it does not inherit the viewport meta
  // that `_layouts/default.html` provides. Without it, mobile browsers assume
  // a desktop viewport and render the standalone 404 page zoomed-out. The page
  // must therefore declare its own viewport meta inside <head> (Issue #3170).
  const headMatch = page.match(/<head>([\s\S]*?)<\/head>/i);
  assert(headMatch, "404.html must contain a <head> section");
  const head = headMatch?.[1] ?? "";

  const viewportMetas =
    head.match(/<meta\s+[^>]*name=["']viewport["'][^>]*>/gi) ?? [];
  assertEquals(
    viewportMetas.length,
    1,
    `404.html <head> must contain exactly one viewport meta (found ${viewportMetas.length})`,
  );

  assertStringIncludes(
    viewportMetas[0] ?? "",
    "width=device-width, initial-scale=1",
    "viewport meta must set width=device-width, initial-scale=1",
  );
});

Deno.test("404.html preserves the README.md → README.html redirect", async () => {
  const page = await Deno.readTextFile(NOTFOUND_PATH);
  // The existing behaviour that rewrites stray README.md 404s to README.html
  // must not regress. Assert on the distinguishing parts of the script.
  assertStringIncludes(
    page,
    "window.location.pathname.endsWith('README.md')",
    "README.md redirect guard must be preserved",
  );
  assertStringIncludes(
    page,
    "README\\.md$",
    "README.md → README.html replacement regex must be preserved",
  );
  assertStringIncludes(
    page,
    "window.location.replace(target)",
    "README.md redirect must still call window.location.replace(target)",
  );
});
