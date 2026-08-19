/**
 * Tests for ai_action_identifiers.ts — shared AI coding-agent action
 * recognition (Issue #3313, parent #3309).
 *
 * Every test exercises the real `isAiAction` / `normaliseUses` — no
 * filesystem, no network.
 */

import { assert, assertEquals } from "@std/assert";
import {
  AI_ACTION_SLUGS,
  isAiAction,
  normaliseUses,
} from "../lib/ai_action_identifiers.ts";

Deno.test("normaliseUses - strips version ref and lower-cases", () => {
  assertEquals(
    normaliseUses("anthropics/claude-code-action@beta"),
    "anthropics/claude-code-action",
  );
  assertEquals(
    normaliseUses('"Anthropics/Claude-Code-Action@abc123"'),
    "anthropics/claude-code-action",
  );
  assertEquals(
    normaliseUses("  google-gemini/run-gemini-cli@v1  "),
    "google-gemini/run-gemini-cli",
  );
});

Deno.test("isAiAction - matches every known slug (exact and versioned)", () => {
  for (const slug of AI_ACTION_SLUGS) {
    assert(isAiAction(slug), `exact slug not matched: ${slug}`);
    assert(isAiAction(`${slug}@beta`), `versioned slug not matched: ${slug}`);
  }
});

Deno.test("isAiAction - matches a sub-path of a known slug", () => {
  assert(isAiAction("anthropics/claude-code-base-action/setup@v1"));
});

Deno.test("isAiAction - is case-insensitive", () => {
  assert(isAiAction("Anthropics/Claude-Code-Action@beta"));
});

Deno.test("isAiAction - rejects non-agent actions", () => {
  assertEquals(isAiAction("actions/checkout@v4"), false);
  assertEquals(isAiAction("actions/setup-node@v4"), false);
  assertEquals(isAiAction("actions/github-script@v7"), false);
});

Deno.test("isAiAction - rejects local and docker references", () => {
  assertEquals(isAiAction("./.github/actions/setup"), false);
  assertEquals(isAiAction("docker://alpine:3.19"), false);
});

Deno.test("isAiAction - does not match a bare unrelated 'copilot' string", () => {
  // Precision-first: only concrete owner/name slugs match, never a bare
  // substring, so an unrelated action mentioning the word never trips.
  assertEquals(isAiAction("some-org/copilot-helper@v1"), false);
});
