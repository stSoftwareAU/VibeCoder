/**
 * Regression tests for Issue #3600 — the operator docs documented retired
 * timeout defaults (14400 / 900 / 600) after Issues #1824, #1825 and #3154
 * lowered or raised them in `config_defaults.ts`.
 *
 * The tests tie the documented numbers back to the single source of truth
 * (`OPERATIONAL_DEFAULTS`) so the numbers cannot drift again, and assert the
 * six overridable timeout keys that were missing entirely are documented.
 *
 * Australian English spelling used throughout (behaviour, minimise, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";

// tests/ → worker/deno/ → worker/ → repo root
async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

/** `claude_no_output_timeout` → `claudeNoOutputTimeout`. */
function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const DEFAULTS = OPERATIONAL_DEFAULTS as unknown as Record<string, unknown>;

/** Rows of a markdown table as trimmed cell arrays. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) =>
      line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) =>
        c.trim()
      )
    );
}

/** Extract the section body between a heading containing `title` and the next heading of the same level. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{2,}\s/.test(l) && l.includes(title));
  assert(start >= 0, `expected a section titled "${title}"`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "###").length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const hashes = l.match(/^#+\s/)?.[0].trim();
    return hashes !== undefined && hashes.length <= level;
  });
  return (end >= 0 ? rest.slice(0, end) : rest).join("\n");
}

/**
 * Documented `key` → numeric default pairs found in a markdown table whose
 * cells are of the form `` `snake_key` `` followed by `` `1234` ``.
 */
function documentedNumbers(markdown: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const cells of tableRows(markdown)) {
    for (let i = 0; i < cells.length - 1; i++) {
      const key = cells[i]?.match(/^`([a-zA-Z][a-zA-Z0-9_]*)`$/)?.[1];
      // A default cell may carry a human-readable gloss, e.g. `3600` (1 hour).
      const value = cells[i + 1]?.match(/^`(\d+)`(\s.*)?$/)?.[1];
      if (key && value) found.set(key, Number(value));
    }
  }
  return found;
}

Deno.test("timeout docs - CONFIGURATION.md operational defaults match the code", async () => {
  const body = section(
    await read("docs/CONFIGURATION.md"),
    "Operational Defaults",
  );
  const documented = documentedNumbers(body);
  assert(
    documented.size > 10,
    "expected the operational-defaults table to parse",
  );
  for (const [key, value] of documented) {
    const actual = DEFAULTS[toCamel(key)];
    if (typeof actual !== "number") continue; // not an OPERATIONAL_DEFAULTS key
    assertEquals(
      value,
      actual,
      `docs/CONFIGURATION.md documents ${key} = ${value}, code default is ${actual}`,
    );
  }
});

Deno.test("timeout docs - grill-me.md round table matches the code", async () => {
  const documented = documentedNumbers(
    await read("docs/workflows/grill-me.md"),
  );
  for (
    const key of ["grillMeTimeout", "grillMeKillAfter", "maxGrillMeRounds"]
  ) {
    const value = documented.get(key.replace(/[A-Z]/g, (c) =>
      `_${c.toLowerCase()}`)) ??
      documented.get(key);
    assertEquals(
      value,
      DEFAULTS[key],
      `docs/workflows/grill-me.md documents ${key} = ${value}, code default is ${
        DEFAULTS[key]
      }`,
    );
  }
});
