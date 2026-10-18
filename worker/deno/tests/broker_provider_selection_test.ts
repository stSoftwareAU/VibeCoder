/** Real pool and billing policy, synthetic credentials, no ambient access. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  selectTrustedBrokerCredential,
  selectTrustedClaudePoolLease,
} from "../lib/broker_provider_selection.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";

const now = Date.UTC(2026, 9, 18);
function credential(
  label = "provider",
  name = "CLAUDE_CODE_OAUTH_TOKEN",
): ProviderTokenFile {
  const value = `synthetic-${label}-credential`;
  return {
    label,
    path: `/private/host/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: name === "CLAUDE_CODE_OAUTH_TOKEN",
    entries: [{ name, value }],
  };
}
function budget(label: string, remainingFraction: number): ClaudeTokenBudget {
  return {
    known: true,
    label,
    remainingFraction,
    resetAt: now + 3600_000,
    window: "five_hour",
    windows: [{
      window: "five_hour",
      remainingFraction,
      resetAt: now + 3600_000,
    }],
  };
}
function pool(candidates: ProviderTokenFile[]) {
  return createClaudeCredentialPool({
    provider: resolveAgentProvider("claude"),
    discover: () => Promise.resolve(candidates),
    now: () => now,
    fetchFn: () => Promise.reject(new Error("unexpected quota probe")),
  });
}

Deno.test({
  name:
    "trusted provider projection fixes one private credential and exposes only public quota",
  permissions: { env: false },
  fn() {
    const token = credential();
    const quota = budget(token.label, 0.7);
    const selected = selectTrustedBrokerCredential({
      provider: "claude",
      authentication: "subscription",
      credential: token,
      quota,
    });
    assertEquals(selected.status, "selected");
    assertEquals(selected.trusted, {
      credentials: { claude: token.value! },
      claudeAuthentication: "bearer",
    });
    assertEquals(selected.public, {
      provider: "claude",
      authentication: "subscription",
      billingMode: "fixed-subscription",
      credentialLabel: "provider",
      quota: {
        availability: "available",
        confidence: "authoritative",
        windows: [{
          id: "five_hour",
          remainingPercent: 70,
          resetsAt: now + 3600_000,
        }],
      },
    });
    const publicText = JSON.stringify(selected.public);
    assert(!publicText.includes(token.value!));
    assert(!publicText.includes(token.path));
    token.value = "mutated";
    token.entries[0]!.value = "mutated";
    assertEquals(
      selected.trusted.credentials.claude,
      "synthetic-provider-credential",
    );
    assertEquals(
      Reflect.set(selected.trusted.credentials, "claude", "mutated"),
      false,
    );
  },
});

Deno.test({
  name:
    "trusted Claude pool rotation preserves old leases and never falls back to API billing",
  permissions: { env: false },
  async fn() {
    const candidates = [
      credential(),
      credential("provider-2"),
      credential("api", "ANTHROPIC_API_KEY"),
    ];
    const shared = pool(candidates);
    shared.recordBudget("provider", budget("provider", 0.8), now);
    shared.recordBudget("provider-2", budget("provider-2", 0.4), now);
    const first = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "startup" },
    });
    assertEquals(first.status, "selected");
    if (!("trusted" in first)) throw new Error("Expected selected lease");
    shared.recordExhaustion("provider", [{
      window: "five_hour",
      resetAt: now + 3600_000,
    }]);
    const second = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "rotation", excludeLabel: "provider" },
    });
    assertEquals(second.status, "selected");
    if (!("trusted" in second)) throw new Error("Expected selected lease");
    assertEquals(
      second.trusted.credentials.claude,
      "synthetic-provider-2-credential",
    );
    assertEquals(
      first.trusted.credentials.claude,
      "synthetic-provider-credential",
    );
    shared.recordExhaustion("provider-2", [{
      window: "five_hour",
      resetAt: now + 3600_000,
    }]);
    const spent = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "rotation", excludeLabel: "provider-2" },
    });
    assertEquals(spent.status, "unavailable");
    assertEquals("trusted" in spent, false);
    assertEquals(spent.public.billingMode, "fixed-subscription");
  },
});

Deno.test({
  name:
    "trusted Gemini selection requires explicit API mode and refuses OAuth and Vertex",
  permissions: { env: false },
  fn() {
    const token = credential("gemini", "GEMINI_API_KEY");
    const chosen = selectTrustedBrokerCredential({
      provider: "gemini",
      authentication: "api-key",
      credential: token,
    });
    assertEquals(chosen.trusted, { credentials: { gemini: token.value! } });
    assertEquals(chosen.public.billingMode, "metered");
    for (
      const authentication of [
        "subscription",
        "oauth-personal",
        "vertex-ai",
        undefined,
      ] as unknown as ("subscription" | "api-key")[]
    ) {
      assertThrows(
        () =>
          selectTrustedBrokerCredential({
            provider: "gemini",
            authentication,
            credential: token,
          }),
        Error,
        "Unsupported trusted provider authentication",
      );
    }
  },
});

Deno.test({
  name:
    "trusted selection rejects ambiguous, mismatched and malformed credential records",
  permissions: { env: false },
  fn() {
    const base = credential();
    for (
      const bad of [
        { ...base, value: "" },
        { ...base, label: "/host/private/path" },
        { ...base, value: "secret\nheader" },
        { ...base, entries: [] },
        { ...base, entries: [{ name: base.name!, value: "different" }] },
        {
          ...base,
          entries: [...base.entries, {
            name: "ANTHROPIC_API_KEY",
            value: "metered",
          }],
        },
      ]
    ) {
      assertThrows(
        () =>
          selectTrustedBrokerCredential({
            provider: "claude",
            authentication: "subscription",
            credential: bad,
          }),
        Error,
        "Invalid selected trusted provider credential",
      );
    }
    for (
      const [provider, authentication, name] of [
        ["claude", "subscription", "ANTHROPIC_API_KEY"],
        ["claude", "api-key", "CLAUDE_CODE_OAUTH_TOKEN"],
        ["claude", "subscription", "ANTHROPIC_AUTH_TOKEN"],
        ["gemini", "api-key", "CLAUDE_CODE_OAUTH_TOKEN"],
      ] as const
    ) {
      assertThrows(
        () =>
          selectTrustedBrokerCredential({
            provider,
            authentication,
            credential: credential("provider", name),
          }),
        Error,
        "Selected credential does not match trusted billing mode",
      );
    }
    for (
      const [provider, name] of [["claude", "ANTHROPIC_API_KEY"], [
        "gemini",
        "GOOGLE_API_KEY",
      ]] as const
    ) {
      const token = credential("provider", name);
      const result = selectTrustedBrokerCredential({
        provider,
        authentication: "api-key",
        credential: token,
      });
      assertEquals(result.trusted.credentials[provider], token.value!);
      assertEquals(result.public.billingMode, "metered");
      assertEquals(result.public.quota.availability, "unknown");
    }
  },
});

Deno.test({
  name:
    "trusted public quota omits raw details and does not invent availability",
  permissions: { env: false },
  fn() {
    const token = credential();
    const selected = selectTrustedBrokerCredential({
      provider: "claude",
      authentication: "subscription",
      credential: token,
      quota: {
        known: false,
        label: token.label,
        reason: "network-error",
        detail: `${token.value} ${token.path}`,
      },
    });
    assertEquals(selected.public.quota, {
      availability: "unknown",
      confidence: "unknown",
      windows: [],
    });
    assert(!JSON.stringify(selected.public).includes(token.value!));
    assert(!JSON.stringify(selected.public).includes(token.path));
    const spent = selectTrustedBrokerCredential({
      provider: "claude",
      authentication: "subscription",
      credential: token,
      quota: budget(token.label, 0),
    });
    assertEquals(spent.public.quota.availability, "exhausted");
    assertEquals(
      Reflect.set(spent.public.quota.windows[0]!, "remainingPercent", 100),
      false,
    );
    assertEquals(Reflect.set(spent.public.quota.windows, "0", {}), false);
    assertEquals(Reflect.set(spent.public, "billingMode", "metered"), false);
    assertThrows(
      () =>
        selectTrustedBrokerCredential({
          provider: "claude",
          authentication: "subscription",
          credential: token,
          quota: budget("provider-2", 1),
        }),
      Error,
      "another credential",
    );
    assertThrows(
      () =>
        selectTrustedBrokerCredential({
          provider: "claude",
          authentication: "subscription",
          credential: token,
          quota: budget(token.label, NaN),
        }),
      Error,
      "Invalid trusted quota snapshot",
    );
    assertThrows(
      () =>
        selectTrustedBrokerCredential({
          provider: "gemini",
          authentication: "api-key",
          credential: credential("provider", "GEMINI_API_KEY"),
          quota: budget("provider", 1),
        }),
      Error,
      "Subscription quota cannot describe metered",
    );
  },
});

Deno.test({
  name:
    "trusted pool startup preserves unknown and spent quota while rotation requires available budget",
  permissions: { env: false },
  async fn() {
    const candidates = [credential(), credential("provider-2")];
    const shared = pool(candidates);
    for (const token of candidates) {
      shared.recordBudget(token.label, {
        known: false,
        label: token.label,
        reason: "timeout",
      }, now);
    }
    const unknown = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "startup" },
    });
    assertEquals(unknown.status, "selected");
    assertEquals(unknown.public.quota.availability, "unknown");
    const noRotation = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "rotation", excludeLabel: "provider" },
    });
    assertEquals(noRotation.status, "unavailable");
    for (const token of candidates) {
      shared.recordExhaustion(token.label, [{
        window: "five_hour",
        resetAt: now + 3600_000,
      }]);
    }
    const exhausted = await selectTrustedClaudePoolLease({
      pool: shared,
      candidates,
      selection: { kind: "startup" },
    });
    assertEquals(exhausted.status, "selected");
    assertEquals(exhausted.public.quota.availability, "exhausted");
    const onlyKey = [credential("api", "ANTHROPIC_API_KEY")];
    const refused = await selectTrustedClaudePoolLease({
      pool: pool(onlyKey),
      candidates: onlyKey,
      selection: { kind: "startup" },
    });
    assertEquals(refused.status, "unavailable");
    assertEquals("trusted" in refused, false);
    assertEquals(refused.public.authentication, "subscription");
  },
});

Deno.test({
  name:
    "trusted single-token selection adds no quota probe and captures caller state before awaits",
  permissions: { env: false },
  async fn() {
    const original = credential();
    const candidates = [original];
    const pending = selectTrustedClaudePoolLease({
      pool: pool(candidates),
      candidates,
      selection: { kind: "startup" },
    });
    original.value = "changed-after-selection";
    original.entries[0]!.value = "changed-after-selection";
    const chosen = await pending;
    assertEquals(chosen.status, "selected");
    if (!("trusted" in chosen)) throw new Error("Expected selected lease");
    assertEquals(
      chosen.trusted.credentials.claude,
      "synthetic-provider-credential",
    );
    assertEquals(chosen.public.quota.availability, "unknown");
  },
});

Deno.test({
  name:
    "trusted pool errors and wrong-account selections fail without credential detail",
  permissions: { env: false },
  async fn() {
    const candidates = [credential()];
    const shared = pool(candidates);
    const error = await assertRejects(
      () =>
        selectTrustedClaudePoolLease({
          pool: {
            ...shared,
            selectToken: () =>
              Promise.reject(new Error("synthetic-private-token /host/path")),
          },
          candidates,
          selection: { kind: "startup" },
        }),
      Error,
      "Trusted Claude pool selection failed",
    );
    assertEquals(error.message, "Trusted Claude pool selection failed");
    await assertRejects(
      () =>
        selectTrustedClaudePoolLease({
          pool: { ...shared, selectToken: () => credential("unlisted") },
          candidates,
          selection: { kind: "startup" },
        }),
      Error,
      "Trusted pool returned an unselected credential",
    );
    await assertRejects(
      () =>
        selectTrustedClaudePoolLease({
          pool: shared,
          candidates,
          selection: { kind: "rotation", excludeLabel: "" },
        }),
      Error,
      "Invalid trusted pool selection",
    );
    await assertRejects(
      () =>
        selectTrustedClaudePoolLease({
          pool: {
            ...shared,
            selectAvailable: () => Promise.resolve(candidates[0]!),
          },
          candidates,
          selection: { kind: "rotation", excludeLabel: "provider" },
        }),
      Error,
      "Trusted pool returned an unselected credential",
    );
  },
});
