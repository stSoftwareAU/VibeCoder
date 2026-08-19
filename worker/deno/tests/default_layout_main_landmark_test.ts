/**
 * Tests for the primary-content `<main>` landmark in the Jekyll default layout.
 * Issue #3171.
 *
 * Every page rendered through `_layouts/default.html` must expose exactly one
 * `<main>` landmark wrapping the rendered `{{ content }}`, so assistive-tech
 * "skip to main content" navigation has somewhere to land. The layout's
 * companion stylesheet (`_includes/head-custom.html`) already targets a `main`
 * selector, so a missing landmark is also a dead-CSS inconsistency.
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
const HEAD_CUSTOM_PATH = `${repoRoot()}_includes/head-custom.html`;

Deno.test("default layout emits exactly one <main> landmark", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  const openTags = layout.match(/<main[\s>]/gi) ?? [];
  const closeTags = layout.match(/<\/main>/gi) ?? [];

  assertEquals(
    openTags.length,
    1,
    "layout must contain exactly one opening <main> tag",
  );
  assertEquals(
    closeTags.length,
    1,
    "layout must contain exactly one closing </main> tag",
  );
});

Deno.test("rendered content sits inside the <main> landmark", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  const mainMatch = layout.match(/<main[\s>][\s\S]*?<\/main>/i);
  assert(mainMatch, "layout must contain a <main>…</main> region");

  assertStringIncludes(
    mainMatch[0],
    "{{ content }}",
    "the rendered {{ content }} must live inside the <main> landmark",
  );
});

Deno.test("the <main> landmark lives in the document body", async () => {
  const layout = await Deno.readTextFile(LAYOUT_PATH);

  const bodyMatch = layout.match(/<body>([\s\S]*)<\/body>/i);
  assert(bodyMatch, "layout must have a <body> element");

  assertStringIncludes(
    bodyMatch[1] ?? "",
    "<main",
    "the <main> landmark must be inside <body>",
  );
});

Deno.test("the existing `main` CSS selector is no longer dead", async () => {
  // The finding noted that head-custom.html styles a `main` selector the
  // layout never emitted. Confirm both halves now agree: the stylesheet keeps
  // its `main` rule and the layout provides the element for it to target.
  const layout = await Deno.readTextFile(LAYOUT_PATH);
  const headCustom = await Deno.readTextFile(HEAD_CUSTOM_PATH);

  assert(
    /(^|[\s,{])main[\s{]/m.test(headCustom),
    "head-custom.html must retain a `main` CSS selector",
  );
  assert(
    /<main[\s>]/i.test(layout),
    "layout must emit a <main> element so the `main` CSS is not dead",
  );
});
