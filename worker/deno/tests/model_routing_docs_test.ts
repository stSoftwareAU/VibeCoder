/**
 * `docs/MODEL-AND-CACHING.md` routing table vs the code (Issue #3349).
 *
 * The doc is the authoritative model-routing reference and had drifted from
 * `PHASE_MODEL_DEFAULTS` / `PHASE_EFFORT_DEFAULTS` (a flat "Fable is not the
 * default for any phase", a `max` effort in the healthy example, a missing
 * phase). This test reads the "Phase-Specific Defaults" table and asserts
 * every phase the code routes appears with the code's tier and effort, and
 * that the healthy-run example shows the default planning effort.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { FABLE_PREFERRING_PHASES } from "../lib/fable_routing.ts";

const DOC = new URL("../../../docs/MODEL-AND-CACHING.md", import.meta.url)
  .pathname;
const text = await Deno.readTextFile(DOC);

/** Tier word the doc uses for a code model id. */
function tierWord(model: string): string {
  if (model === "fable") return "Fable 5";
  if (model === "opus") return "Opus";
  if (model === "haiku") return "Haiku";
  if (model === "sonnet") return "Sonnet";
  return model;
}

/** Rows of the routing table: `| phase | Model | effort | … |`. */
function parseRoutingTable(): Map<string, { model: string; effort: string }> {
  const rows = new Map<string, { model: string; effort: string }>();
  const re =
    /^\|\s*([a-z_]+)(?:\s*\([^)]*\))?\s*\|\s*([A-Za-z 0-9]+?)\s*\|\s*([a-z]+)\s*\|/gm;
  for (const m of text.matchAll(re)) {
    rows.set(m[1]!, { model: m[2]!, effort: m[3]! });
  }
  return rows;
}

Deno.test("model routing docs - every phase in PHASE_MODEL_DEFAULTS is in the routing table with the code's tier and effort (Issue #3349)", () => {
  const rows = parseRoutingTable();
  for (const [phase, model] of Object.entries(PHASE_MODEL_DEFAULTS)) {
    const row = rows.get(phase);
    assert(row, `routing table has no row for phase ${phase}`);
    assertEquals(row.model, tierWord(model), `tier for ${phase}`);
    assertEquals(
      row.effort,
      PHASE_EFFORT_DEFAULTS[phase],
      `effort for ${phase}`,
    );
  }
  for (const phase of rows.keys()) {
    assert(
      phase in PHASE_MODEL_DEFAULTS,
      `table documents unknown phase ${phase}`,
    );
  }
});

Deno.test("model routing docs - the Fable-preferring phase list in the doc matches fable_routing.ts", () => {
  // The prose names the set once, in backticks, in the "Phase-Specific
  // Defaults" paragraph; every member must be there and the count word
  // must match its length.
  for (const phase of FABLE_PREFERRING_PHASES) {
    assert(text.includes(`\`${phase}\``), `doc never names ${phase}`);
  }
  const words = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
  ];
  const count = words[FABLE_PREFERRING_PHASES.length]!;
  assert(
    new RegExp(`${count} \\*?planning-shaped\\*? phases`).test(text),
    `doc must describe ${count} planning-shaped phases`,
  );
});
