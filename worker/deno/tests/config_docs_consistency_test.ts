/**
 * Regression tests for Issue #3464 — README and docs/CONFIGURATION.md document
 * configuration keys that are either hardwired (no longer overridable) or do
 * not exist, silently misleading operators.
 *
 * These tests tie the docs back to the single source of truth
 * (`KNOWN_CONFIG_KEYS`) so that:
 *   - dead / hardwired keys never reappear inside a copyable `.config.json`
 *     example, and
 *   - a real, accepted config key documented in the reference is actually a
 *     recognised key (otherwise operators get a spurious unknown-key warning).
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import {
  EFFORT_LEVELS,
  OPERATIONAL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { lookupModelPricing } from "../lib/token_usage.ts";
import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

/** Legacy singular aliases still accepted for backward compatibility. */
const LEGACY_ALIASES = new Set(["allowed_author", "pr_reviewer"]);

/**
 * Keys that are hardwired (removed by Issue #1834) or that never existed.
 * An operator copying any of these into `.config.json` is silently ignored.
 */
const DEAD_OR_HARDWIRED_KEYS = [
  "issue_labels", // Issue #1834 — hardwired discovery label
  "work_on_label", // Issue #1834 — hardwired
  "low_priority_label", // Issue #1834 — hardwired
  "claude_model_planning", // never existed; use phase_model_overrides
  "needs_screenshot_label", // hardwired label default, not configurable
  "documentation_label", // hardwired label default, not configurable
];

/** Extract every fenced ```json code block body from a markdown document. */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

Deno.test("config docs - phase_effort_overrides is a recognised config key", () => {
  // config.ts reads `phase_effort_overrides` and CONFIGURATION.md documents it,
  // so it must be in KNOWN_CONFIG_KEYS — otherwise setting it as documented
  // triggers a false "unknown key" warning.
  assertEquals(
    KNOWN_CONFIG_KEYS.has("phase_effort_overrides"),
    true,
    "phase_effort_overrides is read by config.ts and documented; it must be a known key",
  );
});

Deno.test("config docs - hardwired / phantom keys are not accepted config keys", () => {
  for (const key of DEAD_OR_HARDWIRED_KEYS) {
    assertEquals(
      KNOWN_CONFIG_KEYS.has(key),
      false,
      `${key} is hardwired or does not exist and must not be a known config key`,
    );
  }
});

Deno.test("config docs - no JSON example advertises a dead / hardwired key", async () => {
  for (const doc of ["docs/CONFIGURATION.md", "README.md"]) {
    const markdown = await read(doc);
    for (const block of jsonBlocks(markdown)) {
      for (const key of DEAD_OR_HARDWIRED_KEYS) {
        assert(
          !block.includes(`"${key}"`),
          `${doc} contains a JSON example advertising the dead/hardwired key "${key}"`,
        );
      }
    }
  }
});

/**
 * Image-shaping keys whose absence from the reference is not a cosmetic gap:
 * an operator who cannot find the key writes the wrong one, and the first
 * symptom is a config-load failure or an image that silently lacks what the
 * deployment needs (Issue #984).
 */
const KEYS_NEEDING_A_ROW = ["container_tools", "container_extension"];

Deno.test("config docs - every image-shaping key has a reference row (Issue #984)", async () => {
  const lines = (await read("docs/CONFIGURATION.md")).split("\n");
  for (const key of KEYS_NEEDING_A_ROW) {
    assert(
      KNOWN_CONFIG_KEYS.has(key),
      `${key} must be a recognised config key`,
    );
    assert(
      lines.some((line) => line.startsWith(`| \`${key}\``)),
      `docs/CONFIGURATION.md must carry a table row documenting "${key}"`,
    );
  }
});

Deno.test("config docs - primary sample .config.json uses only recognised keys", async () => {
  const markdown = await read("docs/CONFIGURATION.md");
  const first = jsonBlocks(markdown)[0];
  assert(
    first,
    "expected a sample .config.json JSON block in CONFIGURATION.md",
  );
  const parsed = JSON.parse(first) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    assert(
      KNOWN_CONFIG_KEYS.has(key) || LEGACY_ALIASES.has(key),
      `Sample .config.json documents unrecognised key "${key}"`,
    );
  }
});

/**
 * The documented default must track the shipped one (Issue #2339).
 *
 * `enable_session_resume` was flipped to `true`, and three separate tables
 * across two documents state its default. A drift check against
 * `OPERATIONAL_DEFAULTS` is what stops the docs half of that flip from
 * rotting: every row documenting the key must name the value the code ships.
 */
Deno.test("config docs - documented enable_session_resume default matches the code (Issue #2339)", async () => {
  const expected = `\`${OPERATIONAL_DEFAULTS.enableSessionResume}\``;
  for (const doc of ["docs/CONFIGURATION.md", "docs/MODEL-AND-CACHING.md"]) {
    const rows = (await read(doc))
      .split("\n")
      .filter((line) =>
        line.startsWith("|") && line.includes("`enable_session_resume`")
      );
    assert(
      rows.length > 0,
      `${doc} must carry a table row documenting enable_session_resume`,
    );
    for (const row of rows) {
      assert(
        row.includes(expected),
        `${doc} documents enable_session_resume without the shipped default ${expected}: ${row}`,
      );
    }
  }
});

/**
 * The Haiku sub-agent tier trial must be documented accurately (Issue #3407).
 *
 * docs/MODEL-AND-CACHING.md carries the trial's decision rule, the Haiku 5.5
 * price rows and a copyable `quality_fix` override. These tests pin the rule's
 * thresholds, tie the price rows to `MODEL_PRICING`, and check that every
 * documented JSON snippet uses keys the worker accepts.
 */
const MODEL_DOC = "docs/MODEL-AND-CACHING.md";
const TRIAL_TITLE = "Haiku sub-agent tier trial";

Deno.test("config docs - the Haiku sub-agent tier trial section names the key and the model (Issue #3407)", async () => {
  const doc = await readRepoDoc(MODEL_DOC);
  assertPins(section(doc, TRIAL_TITLE), [
    "`issue_sub_agent_tier`",
    "`claude-haiku-5-5`",
  ]);
});

Deno.test("config docs - the trial decision rule states every threshold (Issue #3407)", async () => {
  const doc = await readRepoDoc(MODEL_DOC);
  assertPins(section(doc, TRIAL_TITLE), [
    "at least 7 days",
    "at least 30 `issue` runs",
    "at least 25% cheaper",
    "no more than 5 percentage points",
    "not yet adopted",
  ]);
});

Deno.test("config docs - Haiku 5.5 price rows match token_usage (Issue #3407)", async () => {
  const doc = await readRepoDoc(MODEL_DOC);
  const pricingSection = String(section(doc, "Model Pricing"));
  const lines = pricingSection.split("\n");
  const lowerRow = lines.find((l) =>
    l.startsWith("| Claude Haiku 5.5 (≤100k prompt tokens) |")
  );
  const upperRow = lines.find((l) =>
    l.startsWith("| Claude Haiku 5.5 (>100k prompt tokens) |")
  );
  assert(lowerRow, "missing the Haiku 5.5 ≤100k pricing row");
  assert(upperRow, "missing the Haiku 5.5 >100k pricing row");
  const figures = (row: string): number[] =>
    [...row.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
  const lower = figures(lowerRow);
  const upper = figures(upperRow);
  assertEquals(lower.length, 4);
  assertEquals(upper.length, 4);

  const pricing = lookupModelPricing("claude-haiku-5-5");
  assert(pricing, "claude-haiku-5-5 must have pricing");
  assert(pricing.lowerBand, "claude-haiku-5-5 must carry a lowerBand");
  assertEquals(pricing.lowerBand.maxPromptTokens, 100_000);
  assertEquals(lower, [
    pricing.lowerBand.inputPerMillion,
    pricing.lowerBand.outputPerMillion,
    pricing.lowerBand.cacheWritePerMillion,
    pricing.lowerBand.cacheReadPerMillion,
  ]);
  assertEquals(upper, [
    pricing.inputPerMillion,
    pricing.outputPerMillion,
    pricing.cacheWritePerMillion,
    pricing.cacheReadPerMillion,
  ]);
  assert(
    lines.some((l) => l.startsWith("| Claude Haiku 4.5 |")),
    "the flat Haiku 4.5 pricing row must remain",
  );
});

Deno.test("config docs - the quality_fix Haiku override snippet uses keys the worker accepts (Issue #3407)", async () => {
  const doc = await readRepoDoc(MODEL_DOC);
  const trial = String(section(doc, TRIAL_TITLE));
  const blocks = jsonBlocks(trial);
  const block = blocks.find((b) => b.includes("quality_fix"));
  assert(block, "expected a quality_fix JSON snippet in the trial section");
  const parsed = JSON.parse(block) as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(parsed)) {
    assert(KNOWN_CONFIG_KEYS.has(key), `unrecognised key "${key}"`);
  }
  assertEquals(parsed.phase_model_overrides?.quality_fix, "haiku");
  assertEquals(parsed.phase_effort_overrides?.quality_fix, "high");
  assert("quality_fix" in PHASE_MODEL_DEFAULTS);
  assert("quality_fix" in PHASE_EFFORT_DEFAULTS);
  assert((Object.values(EFFORT_LEVELS) as string[]).includes("high"));
  for (const b of blocks) {
    const obj = JSON.parse(b) as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      assert(KNOWN_CONFIG_KEYS.has(key), `unrecognised key "${key}"`);
    }
  }
});
