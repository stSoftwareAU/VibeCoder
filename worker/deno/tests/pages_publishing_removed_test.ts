/**
 * The GitHub Pages publishing pipeline is gone (Issue #1344).
 *
 * The Jekyll site existed to expose the READMEs while this repository was
 * private. The repository is public, so the docs are read directly on GitHub
 * and the whole publishing pipeline — workflow, Ruby build scripts, Jekyll
 * site files, and the Pages-only quality-gate checks — was removed.
 *
 * These tests assert on the real checkout: the paths must not exist, and the
 * published Markdown must not link at the retired site. They fail loud if a
 * merge or a revert resurrects any of it.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { REPO_ROOT } from "./support/repo_root.ts";

/** Every path the Pages pipeline owned, relative to the repo root. */
const REMOVED_PATHS = [
  // Workflow and its Ruby build steps.
  ".github/workflows/pages.yml",
  ".github/scripts/inject_page_metadata.rb",
  ".github/scripts/normalise_heading_ids.rb",
  ".github/scripts/strip_unpublished_links.rb",
  ".github/scripts/wrap_pr_summary_raw.rb",
  // Jekyll site. `Gemfile`/`Gemfile.lock` are deliberately absent from this
  // list: dropping them means deleting the `bundler-audit` job from
  // `.github/workflows/dependency-audit.yml`, and the worker token carries no
  // `workflow` OAuth scope, so that edit cannot be pushed from a run.
  "_config.yml",
  "_data/page_titles.yml",
  "_includes/head-custom.html",
  "_layouts/default.html",
  "assets/favicon.svg",
  "404.html",
  // Pages-only worker checks.
  "worker/deno/commands/check_pages_liquid.ts",
  "worker/deno/commands/check_mermaid_built_output.ts",
  "worker/deno/lib/pages_liquid_check.ts",
  "worker/deno/lib/pages_csp.ts",
  "worker/deno/lib/mermaid_cdn_integrity.ts",
  "worker/deno/lib/mermaid_security_level.ts",
  "worker/deno/lib/mermaid_built_output_check.ts",
];

/** Resolve a repo-relative path against this checkout. */
function repoPath(relative: string): string {
  return `${REPO_ROOT}${relative}`;
}

/** True when the path exists in this checkout. */
async function exists(relative: string): Promise<boolean> {
  try {
    await Deno.stat(repoPath(relative));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("Pages publishing pipeline files are removed", async () => {
  const survivors: string[] = [];
  for (const path of REMOVED_PATHS) {
    if (await exists(path)) survivors.push(path);
  }
  assertEquals(
    survivors,
    [],
    `The GitHub Pages pipeline was removed in Issue #1344, but these paths ` +
      `are back:\n  ${survivors.join("\n  ")}`,
  );
});

/**
 * The release notes are the one place the dead URL is allowed to appear: the
 * 1.5.0 entry has to name what was retired, or an operator holding a bookmark
 * has nothing to match it against. Every other doc must point somewhere live.
 */
const SITE_URL_EXEMPT = new Set(["docs/RELEASE-NOTES.md"]);

Deno.test("no published doc links at the retired Pages site", async () => {
  const offenders: string[] = [];
  const scan = async (relativeDir: string) => {
    const prefix = relativeDir === "" ? "" : `${relativeDir}/`;
    for await (const entry of Deno.readDir(repoPath(relativeDir))) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      const path = `${prefix}${entry.name}`;
      if (SITE_URL_EXEMPT.has(path)) continue;
      const body = await Deno.readTextFile(repoPath(path));
      if (body.includes("stsoftwareau.github.io")) offenders.push(path);
    }
  };
  await scan("");
  await scan("docs");
  assertEquals(
    offenders,
    [],
    `The published site is gone; these docs still link at it:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("the worker registers no Pages-only commands", async () => {
  const mod = await Deno.readTextFile(repoPath("worker/deno/mod.ts"));
  assert(
    !mod.includes("check-pages-liquid"),
    "mod.ts still registers the removed check-pages-liquid command",
  );
  assert(
    !mod.includes("check-mermaid-built-output"),
    "mod.ts still registers the removed check-mermaid-built-output command",
  );
});
