/**
 * Regression test for Issue #1689.
 *
 * The default layout's <title> tag must NOT include the page_icon emoji
 * prefix — the favicon already renders the emoji glyph in the browser
 * tab, so duplicating it in the title text reads as "two favicons".
 *
 * These tests assert on the *rendered* <title> output (a small Liquid
 * evaluator drives the template with sample variables) rather than on the
 * source text of the layout. A behaviour-preserving refactor — reflowing
 * the conditional, aliasing a variable, computing the title inline — keeps
 * the rendered title identical and so keeps these tests green; only a real
 * regression (an emoji creeping back into the title, the fallback chain
 * breaking, escaping being dropped) turns them red. This replaces the
 * earlier source-text grep assertions flagged by Issue #2494 (test-audit
 * anti-pattern #2).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const LAYOUT_PATH = `${repoRoot()}_layouts/default.html`;

/** Extract the contents of the first <title>...</title> block. */
function extractTitleBlock(layout: string): string {
  const match = layout.match(/<title>([\s\S]*?)<\/title>/);
  assert(match, "default layout must contain a <title> block");
  return match[1] ?? "";
}

/** A minimal Liquid evaluation context for the variables the title uses. */
interface LiquidContext {
  page?: { title?: string; page_icon?: string };
  site?: { title?: string; github?: { repository_name?: string } };
}

/** HTML-escape the way Liquid's `escape` filter does. */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Resolve a dotted variable path (e.g. "site.github.repository_name"). */
function resolveVar(path: string, ctx: LiquidContext): string | undefined {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur == null ? undefined : String(cur);
}

/** Evaluate a single `{{ ... }}` output expression with `default`/`escape`. */
function evalOutput(expr: string, ctx: LiquidContext): string {
  const segments = expr.split("|").map((s) => s.trim());
  let value = resolveVar(segments[0] ?? "", ctx);
  for (const seg of segments.slice(1)) {
    if (seg === "escape") {
      value = value == null ? value : htmlEscape(value);
    } else if (seg.startsWith("default:")) {
      if (value == null || value === "") {
        value = resolveVar(seg.slice("default:".length).trim(), ctx);
      }
    }
  }
  return value ?? "";
}

/**
 * Render the <title> block for a given context. Handles the single
 * `{% if page.title %}...{% else %}...{% endif %}` conditional and any
 * `{{ ... }}` output tags inside the chosen branch.
 */
function renderTitle(titleBlock: string, ctx: LiquidContext): string {
  const ifElseEndif =
    /\{%\s*if\s+page\.title\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/;
  const m = titleBlock.match(ifElseEndif);
  assert(m, "<title> must use {% if page.title %}...{% else %}...{% endif %}");

  const chosen = resolveVar("page.title", ctx) ? (m[1] ?? "") : (m[2] ?? "");
  return chosen.replace(
    /\{\{\s*([\s\S]*?)\s*\}\}/g,
    (_full, expr: string) => evalOutput(expr, ctx),
  );
}

Deno.test("default layout <title> renders the escaped page.title with no emoji prefix", async () => {
  const titleBlock = extractTitleBlock(await Deno.readTextFile(LAYOUT_PATH));

  // page.title is set, and a page_icon is also present — the icon belongs
  // in the favicon, never in the title text.
  const rendered = renderTitle(titleBlock, {
    page: { title: "Example Page Title", page_icon: "🚀" },
    site: { title: "Vibe Coder", github: { repository_name: "VibeCoder" } },
  });

  assertEquals(
    rendered,
    "Example Page Title",
    "rendered title (page.title branch) must be the plain text title — no emoji prefix, no leading space",
  );
  assert(
    !rendered.includes("🚀"),
    `rendered <title> must not carry the page_icon emoji (got: ${rendered})`,
  );
});

Deno.test("default layout <title> falls back to site.title with no emoji prefix", async () => {
  const titleBlock = extractTitleBlock(await Deno.readTextFile(LAYOUT_PATH));

  // page.title unset → fall back to site.title. page_icon still present.
  const rendered = renderTitle(titleBlock, {
    page: { page_icon: "🚀" },
    site: { title: "Vibe Coder", github: { repository_name: "VibeCoder" } },
  });

  assertEquals(
    rendered,
    "Vibe Coder",
    "rendered title (site.title fallback branch) must be the plain text title — no emoji prefix, no leading space",
  );
  assert(
    !rendered.includes("🚀"),
    `rendered <title> must not carry the page_icon emoji (got: ${rendered})`,
  );
});

Deno.test("default layout <title> falls back to repository_name when site.title is unset", async () => {
  const titleBlock = extractTitleBlock(await Deno.readTextFile(LAYOUT_PATH));

  // Both page.title and site.title unset → final fallback is the repo name.
  const rendered = renderTitle(titleBlock, {
    page: {},
    site: { github: { repository_name: "VibeCoder" } },
  });

  assertEquals(rendered, "VibeCoder");
});

Deno.test("default layout <title> HTML-escapes the page title", async () => {
  const titleBlock = extractTitleBlock(await Deno.readTextFile(LAYOUT_PATH));

  const rendered = renderTitle(titleBlock, {
    page: { title: `A & B <script> "x" 'y'` },
    site: {},
  });

  assertEquals(rendered, "A &amp; B &lt;script&gt; &quot;x&quot; &#39;y&#39;");
});
