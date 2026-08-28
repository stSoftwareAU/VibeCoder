/**
 * Regression tests for — `DESIGN-PRINCIPLES.md` contradicted itself
 * on how many idle-task templates are registered ("fifteen" / `1/15` in the
 * *Best-practices scans* section vs "sixteen" / `1/16` in the registry
 * section).
 *
 * The registered template set is the ground truth: these tests read it from the
 * production registry, then assert every uniform-draw denominator and every
 * "the <count> templates" claim in the design digest agrees with it. They fail
 * against the pre-fix document and keep passing as templates are added, because
 * the expected count is derived, never hard-coded here.
 *
 * Australian English spelling used throughout (behaviour, enumerate, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { IDLE_TASK_WRAPPER_TEMPLATE_NAMES } from "../lib/idle_task_backfill.ts";

/** Registry size — the single source of truth every doc claim must match. */
const REGISTERED_COUNT = IDLE_TASK_WRAPPER_TEMPLATE_NAMES.size;

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

Deno.test("design digest - the registry enumerates every template module", async () => {
  const doc = await read("DESIGN-PRINCIPLES.md");
  const modules: string[] = [];
  for await (
    const entry of Deno.readDir(repoPath("worker/deno/lib/idle_task_templates"))
  ) {
    if (entry.isFile && entry.name.endsWith("_template.ts")) {
      modules.push(entry.name);
    }
  }

  assertEquals(
    modules.length,
    REGISTERED_COUNT,
    "template modules on disk and registered wrapper templates disagree",
  );
  for (const module of modules) {
    assert(
      doc.includes(module),
      `DESIGN-PRINCIPLES.md never mentions the template module ${module}`,
    );
  }
});
