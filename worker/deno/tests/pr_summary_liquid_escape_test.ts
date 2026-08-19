/**
 * Regression test for Issue #1574.
 *
 * The Jekyll "Deploy docs to GitHub Pages" workflow renders every file under
 * `docs/` through Liquid before kramdown. PR summary files often discuss
 * Liquid template syntax in their prose (for example `{% if %}`, `{% else %}`,
 * `{% endif %}`). Unless those literal tags are wrapped in a
 * `{% raw %} ... {% endraw %}` block, Liquid parses them as real template
 * tags and the build fails with `Liquid syntax error`.
 *
 * This test scans every `docs/pr-summary-*.md` file, strips out any properly
 * escaped `{% raw %} ... {% endraw %}` regions, and then asserts that no
 * Liquid block tag remains. If a new PR summary mentions Liquid syntax in
 * prose without escaping it, this test fails before the file ever reaches
 * the GitHub Pages workflow.
 */

import { assertEquals } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const DOCS_DIR = `${repoRoot()}docs`;

/** Liquid block tags that, if unescaped, break the Jekyll build. */
const FORBIDDEN_TAGS = [
  "if",
  "else",
  "elsif",
  "endif",
  "for",
  "endfor",
  "unless",
  "endunless",
  "case",
  "endcase",
];

const FORBIDDEN_TAG_PATTERN = new RegExp(
  String.raw`\{%-?\s*(${FORBIDDEN_TAGS.join("|")})\b[^%]*-?%\}`,
  "g",
);

/** Strip every `{% raw %} ... {% endraw %}` block (including the markers). */
function stripRawBlocks(content: string): string {
  return content.replace(
    /\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g,
    "",
  );
}

interface Offence {
  file: string;
  line: number;
  match: string;
}

/**
 * Directories to scan for `pr-summary-*.md` files. Issue #2173 made
 * `docs/archive/pr-summaries/` the canonical home; the loose `docs/`
 * location stays in the scan list as a defence-in-depth check for any
 * stray legacy files.
 */
const SCAN_DIRS = [
  DOCS_DIR,
  `${DOCS_DIR}/archive/pr-summaries`,
];

async function scanPrSummaries(): Promise<Offence[]> {
  const offences: Offence[] = [];
  for (const dir of SCAN_DIRS) {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    for await (const entry of entries) {
      if (!entry.isFile) continue;
      if (!/^pr-summary-\d+\.md$/.test(entry.name)) continue;

      const path = `${dir}/${entry.name}`;
      const original = await Deno.readTextFile(path);
      const stripped = stripRawBlocks(original);

      for (const match of stripped.matchAll(FORBIDDEN_TAG_PATTERN)) {
        const upToMatch = stripped.slice(0, match.index ?? 0);
        const line = upToMatch.split("\n").length;
        offences.push({
          file: path.slice(repoRoot().length),
          line,
          match: match[0],
        });
      }
    }
  }
  return offences;
}

Deno.test("pr-summary files - no unescaped Liquid block tags", async () => {
  const offences = await scanPrSummaries();
  assertEquals(
    offences,
    [],
    `Found unescaped Liquid block tags in docs/pr-summary-*.md. ` +
      `Wrap the affected prose in '{% raw %} ... {% endraw %}'.\n` +
      offences
        .map((o) => `  ${o.file}:${o.line}  ${o.match}`)
        .join("\n"),
  );
});

Deno.test("pr-summary scanner - detects unescaped {% else %} via stripRawBlocks", () => {
  const sample = "An `{% else %}` tag in prose should be flagged.";
  const matches = [...stripRawBlocks(sample).matchAll(FORBIDDEN_TAG_PATTERN)];
  assertEquals(matches.length, 1);
  assertEquals(matches[0]?.[1], "else");
});

Deno.test("pr-summary scanner - {% raw %} blocks are stripped before scanning", () => {
  const sample = "{% raw %}An `{% else %}` tag inside raw is fine.{% endraw %}";
  const matches = [...stripRawBlocks(sample).matchAll(FORBIDDEN_TAG_PATTERN)];
  assertEquals(matches.length, 0);
});

Deno.test("pr-summary scanner - all forbidden tags are recognised", () => {
  for (const tag of FORBIDDEN_TAGS) {
    const sample = `prose with {% ${tag} %} inside`;
    const matches = [...stripRawBlocks(sample).matchAll(FORBIDDEN_TAG_PATTERN)];
    assertEquals(
      matches.length,
      1,
      `expected forbidden tag ${tag} to be detected`,
    );
  }
});
