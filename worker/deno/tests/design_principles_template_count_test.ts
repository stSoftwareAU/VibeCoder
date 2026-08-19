/**
 * Regression tests for Issue #3596 — `DESIGN-PRINCIPLES.md` contradicted itself
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
import { anchorSet, githubSlug } from "../lib/markdown_anchors.ts";

/** Number words the digest uses for registry-sized counts. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);

/** Registry size — the single source of truth every doc claim must match. */
const REGISTERED_COUNT = IDLE_TASK_WRAPPER_TEMPLATE_NAMES.size;

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

/** The `### Best-practices scans …` section body, heading excluded. */
function bestPracticesSection(doc: string): string {
  const start = doc.indexOf("### Best-practices scans");
  assert(start >= 0, "Best-practices scans heading is missing");
  const rest = doc.slice(start);
  const end = rest.indexOf("\n### ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

Deno.test("design digest - every uniform-draw denominator matches the registry", async () => {
  const doc = await read("DESIGN-PRINCIPLES.md");
  const denominators = [...doc.matchAll(/\(1\/(\d+) each\)/g)].map((m) =>
    Number(m[1])
  );

  assert(
    denominators.length > 0,
    "expected at least one `(1/N each)` uniform-draw claim in DESIGN-PRINCIPLES.md",
  );
  for (const denominator of denominators) {
    assertEquals(
      denominator,
      REGISTERED_COUNT,
      `DESIGN-PRINCIPLES.md claims a 1/${denominator} draw but ${REGISTERED_COUNT} templates are registered`,
    );
  }
});

Deno.test("design digest - every 'the <count> templates' claim matches the registry", async () => {
  const doc = await read("DESIGN-PRINCIPLES.md");
  const pattern =
    /\b(?:the|all|between the)\s+([a-z]+)\s+(?:registered\s+)?(?:idle-task\s+)?(?:templates|wrappers)\b/g;

  const claimed: number[] = [];
  for (const match of doc.matchAll(pattern)) {
    const value = NUMBER_WORDS.get(match[1] ?? "");
    if (value !== undefined) claimed.push(value);
  }

  for (const value of claimed) {
    assertEquals(
      value,
      REGISTERED_COUNT,
      `DESIGN-PRINCIPLES.md claims ${value} registered templates but ${REGISTERED_COUNT} are registered`,
    );
  }
});

Deno.test("design digest - Best-practices scans defers to the registry section", async () => {
  const doc = await read("DESIGN-PRINCIPLES.md");
  const section = bestPracticesSection(doc);

  // No second hard-coded count: the registry section owns the enumeration, so
  // adding a seventeenth template touches exactly one passage.
  assertEquals(
    [...section.matchAll(/\(1\/(\d+) each\)/g)].length,
    0,
    "Best-practices scans should not restate the uniform-draw denominator",
  );

  const link = section.match(/\]\(#([a-z0-9-]+)\)/);
  assert(
    link !== null,
    "Best-practices scans should link to the authoritative registry section",
  );
  assert(
    anchorSet(doc).has(link[1] ?? ""),
    `Best-practices scans links to #${
      link[1]
    }, which is not a heading in DESIGN-PRINCIPLES.md`,
  );
  assertEquals(link[1], githubSlug("Idle-task framework (Issue #1959)"));
});

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
