/**
 * Regression tests for Issue #3596 — `DESIGN-PRINCIPLES.md` contradicted itself
 * on the idle-task registry size: the *Best-practices scans* section claimed
 * "fifteen registered templates (1/15 each)" and omitted
 * `private-repo-reference-audit`, while the *Idle-task framework* registry
 * section correctly said sixteen (1/16 each).
 *
 * These tests tie every registry-size claim in the design digest back to the
 * single source of truth (`IDLE_TASK_WRAPPER_TEMPLATE_NAMES`), so a new
 * template can never leave a stale count behind, and assert that the
 * Best-practices section defers to the registry section instead of keeping its
 * own copy of the list.
 *
 * Australian English spelling used throughout (behaviour, enumeration, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { IDLE_TASK_WRAPPER_TEMPLATE_NAMES } from "../lib/idle_task_backfill.ts";

// tests/ → worker/deno/ → worker/ → repo root
const DESIGN_PRINCIPLES = new URL(
  "../../../DESIGN-PRINCIPLES.md",
  import.meta.url,
);

const REGISTRY_SIZE = IDLE_TASK_WRAPPER_TEMPLATE_NAMES.size;

/** Cardinal number words the digest uses when counting templates. */
const NUMBER_WORDS: Record<string, number> = {
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
};

async function readDesignPrinciples(): Promise<string> {
  return await Deno.readTextFile(DESIGN_PRINCIPLES);
}

/** Body of the `### Best-practices scans …` section, up to the next heading. */
function bestPracticesSection(markdown: string): string {
  const start = markdown.indexOf("### Best-practices scans");
  assert(start >= 0, "Best-practices scans section not found");
  const rest = markdown.slice(start);
  const next = rest.indexOf("\n### ", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
}

Deno.test("DESIGN-PRINCIPLES - every 1/N uniform-draw claim matches the registry size", async () => {
  const markdown = await readDesignPrinciples();
  const draws = [...markdown.matchAll(/1\/(\d+) each/g)].map((m) =>
    Number(m[1])
  );

  assert(draws.length > 0, "no uniform-draw claim found — regex out of date");
  for (const draw of draws) {
    assertEquals(
      draw,
      REGISTRY_SIZE,
      `DESIGN-PRINCIPLES.md claims a 1/${draw} uniform draw but ` +
        `${REGISTRY_SIZE} templates are registered`,
    );
  }
});

Deno.test("DESIGN-PRINCIPLES - spelled-out template counts match the registry size", async () => {
  const markdown = await readDesignPrinciples();
  const patterns = [
    /between the ([a-z]+)\b/g,
    /\b([a-z]+) registered templates\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const value = NUMBER_WORDS[match[1] ?? ""];
      if (value === undefined) continue; // not a cardinal count
      assertEquals(
        value,
        REGISTRY_SIZE,
        `DESIGN-PRINCIPLES.md spells the registry size as "${match[1]}" ` +
          `but ${REGISTRY_SIZE} templates are registered`,
      );
    }
  }
});

Deno.test("DESIGN-PRINCIPLES - Best-practices section defers to the registry section", async () => {
  const section = bestPracticesSection(await readDesignPrinciples());

  assert(
    section.includes("#idle-task-framework"),
    "Best-practices section must link to the authoritative registry section",
  );
  assertEquals(
    [...section.matchAll(/1\/\d+ each/g)].length,
    0,
    "Best-practices section must not hard-code its own uniform-draw size",
  );
  for (const word of Object.keys(NUMBER_WORDS)) {
    assert(
      !section.includes(`between the ${word}`),
      `Best-practices section must not hard-code the count "${word}"`,
    );
  }
});
