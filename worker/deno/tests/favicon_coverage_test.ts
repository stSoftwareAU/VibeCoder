/**
 * Tests that favicon coverage is complete across all published pages.
 * Issue #1541 — guards the fixes from #1538 (default layout fallback),
 * #1539 (404.html favicon), and #1540 (homepage page_icon injection).
 *
 * Each assertion is its own Deno.test so failures point to the specific gap.
 * The static-asset checks read files directly; the homepage check drives the
 * real inject_page_metadata.rb over a fixture to assert observable behaviour
 * (the built index.md carries a non-empty page_icon). None run Jekyll, and
 * all complete well under 10 seconds.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertMatch } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

Deno.test("favicon coverage - default layout always emits a favicon link", async () => {
  const root = repoRoot();
  const content = await Deno.readTextFile(`${root}_layouts/default.html`);

  // The layout must render a <link rel="icon"> unconditionally — either via
  // a tag outside any {% if page.page_icon %} block, OR via an {% else %}
  // branch of that block that renders the site-wide favicon.
  const iconPattern = /<link\s+rel=["']icon["']/;

  // Capture every {% if page.page_icon %} ... {% endif %} block. There may
  // be more than one — e.g. a separate block wrapping the <title> emoji.
  const ifBlockRegex =
    /\{%\s*if\s+page\.page_icon\s*%\}[\s\S]*?\{%\s*endif\s*%\}/g;
  const ifBlocks = content.match(ifBlockRegex) ?? [];

  // Case A: a <link rel="icon"> exists outside every such if-block.
  let outsideIf = content;
  for (const block of ifBlocks) {
    outsideIf = outsideIf.replace(block, "");
  }
  const faviconOutsideIf = iconPattern.test(outsideIf);

  // Case B: at least one if-block has an {% else %} branch that renders a
  // favicon pointing at the site-wide asset (assets/favicon.svg).
  let faviconInElseBranch = false;
  for (const block of ifBlocks) {
    const ifElseMatch = block.match(
      /\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/,
    );
    const elseBranch = ifElseMatch?.[1];
    if (
      elseBranch && iconPattern.test(elseBranch) &&
      /favicon\.svg/.test(elseBranch)
    ) {
      faviconInElseBranch = true;
      break;
    }
  }

  assert(
    faviconOutsideIf || faviconInElseBranch,
    '_layouts/default.html must render <link rel="icon"> unconditionally: ' +
      "either outside the {% if page.page_icon %} block, or in an {% else %} " +
      "branch that points to the site-wide assets/favicon.svg.",
  );
});

Deno.test("favicon coverage - 404.html emits a favicon link", async () => {
  const root = repoRoot();
  const content = await Deno.readTextFile(`${root}404.html`);
  assertMatch(
    content,
    /<link\s+rel=["']icon["']/,
    '404.html must contain a <link rel="icon"> tag in <head>.',
  );
});

Deno.test("favicon coverage - site-wide favicon asset exists and is non-empty", async () => {
  const root = repoRoot();
  const path = `${root}assets/favicon.svg`;
  const stat = await Deno.stat(path);
  assert(stat.isFile, `${path} must be a file.`);
  const content = await Deno.readTextFile(path);
  assert(
    content.trim().length > 0,
    `${path} must have non-empty contents.`,
  );
});

Deno.test("favicon coverage - homepage build path sets a non-empty page_icon on index.md", async () => {
  // WHAT (observable behaviour), not HOW (source text): drive the real
  // homepage build path over a fixture and assert the generated index.md
  // ends up with a non-empty `page_icon:` in its front-matter, so the
  // default layout can render an emoji favicon for "/".
  //
  // The pages workflow seeds index.md as a bare `---\nlayout: default\n---`
  // wrapper around README.md, then runs inject_page_metadata.rb. We exercise
  // that script against a controlled fixture so the test survives any rename
  // or refactor of the workflow or the Ruby script — it only fails if the
  // built homepage genuinely loses its page_icon.
  const fixtureRoot = await Deno.makeTempDir({ prefix: "favicon-homepage-" });
  try {
    await Deno.mkdir(`${fixtureRoot}/.github/scripts`, { recursive: true });
    await Deno.mkdir(`${fixtureRoot}/_data`, { recursive: true });
    await Deno.mkdir(`${fixtureRoot}/docs`, { recursive: true });

    // Stage the real injection script so it operates on the fixture root
    // (it resolves its data and root paths from `__dir__`).
    await Deno.copyFile(
      `${repoRoot()}.github/scripts/inject_page_metadata.rb`,
      `${fixtureRoot}/.github/scripts/inject_page_metadata.rb`,
    );

    // README.md carries a page_icon; the homepage must inherit it.
    await Deno.writeTextFile(
      `${fixtureRoot}/_data/page_titles.yml`,
      [
        "README.md:",
        '  title: "Vibe Coder: Overview"',
        '  page_icon: "🚀"',
        "",
      ].join("\n"),
    );

    const readmeBody = "# Vibe Coder\n\nWelcome.\n";
    await Deno.writeTextFile(`${fixtureRoot}/README.md`, readmeBody);
    await Deno.writeTextFile(`${fixtureRoot}/SECURITY.md`, "# Security\n");
    await Deno.writeTextFile(`${fixtureRoot}/AGENTS.md`, "# Agents\n");

    // index.md as produced by the workflow's "Use README as site index" step.
    await Deno.writeTextFile(
      `${fixtureRoot}/index.md`,
      `---\nlayout: default\n---\n\n${readmeBody}`,
    );

    const cmd = new Deno.Command("ruby", {
      args: [`${fixtureRoot}/.github/scripts/inject_page_metadata.rb`],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    assert(
      code === 0,
      `ruby exited non-zero:\n${new TextDecoder().decode(stderr)}`,
    );

    // Assert the observable result: the built homepage's front-matter
    // carries a non-empty page_icon value.
    const indexOut = await Deno.readTextFile(`${fixtureRoot}/index.md`);
    const frontMatter = indexOut.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    const frontMatterBody = frontMatter?.[1];
    assert(
      frontMatterBody !== undefined,
      `built index.md must start with a front-matter block; got:\n${indexOut}`,
    );
    const pageIconLine = frontMatterBody.match(
      /^\s*page_icon\s*:\s*(.+?)\s*$/m,
    );
    const pageIconValue = pageIconLine?.[1];
    assert(
      pageIconValue !== undefined,
      `built index.md front-matter must contain a 'page_icon:' key; got:\n` +
        frontMatterBody,
    );
    // Strip surrounding quotes and confirm the value is non-empty.
    const value = pageIconValue.replace(/^["']|["']$/g, "").trim();
    assert(
      value.length > 0,
      `built index.md 'page_icon:' must be non-empty; got: ${pageIconValue}`,
    );
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});
