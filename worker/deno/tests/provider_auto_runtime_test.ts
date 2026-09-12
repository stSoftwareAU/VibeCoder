/** Runtime wiring tests for automatic provider selection (Issue #1926). */

import { assertEquals, assertRejects } from "@std/assert";
import {
  activeAgentProvider,
  IMAGE_AGENT_PROVIDERS_ENV,
  selectAgentProvider,
  setConfiguredAgentProviderId,
} from "../lib/agent_provider.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import {
  refreshAutomaticProviderRouting,
  resolveAutomaticProviderConfig,
  resolveAutomaticProviderStatus,
} from "../lib/provider_auto_runtime.ts";
import {
  recordAutomaticProviderOutage,
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";
import type { ProviderSubscriptionStatus } from "../lib/provider_quota.ts";
import { envFrom } from "./support/env_lookup.ts";

const NOW = 10_000_000;

/**
 * An environment whose image installed both providers (Issue #1977).
 *
 * The routing under test resolves providers through an {@link EnvLookup}, and
 * resolution is gated on the set the *running image* installed. Reading the
 * ambient environment therefore made these cases assert which agent CLIs this
 * host's image happens to carry: on a `claude`-only image they failed with
 * "did not install the codex provider" instead of exercising the routing. The
 * installed set is stated here, so the assertions hold on any image.
 */
function statedEnv(values: Record<string, string> = {}): EnvLookup {
  return envFrom({
    [IMAGE_AGENT_PROVIDERS_ENV]: "claude,codex",
    ...values,
  });
}

/** {@link statedEnv} plus the config path these cases read their config from. */
const CONFIGURED_ENV = statedEnv({ CONFIG_PATH: "/config.json" });

function available(
  provider: string,
  remainingPercent: number,
  resetHours: number,
): ProviderSubscriptionStatus {
  return {
    provider,
    credentialLabel: "active",
    billingMode: "fixed-subscription",
    availability: "available",
    windows: [{
      id: "primary",
      remainingPercent,
      resetsAt: NOW + resetHours * 3_600_000,
    }],
    observedAt: NOW,
    confidence: "authoritative",
  };
}

async function withProviderState(fn: () => Promise<void>): Promise<void> {
  try {
    setConfiguredAgentProviderId("claude");
    resetAutomaticProviderState();
    await fn();
  } finally {
    resetAutomaticProviderState();
    setConfiguredAgentProviderId("claude");
  }
}

Deno.test("auto config defaults to pinned and environment provider is absolute", () => {
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProvider: "claude",
      configuredProviders: ["claude", "codex"],
    }).mode,
    "pinned",
  );
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredMode: "auto",
      configuredProvider: "claude",
      configuredProviders: ["claude", "codex"],
      environmentProvider: "codex",
    }),
    {
      mode: "pinned",
      preference: ["codex"],
      reason: "VIBE_AGENT_PROVIDER-explicit-pin",
    },
  );
});

Deno.test("invalid automatic provider mode fails loudly", async () => {
  await assertRejects(
    async () => {
      resolveAutomaticProviderConfig({ configuredMode: "cheapest" });
    },
    Error,
    'agent_provider_mode must be "pinned" or "auto"',
  );
});

Deno.test("pinned mode makes no automatic status probe", async () => {
  await withProviderState(async () => {
    let probes = 0;
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-pinned",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider: "claude",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: () => {
        probes++;
        return available("claude", 50, 5);
      },
    });

    assertEquals(result.automatic, false);
    assertEquals(result.shouldPause, false);
    assertEquals(probes, 0);
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "claude");
  });
});

Deno.test("missing optional config preserves pinned mode", async () => {
  await withProviderState(async () => {
    let probes = 0;
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-no-config",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: () =>
        Promise.reject(new Deno.errors.NotFound("config absent")),
      env: statedEnv(),
      resolveStatus: () => {
        probes++;
        return available("claude", 50, 5);
      },
    });

    assertEquals(result.automatic, false);
    assertEquals(result.shouldPause, false);
    assertEquals(probes, 0);
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "claude");
  });
});

Deno.test("auto mode selects quota winner and updates only default routing", async () => {
  await withProviderState(async () => {
    const logs: string[] = [];
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-switch",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_provider: "claude",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (provider) =>
        provider === "claude"
          ? available("claude", 80, 160)
          : available("codex", 35, 2),
      log: (line) => logs.push(line),
    });

    assertEquals(result.automatic, true);
    assertEquals(result.shouldPause, false);
    assertEquals(result.selection?.winner?.provider, "codex");
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "codex");
    // Per-invocation pins bypass the process default even after an auto switch.
    assertEquals(
      selectAgentProvider("claude", { env: CONFIGURED_ENV }).id,
      "claude",
    );
    assertEquals(logs.some((line) => line.includes("claude->codex")), true);
  });
});

Deno.test("VIBE_AGENT_PROVIDER disables auto mode and preserves explicit provider", async () => {
  await withProviderState(async () => {
    let probes = 0;
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-env-pin",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_providers: ["claude", "codex"],
        }),
      env: statedEnv({
        CONFIG_PATH: "/config.json",
        VIBE_AGENT_PROVIDER: "codex",
      }),
      resolveStatus: () => {
        probes++;
        return available("claude", 100, 1);
      },
    });

    assertEquals(result.automatic, false);
    assertEquals(probes, 0);
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "codex");
  });
});

Deno.test("pinned config keeps file precedence over VIBE_AGENT_PROVIDER", async () => {
  await withProviderState(async () => {
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-pinned-file-precedence",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider: "claude",
          agent_providers: ["claude", "codex"],
        }),
      env: statedEnv({
        CONFIG_PATH: "/config.json",
        VIBE_AGENT_PROVIDER: "codex",
      }),
    });

    assertEquals(result.automatic, false);
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "claude");
  });
});

Deno.test("provider-scoped usage signal makes auto route around exhausted provider", async () => {
  await withProviderState(async () => {
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-signal",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      signal: {
        timestamp: Math.floor(NOW / 1000),
        waitSeconds: 3600,
        resetEpochMs: NOW + 3_600_000,
        kind: "usage",
        provider: "claude",
      },
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (provider) => available(provider, 50, 5),
      log: () => {},
    });

    assertEquals(result.selection?.winner?.provider, "codex");
    assertEquals(result.shouldPause, false);
  });
});

Deno.test("observed authentication failure routes subsequent work to another subscription", async () => {
  await withProviderState(async () => {
    setAutomaticProviderRoutingActive(true);
    recordAutomaticProviderOutage("claude", "authentication", {
      observedAt: NOW - 1,
    });

    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-auth-failover",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_provider: "claude",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (provider, context) =>
        provider === "claude"
          ? resolveAutomaticProviderStatus(provider, context)
          : available("codex", 20, 2),
      log: () => {},
    });

    assertEquals(result.selection?.winner?.provider, "codex");
    assertEquals(result.shouldPause, false);
    assertEquals(
      result.selection?.ranked.find((candidate) =>
        candidate.status.provider === "claude"
      )?.status.reason,
      "observed-authentication-failure",
    );
  });
});

Deno.test("all fixed subscriptions exhausted pauses without choosing a provider", async () => {
  await withProviderState(async () => {
    const exhausted = (provider: string): ProviderSubscriptionStatus => ({
      ...available(provider, 0, 1),
      availability: "exhausted",
    });
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-exhausted",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (provider) => exhausted(provider),
      log: () => {},
    });

    assertEquals(result.shouldPause, true);
    assertEquals(result.selection?.winner, null);
    assertEquals(result.selection?.retryAt, NOW + 3_600_000);
    // No fallback mutation occurs when there is no safe winner.
    assertEquals(activeAgentProvider({ env: CONFIGURED_ENV }).id, "claude");
  });
});

Deno.test("status resolver failure is fail-closed, never a metered candidate", async () => {
  await withProviderState(async () => {
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-status-failure",
      enabledProviderIds: ["claude"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_providers: ["claude"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: () => {
        throw new Error("probe exploded with secret-shaped detail");
      },
      log: () => {},
    });

    assertEquals(result.shouldPause, true);
    assertEquals(result.selection?.winner, null);
    assertEquals(result.selection?.ranked[0]?.status.billingMode, "unknown");
    assertEquals(
      result.selection?.ranked[0]?.status.reason,
      "status-resolution-failed",
    );
  });
});

Deno.test("automatic routing reads the active provider from the environment it was given", async () => {
  await withProviderState(async () => {
    // The stated image installed codex alone while the process default is
    // still claude, so adopting a winner must fail loud naming claude. The
    // ambient image cannot make this pass or fail: the environment handed to
    // the refresh is the one that decides (Issue #1977).
    await assertRejects(
      () =>
        refreshAutomaticProviderRouting({
          workDir: "/tmp/vibe-auto-stated-image",
          enabledProviderIds: ["claude", "codex"],
          now: NOW,
          readTextFile: async () =>
            JSON.stringify({
              agent_provider_mode: "auto",
              agent_providers: ["claude", "codex"],
            }),
          env: envFrom({
            [IMAGE_AGENT_PROVIDERS_ENV]: "codex",
            CONFIG_PATH: "/config.json",
          }),
          resolveStatus: (provider) => available(provider, 50, 5),
          log: () => {},
        }),
      Error,
      'did not install the "claude" coding-agent provider',
    );
  });
});
