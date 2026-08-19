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
import type { RepoConfig } from "../types.ts";

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

Deno.test("resolveVerbosity - returns global default when no phase default and no repo config", () => {
  const result = resolveVerbosity("unknown_phase");
  assertEquals(result, "standard");
});

Deno.test("resolveVerbosity - returns phase default for known phase", () => {
  const result = resolveVerbosity("planning");
  assertEquals(result, "verbose");
});

Deno.test("resolveVerbosity - returns phase default for minimal phase", () => {
  const result = resolveVerbosity("spelling_fix");
  assertEquals(result, "minimal");
});

Deno.test("resolveVerbosity - returns phase default for concise phase", () => {
  const result = resolveVerbosity("ci_fix");
  assertEquals(result, "concise");
});

Deno.test("resolveVerbosity - returns phase default for standard phase", () => {
  const result = resolveVerbosity("issue");
  assertEquals(result, "standard");
});

Deno.test("resolveVerbosity - repo config overrides phase default", () => {
  const repoConfig: RepoConfig = { verbosity: "minimal" };
  const result = resolveVerbosity("planning", repoConfig);
  assertEquals(result, "minimal");
});

Deno.test("resolveVerbosity - repo config overrides global default for unknown phase", () => {
  const repoConfig: RepoConfig = { verbosity: "verbose" };
  const result = resolveVerbosity("unknown_phase", repoConfig);
  assertEquals(result, "verbose");
});

Deno.test("resolveVerbosity - repo config without verbosity falls back to phase default", () => {
  const repoConfig: RepoConfig = { skipQualityCheck: true };
  const result = resolveVerbosity("planning", repoConfig);
  assertEquals(result, "verbose");
});

Deno.test("resolveVerbosity - repo config undefined falls back to phase default", () => {
  const result = resolveVerbosity("summarise", undefined);
  assertEquals(result, "minimal");
});

// =============================================================================
// Integration — resolveVerbosity + getVerbosityInstructions
// =============================================================================

Deno.test("verbosity - end-to-end: resolve then get instructions for planning phase", () => {
  const level = resolveVerbosity("planning");
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("detailed"), true);
});

// Issue #3813 (Gap 3): the issue phase defaults to standard, which used to
// resolve to an empty instruction. It now carries the end-of-run summary.
Deno.test("verbosity - end-to-end: resolve then get instructions for issue phase", () => {
  const level = resolveVerbosity("issue");
  assertEquals(level, "standard");
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("running commentary"), true);
});

Deno.test("verbosity - end-to-end: repo override to minimal produces minimal instructions", () => {
  const repoConfig: RepoConfig = { verbosity: "minimal" };
  const level = resolveVerbosity("planning", repoConfig);
  const instructions = getVerbosityInstructions(level);
  assertNotEquals(instructions, "");
  assertEquals(instructions.toLowerCase().includes("single sentence"), true);
});
