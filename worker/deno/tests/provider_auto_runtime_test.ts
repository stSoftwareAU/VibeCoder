/** Runtime wiring tests for automatic provider selection (Issue #1926). */

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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

/** An environment whose image installed Claude, Codex and Gemini (Issue #5344). */
function geminiEnv(values: Record<string, string> = {}): EnvLookup {
  return envFrom({
    [IMAGE_AGENT_PROVIDERS_ENV]: "claude,codex,gemini",
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

Deno.test("an absent mode defaults to auto when two subscriptions are enabled (Issue #5089)", () => {
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProvider: "claude",
      configuredProviders: ["claude", "codex"],
    }),
    { mode: "auto", preference: [], reason: "default-auto" },
  );
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProviders: ["codex", "deepseek", "claude"],
    }).mode,
    "auto",
  );
});

Deno.test("an absent mode stays pinned without two subscriptions (Issue #5089)", () => {
  // Auto pauses when no fixed-price subscription is eligible, so a host with
  // one subscription, or only pay-per-call providers, must stay pinned.
  for (
    const providers of [
      undefined,
      ["claude"],
      ["claude", "deepseek"],
      ["deepseek"],
      ["claude", "claude"],
    ]
  ) {
    assertEquals(
      resolveAutomaticProviderConfig({
        configuredProvider: "claude",
        configuredProviders: providers,
      }).mode,
      "pinned",
      JSON.stringify(providers),
    );
  }
});

Deno.test("an explicit pinned mode wins over the two-subscription default (Issue #5089)", () => {
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredMode: "pinned",
      configuredProvider: "claude",
      configuredProviders: ["claude", "codex"],
    }).mode,
    "pinned",
  );
});

Deno.test("the environment provider is an absolute pin", () => {
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
          agent_provider_mode: "pinned",
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
          ? available("claude", 35, 2)
          : available("codex", 80, 160),
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

Deno.test("a config with two subscriptions and no mode routes automatically by quota (Issue #5089)", async () => {
  await withProviderState(async () => {
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-default",
      enabledProviderIds: ["claude", "codex", "deepseek"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider: "claude",
          agent_providers: ["claude", "codex", "deepseek"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (id) =>
        id === "claude"
          ? available("claude", 20, 5)
          : id === "codex"
          ? available("codex", 70, 5)
          : { ...available(id, 100, 5), billingMode: "metered" },
    });

    assertEquals(result.automatic, true);
    assertEquals(result.selection?.winner?.provider, "codex");
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
          agent_provider_mode: "pinned",
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

Deno.test("a metered ANTHROPIC_API_KEY classifies Claude as ineligible for auto routing", async () => {
  await withProviderState(async () => {
    const status = await resolveAutomaticProviderStatus("claude", {
      workDir: "/tmp/vibe-auto-anthropic-key",
      env: statedEnv({ ANTHROPIC_API_KEY: "sk-ant-metered-must-never-route" }),
      now: NOW,
    });

    assertEquals(status.billingMode, "metered");
    assertEquals(status.availability, "unavailable");
    assertEquals(status.reason, "api-key-account");
  });
});

Deno.test("auto routing emits the soak status line without credential material", async () => {
  await withProviderState(async () => {
    const logged: string[] = [];
    const result = await refreshAutomaticProviderRouting({
      workDir: "/tmp/vibe-auto-soak-emit",
      enabledProviderIds: ["claude", "codex"],
      now: NOW,
      readTextFile: async () =>
        JSON.stringify({
          agent_provider_mode: "auto",
          agent_providers: ["claude", "codex"],
        }),
      env: CONFIGURED_ENV,
      resolveStatus: (provider) => available(provider, 50, 5),
      log: (message) => logged.push(message),
    });

    assertEquals(result.automatic, true);
    const soakLine = logged.find((line) => line.startsWith("[soak] "));
    assertEquals(typeof soakLine, "string", "the [soak] line is emitted");
    assertStringIncludes(soakLine ?? "", "providers-enabled=claude,codex");
    assertStringIncludes(soakLine ?? "", "chosen=claude");
    assertStringIncludes(soakLine ?? "", "billing-guard=holds");
    assertStringIncludes(soakLine ?? "", "last-quota-probe=");
    // The summary is labels and reason codes only; no credential-shaped text.
    assertEquals((soakLine ?? "").includes("secret"), false);
  });
});

Deno.test("auto Codex status uses the child's subscription home despite ambient API keys", async () => {
  const home = await Deno.makeTempDir({ prefix: "codex-auto-home-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    const status = await resolveAutomaticProviderStatus("codex", {
      workDir: "/unused-work",
      now: Date.now(),
      env: statedEnv({ CODEX_HOME: home, OPENAI_API_KEY: "must-not-bill" }),
      probeCodex: async () => ({ known: false, reason: "read-error" }),
    });
    assertEquals(status.billingMode, "fixed-subscription");
    assertEquals(status.availability, "unknown");
    const absent = await resolveAutomaticProviderStatus("codex", {
      workDir: "/unused-work",
      now: Date.now(),
      env: statedEnv({ OPENAI_API_KEY: "explicit-metered" }),
    });
    assertEquals(absent.billingMode, "metered");
    assertEquals(absent.availability, "unavailable");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("auto Codex status refreshes quota without a previous model run", async () => {
  const home = await Deno.makeTempDir({ prefix: "codex-live-status-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    let probes = 0;
    const context = {
      workDir: "/unused",
      now: Date.now(),
      env: statedEnv({ CODEX_HOME: home }),
      probeCodex: async ({ codexHome }: { codexHome: string }) => {
        probes++;
        assertEquals(codexHome, home);
        return {
          known: true as const,
          remainingFraction: 0.8,
          windows: [{
            window: "primary" as const,
            usedPercent: 20,
            remainingFraction: 0.8,
          }],
        };
      },
    };
    const status = await resolveAutomaticProviderStatus("codex", context);
    assertEquals(status.availability, "available");
    assertEquals(status.confidence, "authoritative");
    assertEquals(status.windows[0]?.remainingPercent, 80);
    await resolveAutomaticProviderStatus("codex", context);
    assertEquals(probes, 1, "the fresh live observation is cached");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("auto Codex status never probes an API-key account", async () => {
  const home = await Deno.makeTempDir({ prefix: "codex-api-status-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "not-a-subscription",
      }),
    );
    let probes = 0;
    const status = await resolveAutomaticProviderStatus("codex", {
      workDir: "/unused",
      now: Date.now(),
      env: statedEnv({ CODEX_HOME: home }),
      probeCodex: async () => {
        probes++;
        return { known: false, reason: "read-error" };
      },
    });
    assertEquals(status.billingMode, "metered");
    assertEquals(probes, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("Gemini counts as a subscription for the absent-mode default (Issue #5339)", () => {
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProviders: ["claude", "gemini"],
    }),
    { mode: "auto", preference: [], reason: "default-auto" },
  );
  const pinned = resolveAutomaticProviderConfig({
    configuredProviders: ["gemini", "deepseek"],
  });
  assertEquals(pinned.mode, "pinned");
  assertEquals(pinned.reason, "default-pinned");
});

/** Run `fn` with a GEMINI_CLI_HOME holding a Google login (Issue #5344). */
async function withGeminiLogin(
  fn: (home: string) => Promise<void>,
  credentials = '{"refresh_token":"fixture-refresh"}',
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "vibe-gemini-home-" });
  try {
    await Deno.mkdir(`${home}/.gemini`, { recursive: true });
    await Deno.writeTextFile(`${home}/.gemini/oauth_creds.json`, credentials);
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

const GEMINI_WORK_DIR = "/tmp/vibe-gemini-5344";

Deno.test("a Google login reports Gemini as a passive-quota candidate (Issue #5344)", async () => {
  await withProviderState(async () => {
    await withGeminiLogin(async (home) => {
      const status = await resolveAutomaticProviderStatus("gemini", {
        workDir: GEMINI_WORK_DIR,
        env: geminiEnv({ GEMINI_CLI_HOME: home }),
        now: NOW,
      });
      assertEquals(status.availability, "available");
      assertEquals(status.billingMode, "fixed-subscription");
      assertEquals(status.windows, []);
      assertEquals(status.observedAt, NOW);
      assertEquals(status.reason, "gemini-google-login");
      assertNotEquals(status.reason, "fixed-subscription-status-not-supported");
    });
  });
});

Deno.test("a Gemini API key is metered and never wins auto (Issue #5344)", async () => {
  await withProviderState(async () => {
    const env = geminiEnv({ GEMINI_API_KEY: "metered-key" });
    const status = await resolveAutomaticProviderStatus("gemini", {
      workDir: GEMINI_WORK_DIR,
      env,
      now: NOW,
    });
    assertEquals(status.availability, "unavailable");
    assertEquals(status.billingMode, "metered");
    assertEquals(status.reason, "api-key-account");

    const alone = await refreshAutomaticProviderRouting({
      workDir: GEMINI_WORK_DIR,
      enabledProviderIds: ["gemini"],
      now: NOW,
      readTextFile: async () => JSON.stringify({ agent_provider_mode: "auto" }),
      env,
      resolveStatus: resolveAutomaticProviderStatus,
      log: () => {},
    });
    assertEquals(alone.selection?.winner, null);
    assertEquals(alone.shouldPause, true);
    assertEquals(
      alone.selection?.ranked.find((c) => c.provider === "gemini")?.excluded,
      "metered-billing",
    );

    const withClaude = await refreshAutomaticProviderRouting({
      workDir: GEMINI_WORK_DIR,
      enabledProviderIds: ["claude", "gemini"],
      now: NOW,
      readTextFile: async () => JSON.stringify({ agent_provider_mode: "auto" }),
      env,
      resolveStatus: (id, context) =>
        id === "claude"
          ? available("claude", 50, 5)
          : resolveAutomaticProviderStatus(id, context),
      log: () => {},
    });
    assertEquals(withClaude.selection?.winner?.provider, "claude");
  });
});

Deno.test("a logged-in Gemini ranks after a provider with a known window (Issue #5344)", async () => {
  await withProviderState(async () => {
    await withGeminiLogin(async (home) => {
      const logs: string[] = [];
      const result = await refreshAutomaticProviderRouting({
        workDir: GEMINI_WORK_DIR,
        enabledProviderIds: ["claude", "gemini"],
        now: NOW,
        readTextFile: async () =>
          JSON.stringify({ agent_provider_mode: "auto" }),
        env: geminiEnv({ GEMINI_CLI_HOME: home }),
        resolveStatus: (id, context) =>
          id === "claude"
            ? available("claude", 5, 5)
            : resolveAutomaticProviderStatus(id, context),
        log: (message) => logs.push(message),
      });
      assertEquals(result.selection?.winner?.provider, "claude");
      const ranked = result.selection?.ranked ?? [];
      assertEquals(ranked.map((c) => c.provider), ["claude", "gemini"]);
      assertEquals(ranked[0]?.band, "fresh-known");
      assertEquals(ranked[1]?.band, "fresh-unknown-quota");
      assertEquals(ranked[1]?.excluded, null);
      assertStringIncludes(logs.join("\n"), "gemini");
    });
  });
});

Deno.test("a run-reported quota exhaustion makes a logged-in Gemini exhausted until retry (Issue #5344)", async () => {
  await withProviderState(async () => {
    await withGeminiLogin(async (home) => {
      const context = {
        workDir: GEMINI_WORK_DIR,
        env: geminiEnv({ GEMINI_CLI_HOME: home }),
      };
      setAutomaticProviderRoutingActive(true);
      recordAutomaticProviderOutage("gemini", "quota-exhausted", {
        observedAt: NOW - 1,
        retryAt: NOW + 60_000,
      });
      const during = await resolveAutomaticProviderStatus("gemini", {
        ...context,
        now: NOW,
      });
      assertEquals(during.availability, "exhausted");
      const after = await resolveAutomaticProviderStatus("gemini", {
        ...context,
        now: NOW + 60_000,
      });
      assertEquals(after.availability, "available");
    });
  });
});

Deno.test("the default mode ignores providers proved metered (Issue #5344)", async () => {
  await withProviderState(async () => {
    await withGeminiLogin(async (home) => {
      const providers = ["claude", "gemini"];
      assertEquals(
        resolveAutomaticProviderConfig({
          configuredProviders: providers,
          billingContext: {
            workDir: GEMINI_WORK_DIR,
            env: geminiEnv({ GEMINI_CLI_HOME: home }),
          },
        }),
        { mode: "auto", preference: [], reason: "default-auto" },
      );
      assertEquals(
        resolveAutomaticProviderConfig({
          configuredProviders: providers,
          billingContext: {
            workDir: GEMINI_WORK_DIR,
            env: geminiEnv({ GEMINI_API_KEY: "metered-key" }),
          },
        }),
        { mode: "pinned", preference: [], reason: "default-pinned" },
      );

      const run = (env: EnvLookup) =>
        refreshAutomaticProviderRouting({
          workDir: GEMINI_WORK_DIR,
          enabledProviderIds: providers,
          now: NOW,
          readTextFile: async () =>
            JSON.stringify({
              agent_provider: "claude",
              agent_providers: providers,
            }),
          env,
          resolveStatus: (id) => available(id, 50, 5),
          log: () => {},
        });
      const login = await run(geminiEnv({ GEMINI_CLI_HOME: home }));
      assertEquals(login.automatic, true);
      const apiKey = await run(geminiEnv({ GEMINI_API_KEY: "metered-key" }));
      assertEquals(apiKey.automatic, false);
    });
  });
});

Deno.test("a metered Codex does not count toward the default, an unknown one does (Issue #5344)", () => {
  const providers = ["claude", "codex"];
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProviders: providers,
      billingContext: {
        workDir: GEMINI_WORK_DIR,
        env: statedEnv({ OPENAI_API_KEY: "metered-key" }),
      },
    }).reason,
    "default-pinned",
  );
  assertEquals(
    resolveAutomaticProviderConfig({
      configuredProviders: providers,
      billingContext: { workDir: GEMINI_WORK_DIR, env: statedEnv() },
    }).reason,
    "default-auto",
  );
});

Deno.test("the preferred provider always counts toward the default (Issue #5344)", () => {
  const resolve = (
    configuredProvider: string | undefined,
    providers: string[],
    env: EnvLookup,
  ) =>
    resolveAutomaticProviderConfig({
      configuredProvider,
      configuredProviders: providers,
      billingContext: { workDir: GEMINI_WORK_DIR, env },
    });
  // Metered preferred Claude still counts, so a Codex subscription keeps auto.
  assertEquals(
    resolve(
      "claude",
      ["claude", "codex"],
      statedEnv({ ANTHROPIC_API_KEY: "metered-key" }),
    ),
    { mode: "auto", preference: [], reason: "default-auto" },
  );
  // A metered Gemini counts when it is the configured preferred provider.
  assertEquals(
    resolve(
      "gemini",
      ["claude", "gemini"],
      geminiEnv({ GEMINI_API_KEY: "k" }),
    ).mode,
    "auto",
  );
  // With no configured provider the default (claude) is preferred, so a
  // metered Gemini is dropped and the host stays pinned.
  assertEquals(
    resolve(
      undefined,
      ["claude", "gemini"],
      geminiEnv({ GEMINI_API_KEY: "k" }),
    ),
    { mode: "pinned", preference: [], reason: "default-pinned" },
  );
});

Deno.test("Gemini without a usable login is unknown billing (Issue #5344)", async () => {
  await withProviderState(async () => {
    const missing = await resolveAutomaticProviderStatus("gemini", {
      workDir: GEMINI_WORK_DIR,
      env: geminiEnv(),
      now: NOW,
    });
    assertEquals(missing.availability, "unavailable");
    assertEquals(missing.billingMode, "unknown");
    assertEquals(missing.reason, "subscription-credential-missing");

    await withGeminiLogin(async (home) => {
      const broken = await resolveAutomaticProviderStatus("gemini", {
        workDir: GEMINI_WORK_DIR,
        env: geminiEnv({ GEMINI_CLI_HOME: home }),
        now: NOW,
      });
      assertEquals(broken.availability, "unavailable");
      assertEquals(broken.billingMode, "unknown");
      assertStringIncludes(broken.reason ?? "", "gemini-login-unreadable (");
    }, "not json");
  });
});

Deno.test("Gemini status makes no network call or probe (Issue #5344)", async () => {
  await withProviderState(async () => {
    await withGeminiLogin(async (home) => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (() => {
        calls++;
        throw new Error("network forbidden");
      }) as typeof fetch;
      try {
        const envs = [
          geminiEnv({ GEMINI_CLI_HOME: home }),
          geminiEnv({ GEMINI_API_KEY: "metered-key" }),
          geminiEnv(),
        ];
        const statuses = [];
        for (const env of envs) {
          statuses.push(
            await resolveAutomaticProviderStatus("gemini", {
              workDir: GEMINI_WORK_DIR,
              env,
              now: NOW,
            }),
          );
        }
        assertEquals(calls, 0);
        assertEquals(statuses[0]?.availability, "available");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
