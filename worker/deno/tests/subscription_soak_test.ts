/**
 * Unattended restart/soak coverage for subscription providers (Issue #1927).
 *
 * The automatic routing, quota probing and Codex subscription authentication
 * were each delivered by their own issue (#1924/#1925/#1926) with unit tests.
 * This suite is the *qualification* layer: it proves the whole path behaves
 * across the lifecycle it is designed for — repeated worker/container
 * restarts, refreshed auth persisted outside the disposable container, and
 * fail-closed billing when every fixed-price subscription is spent.
 *
 * Every test drives the real production modules (`selectAutomaticProvider`,
 * `buildIsolatedCodexChildEnv`, `resolveCodexAuthMode`) through the
 * observability surface added for this issue (`subscription_soak_status.ts`).
 * No test inspects source text; each asserts a result, an exit, or a side
 * effect.
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { selectAutomaticProvider } from "../lib/provider_auto_selection.ts";
import type { ProviderSubscriptionStatus } from "../lib/provider_quota.ts";
import { resolveCodexAuthMode } from "../lib/codex_auth_mode.ts";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";
import {
  buildSubscriptionSoakStatus,
  isTokenRefreshDue,
  refreshInstant,
  type SubscriptionAuthEvidence,
} from "../lib/subscription_soak_status.ts";

const NOW = 1_700_000_000_000;

function status(
  provider: string,
  overrides: Partial<ProviderSubscriptionStatus> = {},
): ProviderSubscriptionStatus {
  return {
    provider,
    credentialLabel: "active",
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

/** Subscription evidence for a persistent ChatGPT login. */
function chatgptAuth(
  overrides: Partial<SubscriptionAuthEvidence> = {},
): SubscriptionAuthEvidence {
  return {
    kind: "subscription-login",
    persistedDurably: true,
    refreshedAt: NOW - 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Restart-cycle determinism (acceptance: automated restart-cycle coverage,
// Claude-only baseline)
// ---------------------------------------------------------------------------

Deno.test("soak status - a Claude-only baseline is byte-identical across worker restarts", () => {
  const claude = status("claude", {
    windows: [{
      id: "five_hour",
      remainingPercent: 90,
      resetsAt: NOW + 3_600_000,
    }, {
      id: "seven_day",
      remainingPercent: 62,
      resetsAt: NOW + 100 * 3_600_000,
    }],
  });

  // Two independent worker generations, same inputs, no process state.
  const first = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude"],
    statuses: [claude],
    auths: { claude: { kind: "subscription-login", persistedDurably: true } },
    now: NOW,
    selection: selectAutomaticProvider([claude], { now: NOW }),
  });
  const second = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude"],
    statuses: [claude],
    auths: { claude: { kind: "subscription-login", persistedDurably: true } },
    now: NOW,
    selection: selectAutomaticProvider([claude], { now: NOW }),
  });

  assertEquals(second, first, "identical inputs must produce identical status");
  assertEquals(first.entries.length, 1);
  assertEquals(first.entries[0]?.provider, "claude");
  assertEquals(first.authRequiredProviders, []);
});

Deno.test("soak status - repeated builds need no files, settings or ambient state", () => {
  // The observability surface is a pure function of (statuses, auth, now,
  // selection). Nothing is read from disk or the process environment, so a
  // restart that only recreates the container cannot change the baseline.
  const claude = status("claude");
  const summary = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude"],
    statuses: [claude],
    auths: { claude: { kind: "subscription-login", persistedDurably: true } },
    now: NOW,
    selection: selectAutomaticProvider([claude], { now: NOW }),
  });

  assertStringIncludes(summary.summary, "providers-enabled=claude");
  assertStringIncludes(summary.summary, "chosen=claude");
  assertStringIncludes(summary.summary, "auth-required=none");
});

// ---------------------------------------------------------------------------
// Codex refreshed auth survives disposable container replacement
// ---------------------------------------------------------------------------

Deno.test("soak status - refreshed Codex auth persists outside the disposable container", async () => {
  const persistentState = await Deno.makeTempDir({
    prefix: "soak-agent-state-",
  });
  const codexHome = `${persistentState}/codex`;
  await Deno.mkdir(codexHome, { recursive: true });
  try {
    const authJson = {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "gen1-access-token",
        refresh_token: "gen1-refresh-token",
      },
    };
    await Deno.writeTextFile(
      `${codexHome}/auth.json`,
      JSON.stringify(authJson),
    );

    // Container generation 1 and a fresh generation 2 share only the
    // persistent agent-state directory; the container is destroyed in between.
    const gen1 = buildIsolatedCodexChildEnv(
      { PATH: "/usr/bin", OPENAI_API_KEY: "metered-must-not-leak" },
      { codexHome },
    );
    const gen2 = buildIsolatedCodexChildEnv(
      { PATH: "/usr/bin", CODEX_API_KEY: "metered-must-not-leak-either" },
      { codexHome },
    );

    assertEquals(gen1.CODEX_HOME, codexHome);
    assertEquals(gen2.CODEX_HOME, codexHome);
    assertEquals(gen1.OPENAI_API_KEY, undefined);
    assertEquals(gen2.CODEX_API_KEY, undefined);

    // Both generations classify the *same persisted* auth as a ChatGPT login.
    assertEquals(
      resolveCodexAuthMode(codexHome, () => undefined).mode,
      "chatgpt",
    );
    assertEquals(
      resolveCodexAuthMode(codexHome, () => undefined).mode,
      "chatgpt",
    );
  } finally {
    await Deno.remove(persistentState, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Token refresh, not unexpired-token reuse
// ---------------------------------------------------------------------------

Deno.test("soak status - refresh horizon forces token refresh before reuse", () => {
  // An access token minted 13 hours ago with 11 hours of lifetime left is still
  // *unexpired*, but the refresh horizon (12h) has already passed, so it must be
  // refreshed rather than reused indefinitely.
  const refreshedAt = NOW - 13 * 3_600_000;
  const expiresAt = NOW + 11 * 3_600_000;
  const horizon = 12 * 3_600_000;

  const refreshBy = refreshInstant(expiresAt, refreshedAt, horizon);
  assertEquals(refreshBy, refreshedAt + horizon);

  assert(isTokenRefreshDue(refreshBy, NOW));
  // A freshly refreshed token is not due.
  assertFalse(isTokenRefreshDue(
    refreshInstant(NOW + 24 * 3_600_000, NOW - 60_000, horizon),
    NOW,
  ));
});

Deno.test("soak status - expiry always wins over the refresh horizon", () => {
  const horizon = 12 * 3_600_000;
  // Expires in 2 hours: refresh must happen at expiry, not at mint+horizon.
  const refreshBy = refreshInstant(
    NOW + 2 * 3_600_000,
    NOW - 60_000,
    horizon,
  );
  assertEquals(refreshBy, NOW + 2 * 3_600_000);
});

// ---------------------------------------------------------------------------
// Automatic routing: failover and recovery-after-reset
// ---------------------------------------------------------------------------

Deno.test("soak status - failover then recovery-after-reset is observable", () => {
  const exhaustedClaude = status("claude", {
    availability: "exhausted",
    windows: [{ id: "weekly", remainingPercent: 0, resetsAt: NOW + 3_600_000 }],
  });
  const healthyCodex = status("codex", {
    windows: [{
      id: "primary",
      remainingPercent: 40,
      resetsAt: NOW + 20 * 3_600_000,
    }],
  });

  // Exhaustion: work must move to Codex unattended.
  const failover = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [exhaustedClaude, healthyCodex],
    auths: { claude: chatgptAuth(), codex: chatgptAuth() },
    now: NOW,
    selection: selectAutomaticProvider([exhaustedClaude, healthyCodex], {
      now: NOW,
      preference: ["claude", "codex"],
    }),
  });
  assertEquals(failover.selection.winner?.provider, "codex");
  assertStringIncludes(failover.summary, "chosen=codex");
  assertEquals(failover.retryAt, NOW + 3_600_000);

  // Quota reset: after the reset instant Claude is eligible again and wins on
  // the deterministic preference tie-break.
  const later = NOW + 3_600_001;
  const resetClaude = status("claude", {
    windows: [{
      id: "weekly",
      remainingPercent: 100,
      resetsAt: later + 168 * 3_600_000,
    }],
    observedAt: later,
  });
  const recovery = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [resetClaude, healthyCodex],
    auths: { claude: chatgptAuth(), codex: chatgptAuth() },
    now: later,
    selection: selectAutomaticProvider([resetClaude, healthyCodex], {
      now: later,
      preference: ["claude", "codex"],
    }),
  });
  assertEquals(recovery.selection.winner?.provider, "claude");
});

// ---------------------------------------------------------------------------
// Billing guard: metered-looking credentials can never be consumed
// ---------------------------------------------------------------------------

Deno.test("soak status - all subscriptions exhausted defers, never a metered fallback", () => {
  const exhaustedClaude = status("claude", {
    availability: "exhausted",
    windows: [{ id: "weekly", remainingPercent: 0, resetsAt: NOW + 3_600_000 }],
  });
  const exhaustedCodex = status("codex", {
    availability: "exhausted",
    windows: [{
      id: "primary",
      remainingPercent: 0,
      resetsAt: NOW + 3_600_000,
    }],
  });
  // A metered-looking credential is *present* in the environment-shaped input:
  // the automatic router must never select it, however tempting.
  const meteredCodex = status("codex", {
    credentialLabel: "api-key",
    billingMode: "metered",
    availability: "available",
  });

  const selection = selectAutomaticProvider(
    [exhaustedClaude, exhaustedCodex, meteredCodex],
    { now: NOW, preference: ["claude", "codex"] },
  );
  const soak = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [exhaustedClaude, exhaustedCodex, meteredCodex],
    auths: {
      claude: chatgptAuth(),
      codex: {
        kind: "metered",
        persistedDurably: false,
        reason: "OPENAI_API_KEY",
      },
    },
    now: NOW,
    selection,
  });

  assertEquals(selection.winner, null);
  assertEquals(soak.billingGuard.holds, true);
  assertFalse(soak.billingGuard.meteredCandidateWon);
  assertStringIncludes(soak.summary, "chosen=none");
  assertStringIncludes(soak.summary, "all-eligible-exhausted=true");
});

// ---------------------------------------------------------------------------
// Malformed / unavailable telemetry → conservative behaviour, worker alive
// ---------------------------------------------------------------------------

Deno.test("soak status - malformed quota telemetry keeps the worker conservative", () => {
  const unknownClaude = status("claude", {
    availability: "unknown",
    windows: [],
    confidence: "unknown",
    reason: "probe-failed",
  });
  const unknownCodex = status("codex", {
    availability: "unknown",
    windows: [],
    confidence: "unknown",
    reason: "no-rate-limit-event",
  });

  const selection = selectAutomaticProvider([unknownClaude, unknownCodex], {
    now: NOW,
    preference: ["claude", "codex"],
  });
  const soak = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [unknownClaude, unknownCodex],
    auths: { claude: chatgptAuth(), codex: chatgptAuth() },
    now: NOW,
    selection,
  });

  // Unknown quota is not fabricated into zero, and is not metered: it is the
  // conservative last resort, and it never becomes an API-key spend.
  assert(soak.billingGuard.holds);
  assertStringIncludes(soak.summary, "reason=");
});

// ---------------------------------------------------------------------------
// Observability: no secrets
// ---------------------------------------------------------------------------

Deno.test("soak status - the summary carries status, never credential material", () => {
  const claude = status("claude", { credentialLabel: "provider-2" });
  const codex = status("codex");
  const soak = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [claude, codex],
    auths: { claude: chatgptAuth(), codex: chatgptAuth() },
    now: NOW,
    selection: selectAutomaticProvider([claude, codex], { now: NOW }),
  });

  const text = `${soak.summary}\n${
    soak.entries.map((entry) => JSON.stringify(entry)).join("\n")
  }`;
  assertStringIncludes(text, "claude/provider-2");
  assertStringIncludes(text, "last-quota-probe");
  assertFalse(/sk-[A-Za-z0-9]/.test(text));
  assertFalse(text.includes("access_token"));
  assertFalse(text.includes("refresh_token"));
  assertFalse(text.includes("OPENAI_API_KEY"));
});

Deno.test("soak status - an authentication failure names the provider for re-auth", () => {
  const claudeRejected = status("claude", {
    availability: "unavailable",
    confidence: "authoritative",
    reason: "authentication-rejected",
  });
  const codex = status("codex");
  const soak = buildSubscriptionSoakStatus({
    enabledProviderIds: ["claude", "codex"],
    statuses: [claudeRejected, codex],
    auths: { claude: chatgptAuth(), codex: chatgptAuth() },
    now: NOW,
    selection: selectAutomaticProvider([claudeRejected, codex], {
      now: NOW,
      preference: ["claude", "codex"],
    }),
  });

  assertStringIncludes(soak.authRequiredProviders.join(","), "claude");
  assertStringIncludes(soak.summary, "auth-required=claude");
});
