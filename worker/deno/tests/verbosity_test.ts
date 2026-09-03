/**
 * Tests for verbosity instruction templates and resolution logic.
 *
 * Issue #1331: Create verbosity instruction templates for prompt injection.
 * Part of #1329 (caveman mode — configurable verbosity).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  getVerbosityInstructions,
  resolveVerbosity,
} from "../lib/verbosity.ts";
import type { RepoConfig, VerbosityLevel } from "../types.ts";

// =============================================================================
// getVerbosityInstructions — instruction text for each level
// =============================================================================

Deno.test("verbosity instructions - minimal returns non-empty instruction text", () => {
  const result = getVerbosityInstructions("minimal");
  assertNotEquals(result, "");
  assertNotEquals(result.length, 0);
});

Deno.test("verbosity instructions - minimal instructs single sentence response", () => {
  const result = getVerbosityInstructions("minimal");
  assertEquals(result.toLowerCase().includes("single sentence"), true);
});

// Issue #3813 (Gap 4): minimal used to state its shape as a prohibition
// ("do not explain your reasoning"). It now states the shape to produce —
// one sentence, and that sentence is the whole response.
Deno.test("verbosity instructions - minimal bounds the response to that one sentence", () => {
  const result = getVerbosityInstructions("minimal");
  assertEquals(result.toLowerCase().includes("whole response"), true);
});

Deno.test("verbosity instructions - concise returns non-empty instruction text", () => {
  const result = getVerbosityInstructions("concise");
  assertNotEquals(result, "");
  assertNotEquals(result.length, 0);
});

Deno.test("verbosity instructions - concise instructs brief response", () => {
  const result = getVerbosityInstructions("concise");
  assertEquals(result.toLowerCase().includes("brief"), true);
});

// Issue #3813 (Gap 3): standard used to return an empty string, leaving the
// highest-volume surface — whose output is published as a PR body and an issue
// comment a human reads — silent about its expected visible output.
Deno.test("verbosity instructions - standard returns an end-of-run summary instruction", () => {
  const result = getVerbosityInstructions("standard");
  assertNotEquals(result, "");
  assertEquals(
    result.toLowerCase().includes("summarise what you changed"),
    true,
  );
  assertEquals(result.toLowerCase().includes("running commentary"), true);
});

Deno.test("verbosity instructions - verbose returns non-empty instruction text", () => {
  const result = getVerbosityInstructions("verbose");
  assertNotEquals(result, "");
  assertNotEquals(result.length, 0);
});

Deno.test("verbosity instructions - verbose instructs detailed explanations", () => {
  const result = getVerbosityInstructions("verbose");
  assertEquals(result.toLowerCase().includes("detailed"), true);
});

Deno.test("verbosity instructions - verbose mentions trade-offs", () => {
  const result = getVerbosityInstructions("verbose");
  assertEquals(result.toLowerCase().includes("trade-off"), true);
});

Deno.test("verbosity instructions - verbose mentions alternatives", () => {
  const result = getVerbosityInstructions("verbose");
  assertEquals(result.toLowerCase().includes("alternative"), true);
});

// =============================================================================
// resolveVerbosity — priority chain tests
// =============================================================================

// Issue #798: the phase-default tier is gone. It never reached a rendered
// prompt — `resolveVerbosity()` had one non-test call site (the `issue` phase)
// and no other prompt builder was ever passed a level — so the chain is now
// two tiers: per-repo override, then the global default. The per-phase tests
// that pinned the deleted tier are replaced by these.

Deno.test("resolveVerbosity - returns the global default when no repo config is given", () => {
  const result = resolveVerbosity();
  assertEquals(result, "standard");
});

Deno.test("resolveVerbosity - returns the global default for an undefined repo config", () => {
  const result = resolveVerbosity(undefined);
  assertEquals(result, "standard");
});

Deno.test("resolveVerbosity - repo config overrides the global default", () => {
  const repoConfig: RepoConfig = { verbosity: "minimal" };
  const result = resolveVerbosity(repoConfig);
  assertEquals(result, "minimal");
});

Deno.test("resolveVerbosity - every level survives the repo override", () => {
  const levels: VerbosityLevel[] = [
    "minimal",
    "concise",
    "standard",
    "verbose",
  ];
  for (const level of levels) {
    assertEquals(resolveVerbosity({ verbosity: level }), level);
  }
});

Deno.test("resolveVerbosity - repo config without verbosity falls back to the global default", () => {
  const repoConfig: RepoConfig = { skipQualityCheck: true };
  const result = resolveVerbosity(repoConfig);
  assertEquals(result, "standard");
});

// Issue #798: the deleted map is no longer an export anyone can resolve
// against — check the module namespace rather than the source text.
Deno.test("config_defaults - no longer exports a phase verbosity map", async () => {
  const defaults = await import("../lib/config_defaults.ts");
  assertEquals(
    Object.hasOwn(defaults, "PHASE_VERBOSITY_DEFAULTS"),
    false,
    "PHASE_VERBOSITY_DEFAULTS was dead configuration and must stay deleted",
  );
});

// =============================================================================
// Integration — resolveVerbosity + getVerbosityInstructions
// =============================================================================

Deno.test("verbosity - end-to-end: repo override to verbose produces verbose instructions", () => {
  const repoConfig: RepoConfig = { verbosity: "verbose" };
  const level = resolveVerbosity(repoConfig);
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("detailed"), true);
});

// Issue #3813 (Gap 3): an unconfigured repo resolves to standard, which used
// to return an empty instruction. It now carries the end-of-run summary.
Deno.test("verbosity - end-to-end: an unconfigured repo gets the standard instructions", () => {
  const level = resolveVerbosity();
  assertEquals(level, "standard");
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("running commentary"), true);
});

Deno.test("verbosity - end-to-end: repo override to minimal produces minimal instructions", () => {
  const repoConfig: RepoConfig = { verbosity: "minimal" };
  const level = resolveVerbosity(repoConfig);
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("single sentence"), true);
});
