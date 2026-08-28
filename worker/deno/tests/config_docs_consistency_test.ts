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
