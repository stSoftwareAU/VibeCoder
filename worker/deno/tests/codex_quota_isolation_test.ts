/**
 * Tests for Codex quota mapping and isolated child env (Issues #1696, #1698).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { quotaCandidateFromCodexBudget } from "../lib/codex_quota.ts";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";
import type { CodexBudget } from "../lib/codex_budget_source.ts";

Deno.test("quotaCandidateFromCodexBudget - API-key stays unknown, never zero", () => {
  const budget: CodexBudget = { known: false, reason: "api-key-account" };
  const candidate = quotaCandidateFromCodexBudget("provider", budget);
  assertEquals(candidate.budget.known, false);
  if (!candidate.budget.known) {
    assertEquals(candidate.budget.reason, "api-key-account");
  }
});

Deno.test("quotaCandidateFromCodexBudget - maps primary remaining fraction", () => {
  const budget: CodexBudget = {
    known: true,
    remainingFraction: 0.4,
    window: "primary",
    windows: [{
      window: "primary",
      usedPercent: 60,
      remainingFraction: 0.4,
      windowMinutes: 10080,
      resetAt: 1_800_000_000_000,
    }],
  };
  const candidate = quotaCandidateFromCodexBudget("provider-2", budget);
  assertEquals(candidate.providerId, "codex");
  assertEquals(candidate.credentialLabel, "provider-2");
  assertEquals(candidate.budget.known, true);
  if (candidate.budget.known) {
    assertEquals(candidate.budget.windows[0]?.nominalHours, 168);
    assertEquals(candidate.budget.windows[0]?.remainingFraction, 0.4);
  }
});

Deno.test("buildIsolatedCodexChildEnv - only the selected account is visible", () => {
  const child = buildIsolatedCodexChildEnv({
    OPENAI_API_KEY: "other-account",
    CODEX_API_KEY: "other-codex",
    CODEX_HOME: "/tmp/other-home",
    ANTHROPIC_API_KEY: "claude-secret",
    PATH: "/usr/bin",
    HOME: "/tmp/worker-home",
  }, {
    openaiApiKey: "selected-account",
    codexHome: "/tmp/selected-home",
  });
  assertEquals(child.OPENAI_API_KEY, "selected-account");
  assertEquals(child.CODEX_API_KEY, undefined);
  assertEquals(child.CODEX_HOME, "/tmp/selected-home");
  assertEquals(child.ANTHROPIC_API_KEY, undefined);
  assertEquals(child.PATH, "/usr/bin");
});
