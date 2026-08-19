/**
 * Tests for the site-wide default favicon in the Jekyll default layout.
 * Issue #1538.
 *
 * Every page rendered through `_layouts/default.html` must include a
 * `<link rel="icon">` element. When `page.page_icon` is set the template
 * keeps the existing inline emoji SVG data URL; otherwise it must fall back
 * to the site-wide `assets/favicon.svg` asset.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const LAYOUT_PATH = `${repoRoot()}_layouts/default.html`;
const FAVICON_PATH = `${repoRoot()}assets/favicon.svg`;
const CONFIG_PATH = `${repoRoot()}_config.yml`;

Deno.test("assets/favicon.svg exists and is a small SVG", async () => {
  const stat = await Deno.stat(FAVICON_PATH);
  assert(stat.isFile, "assets/favicon.svg must be a file");
  assert(
    stat.size > 0 && stat.size < 2048,
    `favicon.svg should be non-empty and under 2 KB (got ${stat.size} bytes)`,
  );

  const content = await Deno.readTextFile(FAVICON_PATH);
  assertStringIncludes(content, "<svg", "favicon must contain an <svg> root");
  assertStringIncludes(content, 'xmlns="http://www.w3.org/2000/svg"');
});

Deno.test("_config.yml does not exclude assets/", async () => {
  const config = await Deno.readTextFile(CONFIG_PATH);
  // The exclude list is YAML — match a `- assets` entry exactly so the asset
  // directory is published by Jekyll.
  const excludesAssets = /^\s*-\s*assets\s*$/m.test(config);
  assert(!excludesAssets, "_config.yml must not exclude the assets directory");
});

Deno.test("default layout always emits a favicon link", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  // Branch 1: page_icon present — keep the inline emoji SVG data URL.
  assertStringIncludes(
    layout,
    "{% if page.page_icon %}",
    "layout must keep the page_icon conditional",
  );
  assertStringIncludes(
    layout,
    "data:image/svg+xml,",
    "page_icon branch must emit an inline SVG data URL",
  );

  // Branch 2: fallback — link to the site-wide favicon.svg asset.
  assertStringIncludes(
    layout,
    "{{ site.baseurl }}/assets/favicon.svg",
    "fallback branch must reference the site-wide favicon asset",
  );
  assertStringIncludes(
    layout,
    'type="image/svg+xml"',
    "fallback link must declare the SVG MIME type",
  );

  // The conditional must use {% else %} so exactly one <link rel="icon">
  // element is emitted regardless of whether page_icon is set.
  assertStringIncludes(
    layout,
    "{% else %}",
    "favicon block must use {% if %}/{% else %} so exactly one icon is emitted",
  );
});

Deno.test("default layout favicon data URL uses %20-style escaping (Issue #1688)", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  // Regression guard: cgi_escape produces application/x-www-form-urlencoded
  // output where spaces become `+`. In a data: URI body the `+` is a literal
  // plus character, not a space (RFC 2397/3986), which corrupts the inline
  // SVG and forces browsers to fall back to the default globe favicon.
  assert(
    !/favicon_svg\s*\|\s*cgi_escape/.test(layout),
    "favicon data URL must not use `cgi_escape` — spaces become `+` and break the SVG",
  );

  // The favicon data URL must be encoded with a filter that percent-encodes
  // spaces as %20 (e.g. uri_escape, which uses Addressable::URI.normalize_component).
  const filterMatch = layout.match(
    /data:image\/svg\+xml,\{\{\s*favicon_svg\s*\|\s*([a-z_]+)\s*\}\}/,
  );
  assert(
    filterMatch,
    "favicon link must escape favicon_svg via a Liquid filter",
  );
  const filter = filterMatch[1];
  const spaceSafeFilters = new Set(["uri_escape", "url_encode"]);
  assert(
    spaceSafeFilters.has(filter ?? ""),
    `favicon escape filter must produce %20 for spaces (got \`${filter}\`)`,
  );

  // Behavioural sanity check: the escape contract we rely on is that the
  // SVG's literal spaces survive the round-trip as %20 and the inline SVG
  // decodes back to the original markup. Mirror Jekyll's uri_escape with
  // Deno's encodeURIComponent (both use RFC 3986 percent-encoding) and
  // confirm the rendered href contains %20 rather than `+`.
  const sampleSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔥</text></svg>';
  const encoded = encodeURIComponent(sampleSvg);
  assertStringIncludes(
    encoded,
    "%20",
    "RFC 3986 percent-encoding must encode spaces as %20",
  );
  assert(
    !encoded.includes("+"),
    "RFC 3986 percent-encoding must not use `+` for spaces in data URIs",
  );
  assertEquals(
    decodeURIComponent(encoded),
    sampleSvg,
    "encoded SVG must round-trip back to the original markup",
  );
});

Deno.test("default layout emits a single rel=icon under each branch", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  // Render both branches by stripping Liquid markup and counting <link rel="icon">.
  const head = layout.split("</head>")[0] ?? "";

  // Extract the two branches of the favicon block. Anchor on the
  // {% capture favicon_svg %} marker so we do not pick up the unrelated
  // page_icon conditional inside the <title> tag.
  const ifMatch = head.match(
    /\{%\s*if\s+page\.page_icon\s*%\}\{%\s*capture\s+favicon_svg\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/,
  );
  assert(
    ifMatch,
    "favicon block must use {% if page.page_icon %}{% capture favicon_svg %}…{% else %}…{% endif %}",
  );

  const ifBranch = ifMatch[1] ?? "";
  const elseBranch = ifMatch[2] ?? "";

  // Each rendered branch must contain exactly one <link rel="icon">.
  const countIconLinks = (html: string): number =>
    (html.match(/<link\s+[^>]*rel=["']icon["'][^>]*>/gi) ?? []).length;

  assertEquals(
    countIconLinks(ifBranch),
    1,
    'page_icon branch must emit exactly one <link rel="icon">',
  );
  assertEquals(
    countIconLinks(elseBranch),
    1,
    'fallback branch must emit exactly one <link rel="icon">',
  );
});
