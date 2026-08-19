/**
 * Tests that the emoji at the start of each published page's H1 heading
 * matches the page_icon in `_data/page_titles.yml` (which is used as the
 * favicon). Issue #1997.
 *
 * Users expect the favicon (browser tab icon) and the emoji at the start
 * of the page heading to be consistent. This test enforces that across
 * every published Markdown page covered by the build-time injection
 * script (`inject_page_metadata.rb`).
 *
 * If the H1 has no emoji prefix, the page_icon should still appear at the
 * start of the H1; if the H1 has an emoji prefix, it must equal the
 * page_icon.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

/** Resolve the repository root (two levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

/**
 * Extract the first emoji at the start of a heading, after optional
 * leading whitespace. Returns the emoji (including any variation selector
 * and ZWJ-joined extensions) or null if the heading does not start with
 * an emoji.
 *
 * Recognises any Extended_Pictographic codepoint plus optional U+FE0F
 * (variation selector) and U+200D-joined sequences (e.g. flag emoji,
 * compound emoji like 🧑‍💻).
 */
export function extractLeadingEmoji(headingText: string): string | null {
  // The first non-whitespace token must be a pictographic codepoint.
  const re =
    /^\s*(\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*)/u;
  const m = re.exec(headingText);
  return m && m[1] ? m[1] : null;
}

/**
 * Extract the first H1 heading (line starting with `# `) from Markdown
 * source, skipping any front-matter block. Returns the heading text
 * without the leading `# ` marker, or null if no H1 is found.
 */
export function firstH1(markdown: string): string | null {
  const lines = markdown.split("\n");

  let i = 0;
  // Skip leading front-matter `---\n ... \n---`.
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && (lines[i] ?? "").trim() !== "---") i++;
    i++; // skip closing ---
  }

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^#\s+(.*\S)\s*$/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Read the first H1 from a Markdown file. */
export async function readFirstH1(path: string): Promise<string | null> {
  return firstH1(await Deno.readTextFile(path));
}

Deno.test("extractLeadingEmoji - returns null when heading has no emoji", () => {
  assertEquals(extractLeadingEmoji("Worker Internals"), null);
  assertEquals(extractLeadingEmoji("  Plain heading"), null);
});

Deno.test("extractLeadingEmoji - returns simple BMP emoji", () => {
  assertEquals(extractLeadingEmoji("🚀 VibeCoder"), "🚀");
  assertEquals(extractLeadingEmoji("📚 Lessons learnt"), "📚");
});

Deno.test("extractLeadingEmoji - returns emoji with variation selector", () => {
  // ⚙️ is U+2699 + U+FE0F. 🏗️ is U+1F3D7 + U+FE0F.
  assertEquals(extractLeadingEmoji("⚙️ Configuration Reference"), "⚙️");
  assertEquals(extractLeadingEmoji("🏗️ Worker Internals"), "🏗️");
});

Deno.test("firstH1 - skips front-matter and returns heading text", () => {
  const md =
    '---\nlayout: default\ntitle: "X"\n---\n\n# 🚀 Hello world\n\nbody\n';
  assertEquals(firstH1(md), "🚀 Hello world");
});

Deno.test("firstH1 - returns null when no H1 present", () => {
  assertEquals(firstH1("Just prose.\n\n## subsection\n"), null);
});

Deno.test("firstH1 - ignores H2 and lower-level headings", () => {
  assertEquals(firstH1("## subsection\n# Real heading\n"), "Real heading");
});

Deno.test("page H1 emoji matches favicon (page_icon) for every published page", async () => {
  const root = repoRoot();
  const yaml = await Deno.readTextFile(`${root}_data/page_titles.yml`);
  const metadata = parseYaml(yaml) as Record<
    string,
    { title?: string; page_icon?: string }
  >;

  const mismatches: string[] = [];
  for (const [relPath, entry] of Object.entries(metadata)) {
    if (!entry?.page_icon) continue;
    const fullPath = `${root}${relPath}`;
    let h1: string | null;
    try {
      h1 = await readFirstH1(fullPath);
    } catch (err) {
      // Missing files (e.g. deleted) are surfaced as mismatches so the
      // page_titles.yml entry can be removed.
      mismatches.push(
        `${relPath}: could not read (${(err as Error).message})`,
      );
      continue;
    }
    if (h1 === null) {
      mismatches.push(`${relPath}: no H1 heading found`);
      continue;
    }
    const headingEmoji = extractLeadingEmoji(h1);
    if (headingEmoji !== entry.page_icon) {
      mismatches.push(
        `${relPath}: H1 starts with ${
          headingEmoji ?? "(no emoji)"
        }, page_icon is ${entry.page_icon} — H1: "${h1}"`,
      );
    }
  }

  assertEquals(
    mismatches,
    [],
    `Favicon (page_icon) and H1 emoji must be consistent for every page.\n` +
      `Fix each page's H1 to start with the same emoji as its page_icon in ` +
      `_data/page_titles.yml, or update the page_icon to match the H1.\n` +
      mismatches.map((m) => `  - ${m}`).join("\n"),
  );
});
