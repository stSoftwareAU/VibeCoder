/** Tests for quota-aware automatic provider selection (Issue #1926). */

import { assertEquals, assertMatch } from "@std/assert";
import {
  formatAutomaticProviderSelection,
  selectAutomaticProvider,
} from "../lib/provider_auto_selection.ts";
import type { ProviderSubscriptionStatus } from "../lib/provider_quota.ts";

const NOW = 1_000_000;

function status(
  provider: string,
  overrides: Partial<ProviderSubscriptionStatus> = {},
): ProviderSubscriptionStatus {
  return {
    provider,
    credentialLabel: "provider",
    billingMode: "fixed-subscription",
    availability: "available",
    windows: [{
      id: "primary",
      remainingPercent: 50,
      resetsAt: NOW + 5 * 3_600_000,
    }],
    observedAt: NOW - 1_000,
    confidence: "authoritative",
    ...overrides,
  };
}

Deno.test("auto selector rejects metered and unknown billing modes", () => {
  const selected = selectAutomaticProvider([
    status("api", { billingMode: "metered" }),
    status("mystery", { billingMode: "unknown" }),
    status("codex"),
  ], { now: NOW });

  assertEquals(selected.winner?.provider, "codex");
  assertEquals(selected.ranked.find((c) => c.provider === "api")?.excluded, "metered-billing");
  assertEquals(selected.ranked.find((c) => c.provider === "mystery")?.excluded, "billing-unknown");
});

Deno.test("auto selector uses reset-aware constrained rate, not headline percent", () => {
  const selected = selectAutomaticProvider([
    status("claude", {
      windows: [{
        id: "weekly",
        remainingPercent: 80,
        resetsAt: NOW + 160 * 3_600_000,
      }],
    }),
    status("codex", {
      windows: [{
        id: "five-hour",
        remainingPercent: 35,
        resetsAt: NOW + 2 * 3_600_000,
      }],
    }),
  ], { now: NOW, preference: ["claude", "codex"] });

  // 35% with two hours to reset has much more spendable capacity/hour than
  // 80% held for almost a week, so Codex is the deliberate winner.
  assertEquals(selected.winner?.provider, "codex");
  assertEquals(selected.reason, "fresh-known-capacity");
});

Deno.test("auto selector uses the most constrained known window", () => {
  const selected = selectAutomaticProvider([
    status("claude", {
      windows: [
        { id: "five-hour", remainingPercent: 90, resetsAt: NOW + 3_600_000 },
        { id: "weekly", remainingPercent: 10, resetsAt: NOW + 100 * 3_600_000 },
      ],
    }),
    status("codex", {
      windows: [
        { id: "primary", remainingPercent: 20, resetsAt: NOW + 10 * 3_600_000 },
      ],
    }),
  ], { now: NOW });

  // Claude's tempting short window is constrained by the nearly-spent weekly
  // allowance (0.1%/h), so Codex's 2%/h wins.
  assertEquals(selected.winner?.provider, "codex");
});

Deno.test("fresh known capacity outranks fixed-subscription unknown quota", () => {
  const selected = selectAutomaticProvider([
    status("claude", { availability: "unknown", windows: [] }),
    status("codex"),
  ], { now: NOW });

  assertEquals(selected.winner?.provider, "codex");
});

Deno.test("unknown fixed-subscription quota remains usable as last resort", () => {
  const selected = selectAutomaticProvider([
    status("claude", { availability: "unknown", windows: [] }),
    status("codex", { availability: "exhausted" }),
  ], { now: NOW });

  assertEquals(selected.winner?.provider, "claude");
  assertEquals(selected.reason, "fixed-subscription-quota-unknown");
});

Deno.test("stale status loses to fresh status", () => {
  const selected = selectAutomaticProvider([
    status("claude", { observedAt: NOW - 11 * 60_000 }),
    status("codex", { observedAt: NOW - 1_000 }),
  ], { now: NOW, maxAgeMs: 10 * 60_000 });

  assertEquals(selected.winner?.provider, "codex");
});

Deno.test("configured provider order is the final deterministic tie-break", () => {
  const identical = {
    windows: [{ id: "primary", remainingPercent: 50, resetsAt: NOW + 3_600_000 }],
  };
  const selected = selectAutomaticProvider([
    status("claude", identical),
    status("codex", identical),
  ], { now: NOW, preference: ["codex", "claude"] });

  assertEquals(selected.winner?.provider, "codex");
});

Deno.test("exhausted and auth-unavailable providers defer to earliest reset", () => {
  const selected = selectAutomaticProvider([
    status("claude", {
      availability: "exhausted",
      windows: [{ id: "weekly", remainingPercent: 0, resetsAt: NOW + 20_000 }],
    }),
    status("codex", {
      availability: "exhausted",
      windows: [{ id: "primary", remainingPercent: 0, resetsAt: NOW + 10_000 }],
    }),
    status("other", { availability: "unavailable", windows: [] }),
  ], { now: NOW });

  assertEquals(selected.winner, null);
  assertEquals(selected.retryAt, NOW + 10_000);
  assertEquals(selected.reason, "no-eligible-fixed-subscription");
});

Deno.test("automatic decision log contains labels but no credential material", () => {
  const selected = selectAutomaticProvider([
    status("claude", { credentialLabel: "provider-2" }),
    status("codex"),
  ], { now: NOW });
  const line = formatAutomaticProviderSelection(selected);

  assertMatch(line, /automatic provider selected=/);
  assertMatch(line, /claude\/provider-2/);
  assertEquals(line.includes("token"), false);
});
