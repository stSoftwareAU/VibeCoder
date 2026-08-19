/**
 * Tests that every published documentation page has a page_titles.yml entry
 * with a page_icon (emoji favicon). Issue #1380.
 *
 * The inject_page_metadata.rb script processes docs/**\/*.md plus root
 * README.md, SECURITY.md, and AGENTS.md. Any page without a page_titles.yml
 * entry gets no favicon — this test ensures none are missing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

/** Paths excluded from the completeness check (not user-facing pages). */
const EXCLUDED_PREFIXES = [
  "docs/archive/",
  "docs/pr-summary-",
  "docs/evidence/",
];

/**
 * Resolve the repository root (two levels up from worker/deno/).
 */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  // thisDir ends with worker/deno/tests/
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

Deno.test("page_titles.yml covers all published pages with page_icon", async () => {
  const root = repoRoot();

  // Load page_titles.yml
  const yamlPath = `${root}_data/page_titles.yml`;
  const yamlContent = await Deno.readTextFile(yamlPath);
  const metadata = parseYaml(yamlContent) as Record<
    string,
    { title?: string; page_icon?: string }
  >;

  // Collect published markdown paths the same way inject_page_metadata.rb does
  const publishedPaths: string[] = [];

  // docs/**/*.md
  for await (const entry of walkMarkdown(`${root}docs`)) {
    const relPath = entry.slice(root.length);
    if (EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
      continue;
    }
    publishedPaths.push(relPath);
  }

  // Root pages that inject_page_metadata.rb also processes
  for (const name of ["README.md", "SECURITY.md", "AGENTS.md"]) {
    try {
      await Deno.stat(`${root}${name}`);
      publishedPaths.push(name);
    } catch {
      // File may not exist in some environments
    }
  }

  // Verify every published page has an entry with a page_icon
  const missing: string[] = [];
  for (const path of publishedPaths) {
    const entry = metadata[path];
    if (!entry || !entry.page_icon) {
      missing.push(path);
    }
  }

  assertEquals(
    missing,
    [],
    `These published pages are missing a page_icon in _data/page_titles.yml:\n  ${
      missing.join("\n  ")
    }`,
  );

  // Verify every entry has a non-empty page_icon
  const emptyIcons: string[] = [];
  for (const [path, entry] of Object.entries(metadata)) {
    if (!entry.page_icon || entry.page_icon.trim() === "") {
      emptyIcons.push(path);
    }
  }

  assertEquals(
    emptyIcons,
    [],
    `These page_titles.yml entries have empty page_icon:\n  ${
      emptyIcons.join("\n  ")
    }`,
  );
});

/** Recursively walk a directory yielding .md file paths. */
async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkMarkdown(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield fullPath;
    }
  }
}
