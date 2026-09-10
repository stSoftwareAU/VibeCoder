/** Tests for the provider-agnostic subscription status layer (#1925). */

import { assertEquals } from "@std/assert";
import {
  ProviderSubscriptionStatusCache,
  subscriptionStatusFromQuotaCandidate,
} from "../lib/provider_subscription_status.ts";
import { subscriptionStatusFromClaudeBudget } from "../lib/claude_subscription_status.ts";
import { subscriptionStatusFromCodexSnapshot } from "../lib/codex_subscription_status.ts";
import type { CodexBudgetSnapshot } from "../lib/codex_budget.ts";

Deno.test("subscription status preserves multiple windows and resets", () => {
  const status = subscriptionStatusFromQuotaCandidate({
    providerId: "test-provider",
    credentialLabel: "primary",
    budget: {
      known: true,
      windows: [
        { name: "short", remainingFraction: 0.75, resetAt: 11_000 },
        { name: "weekly", remainingFraction: 0.4, resetAt: 22_000 },
      ],
    },
  }, 1_000, { billingMode: "fixed-subscription", confidence: "authoritative" });

  assertEquals(status.availability, "available");
  assertEquals(status.windows, [
    { id: "short", remainingPercent: 75, resetsAt: 11_000 },
    { id: "weekly", remainingPercent: 40, resetsAt: 22_000 },
  ]);
});

Deno.test("unknown quota remains unknown rather than exhausted", () => {
  const status = subscriptionStatusFromQuotaCandidate({
    providerId: "test-provider",
    credentialLabel: "primary",
    budget: { known: false, reason: "telemetry-unavailable" },
  }, 2_000);

  assertEquals(status.availability, "unknown");
  assertEquals(status.reason, "telemetry-unavailable");
});

Deno.test("zero remaining marks a fixed subscription exhausted", () => {
  const status = subscriptionStatusFromQuotaCandidate({
    providerId: "test-provider",
    credentialLabel: "primary",
    budget: {
      known: true,
      windows: [{ name: "weekly", remainingFraction: 0, resetAt: 9_000 }],
    },
  }, 2_000);

  assertEquals(status.availability, "exhausted");
});

Deno.test("metered credential is unavailable even with apparent budget", () => {
  const status = subscriptionStatusFromQuotaCandidate({
    providerId: "codex",
    credentialLabel: "api",
    budget: {
      known: true,
      windows: [{ name: "fake", remainingFraction: 1 }],
    },
  }, 2_000, { billingMode: "metered" });

  assertEquals(status.billingMode, "metered");
  assertEquals(status.availability, "unavailable");
  assertEquals(status.reason, "metered-billing-not-eligible");
  assertEquals(status.windows, []);
});

Deno.test("status cache reuses fresh probe and refreshes stale probe", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new ProviderSubscriptionStatusCache({
    maxAgeMs: 100,
    now: () => now,
  });
  const probe = () => {
    calls++;
    return {
      provider: "claude",
      credentialLabel: "provider",
      billingMode: "fixed-subscription" as const,
      availability: "available" as const,
      windows: [],
      observedAt: now,
      confidence: "authoritative" as const,
    };
  };

  await cache.get("claude", "provider", probe);
  now = 1_050;
  await cache.get("claude", "provider", probe);
  assertEquals(calls, 1);

  now = 1_101;
  await cache.get("claude", "provider", probe);
  assertEquals(calls, 2);
});

Deno.test("status cache converts probe failure to safe unknown without error text", async () => {
  const cache = new ProviderSubscriptionStatusCache({ now: () => 5_000 });
  const status = await cache.get("codex", "provider", () => {
    throw new Error("secret-token-must-not-escape");
  });

  assertEquals(status.availability, "unknown");
  assertEquals(status.confidence, "unknown");
  assertEquals(status.reason, "probe-failed");
  assertEquals(JSON.stringify(status).includes("secret-token-must-not-escape"), false);
});

Deno.test("observed exhaustion immediately replaces cached status", async () => {
  let now = 7_000;
  const cache = new ProviderSubscriptionStatusCache({ now: () => now });
  await cache.get("codex", "provider", () => ({
    provider: "codex",
    credentialLabel: "provider",
    billingMode: "fixed-subscription",
    availability: "available",
    windows: [{ id: "primary", remainingPercent: 50, resetsAt: 20_000 }],
    observedAt: now,
    confidence: "authoritative",
  }));

  now = 8_000;
  const exhausted = cache.recordExhaustion("codex", "provider", 20_000);
  assertEquals(exhausted.availability, "exhausted");
  assertEquals(exhausted.windows[0]?.resetsAt, 20_000);
  assertEquals(cache.latest("codex", "provider"), exhausted);
});

Deno.test("Claude adapter preserves mature probe windows without reprobe", () => {
  const status = subscriptionStatusFromClaudeBudget({
    known: true,
    label: "provider-2",
    remainingFraction: 0.25,
    resetAt: 20_000,
    window: "seven_day",
    windows: [
      { window: "five_hour", remainingFraction: 0.8, resetAt: 10_000 },
      { window: "seven_day", remainingFraction: 0.25, resetAt: 20_000 },
    ],
  }, 3_000);

  assertEquals(status.provider, "claude");
  assertEquals(status.billingMode, "fixed-subscription");
  assertEquals(status.windows.length, 2);
  assertEquals(status.availability, "available");
});

Deno.test("Codex API-key snapshot is explicitly metered and unavailable", () => {
  const snapshot: CodexBudgetSnapshot = {
    budget: { known: false, reason: "api-key-account" },
    source: "auth-mode",
    readAt: 4_000,
    evidenceAt: 4_000,
    authMode: "api-key",
  };

  const status = subscriptionStatusFromCodexSnapshot("provider", snapshot);
  assertEquals(status.billingMode, "metered");
  assertEquals(status.availability, "unavailable");
  assertEquals(status.reason, "api-key-account");
});

Deno.test("Codex ChatGPT snapshot maps to fixed subscription", () => {
  const snapshot: CodexBudgetSnapshot = {
    budget: {
      known: true,
      remainingFraction: 0.6,
      windows: [{
        window: "primary",
        usedPercent: 40,
        remainingFraction: 0.6,
        resetAt: 30_000,
        windowMinutes: 300,
      }],
    },
    source: "rollout-token-count",
    readAt: 4_000,
    capturedAt: 3_900,
    evidenceAt: 3_900,
    authMode: "chatgpt",
  };

  const status = subscriptionStatusFromCodexSnapshot("provider", snapshot);
  assertEquals(status.billingMode, "fixed-subscription");
  assertEquals(status.availability, "available");
  assertEquals(status.windows[0]?.remainingPercent, 60);
});
