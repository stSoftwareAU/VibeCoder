/**
 * Tests for reading a PR's sub-agent tier from its body (Issue #3404).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildSubAgentTierMarker } from "../lib/pr_body.ts";
import { fetchPrSubAgentTier } from "../lib/pr_sub_agent_tier.ts";

function recorder(): { warnings: string[]; warn: (m: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (m) => warnings.push(m) };
}

Deno.test("fetchPrSubAgentTier - a haiku marker resolves to haiku and asks gh for the body", async () => {
  const calls: string[][] = [];
  const log = recorder();
  const tier = await fetchPrSubAgentTier("o/r", 42, (args) => {
    calls.push(args);
    return Promise.resolve(
      JSON.stringify({
        body: `Summary\n\n${buildSubAgentTierMarker("haiku")}`,
      }),
    );
  }, log);
  assertEquals(tier, "haiku");
  assertEquals(calls, [[
    "pr",
    "view",
    "42",
    "--repo",
    "o/r",
    "--json",
    "body",
  ]]);
  assertEquals(log.warnings, []);
});

Deno.test("fetchPrSubAgentTier - a body without a marker defaults to sonnet", async () => {
  const log = recorder();
  const tier = await fetchPrSubAgentTier(
    "o/r",
    1,
    () => Promise.resolve(JSON.stringify({ body: "no marker here" })),
    log,
  );
  assertEquals(tier, "sonnet");
  assertEquals(log.warnings, []);
});

Deno.test("fetchPrSubAgentTier - a gh failure returns null and warns", async () => {
  const log = recorder();
  const tier = await fetchPrSubAgentTier(
    "o/r",
    7,
    () => Promise.reject(new Error("boom")),
    log,
  );
  assertEquals(tier, null);
  assertEquals(log.warnings.length, 1);
  assertStringIncludes(log.warnings[0] ?? "", "o/r#7");
  assertStringIncludes(log.warnings[0] ?? "", "boom");
});

Deno.test("fetchPrSubAgentTier - invalid JSON returns null and warns", async () => {
  const log = recorder();
  const tier = await fetchPrSubAgentTier(
    "o/r",
    8,
    () => Promise.resolve("not json"),
    log,
  );
  assertEquals(tier, null);
  assertEquals(log.warnings.length, 1);
  assertStringIncludes(log.warnings[0] ?? "", "o/r#8");
});

Deno.test("fetchPrSubAgentTier - a missing or non-string body returns null and warns", async () => {
  for (const out of ["{}", '{"body":5}', "null", "[]"]) {
    const log = recorder();
    const tier = await fetchPrSubAgentTier(
      "o/r",
      9,
      () => Promise.resolve(out),
      log,
    );
    assertEquals(tier, null, out);
    assertEquals(log.warnings.length, 1, out);
  }
});
