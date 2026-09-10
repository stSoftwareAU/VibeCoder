/**
 * Offline provider-parity conformance (Issue #1703, parent #1694).
 *
 * Fake adapters only — no live credentials, no CI secrets. Covers the
 * shared scheduler, scoped usage pause, isolated Codex env, and pinned
 * fallback. A live Codex smoke test is documented in
 * `docs/PROVIDER-PARITY.md` and is opt-in.
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { CODEX_QUOTA_POLICY } from "../lib/provider_quota.ts";
import { selectEligibleQuota } from "../lib/provider_quota_scheduler.ts";
import {
  usageSignalBlocksProvider,
  usageSignalPausesHost,
} from "../lib/provider_quota_scope.ts";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";
import {
  mayFallbackOn,
  nextFallbackProvider,
  resolveProviderFallbackPolicy,
} from "../lib/provider_fallback_policy.ts";

const NOW = Date.UTC(2026, 8, 10, 0, 0, 0);
const HOUR = 3_600_000;

Deno.test("conformance - Claude usage does not pause a mixed host", () => {
  const signal = {
    timestamp: 1,
    waitSeconds: 60,
    kind: "usage" as const,
    provider: "claude",
  };
  assertEquals(usageSignalPausesHost(signal, ["claude", "codex"]), false);
  assertEquals(usageSignalBlocksProvider(signal, "codex"), false);
});

Deno.test("conformance - two Codex accounts, one exhausted, selects the other", () => {
  const chosen = selectEligibleQuota(
    [
      {
        providerId: "codex",
        credentialLabel: "provider",
        budget: {
          known: true,
          windows: [{
            name: "primary",
            remainingFraction: 0,
            resetAt: NOW + HOUR,
            nominalHours: 168,
          }],
        },
      },
      {
        providerId: "codex",
        credentialLabel: "provider-2",
        budget: {
          known: true,
          windows: [{
            name: "primary",
            remainingFraction: 0.5,
            resetAt: NOW + 48 * HOUR,
            nominalHours: 168,
          }],
        },
      },
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(chosen?.credentialLabel, "provider-2");
});

Deno.test("conformance - all unavailable parks (no fallback when pinned)", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
  });
  assertEquals(mayFallbackOn(policy, "subscription-exhausted", 0), false);
  assertEquals(nextFallbackProvider(policy, "claude", []), null);
});

Deno.test("conformance - isolated child cannot see the other account", () => {
  const a = buildIsolatedCodexChildEnv({
    OPENAI_API_KEY: "account-a",
    PATH: "/bin",
  }, { openaiApiKey: "account-b" });
  assertEquals(a.OPENAI_API_KEY, "account-b");
});
