import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  IMAGE_AGENT_PROVIDERS_ENV,
  setConfiguredAgentProviderId,
} from "../lib/agent_provider.ts";
import { chooseBabysitterProvider } from "../lib/babysitter_provider_choice.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import type { ProviderSubscriptionStatus } from "../lib/provider_quota.ts";
import { resetAutomaticProviderState } from "../lib/provider_auto_state.ts";
import { envFrom } from "./support/env_lookup.ts";

const NOW = 10_000_000;
const CONFIG = {
  agent_provider_mode: "auto",
  agent_provider: "claude",
  agent_providers: ["claude", "codex"],
};

function status(
  provider: string,
  remainingPercent: number,
  availability: "available" | "exhausted" = "available",
): ProviderSubscriptionStatus {
  return {
    provider,
    credentialLabel: `${provider}-account`,
    billingMode: "fixed-subscription",
    availability,
    windows: [{ id: "month", remainingPercent, resetsAt: NOW + 3600_000 }],
    observedAt: NOW,
    confidence: "authoritative",
  };
}

function testEnv(values: Record<string, string> = {}): EnvLookup {
  return envFrom({
    [IMAGE_AGENT_PROVIDERS_ENV]: "claude,codex,deepseek",
    ...values,
  });
}

function baseDeps(options: {
  config?: Record<string, unknown>;
  env?: EnvLookup;
  statuses?: Record<string, ProviderSubscriptionStatus>;
  credential?: boolean;
} = {}) {
  const logs: string[] = [];
  const readPaths: string[] = [];
  let statusCalls = 0;
  let credentialCalls = 0;
  const runtimeEnv: Record<string, string> = {
    PATH: "/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-dummy-secret",
    CODEX_API_KEY: "codex-dummy-secret",
  };
  const config = options.config ?? CONFIG;
  const deps = {
    workDir: "/work",
    enabledProviderIds: ["claude", "codex"],
    env: options.env ?? testEnv({ CONFIG_PATH: "/mounted/.config.json" }),
    now: NOW,
    readTextFile: async (path: string) => {
      readPaths.push(path);
      return JSON.stringify(config);
    },
    resolveStatus: (providerId: string) => {
      statusCalls++;
      const found = options.statuses?.[providerId];
      if (found) return found;
      return status(providerId, 0, "exhausted");
    },
    exportDeepSeekCredential: async (
      setEnv: (name: string, value: string) => void,
    ) => {
      credentialCalls++;
      if (options.credential === false) return [];
      setEnv("DEEPSEEK_API_KEY", "deepseek-dummy-secret");
      return ["DEEPSEEK_API_KEY"];
    },
    readEnvironment: () => ({ ...runtimeEnv }),
    log: (line: string) => logs.push(line),
  };
  return {
    deps,
    logs,
    readPaths,
    calls: () => ({ statusCalls, credentialCalls }),
    runtimeEnv,
  };
}

async function withProviderState(fn: () => Promise<void>): Promise<void> {
  try {
    resetAutomaticProviderState();
    setConfiguredAgentProviderId("claude");
    await fn();
  } finally {
    resetAutomaticProviderState();
    setConfiguredAgentProviderId("claude");
  }
}

Deno.test("babysitter auto mode chooses a subscription with quota and logs runtime selection", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      statuses: {
        claude: status("claude", 40),
        codex: status("codex", 0, "exhausted"),
      },
    });
    const result = await chooseBabysitterProvider(fixture.deps);

    assertEquals(result.providerId, "claude");
    assertEquals(result.overflow, false);
    assertEquals(result.env, fixture.runtimeEnv);
    assertEquals(fixture.readPaths, ["/mounted/.config.json"]);
    assert(
      fixture.logs.some((line) =>
        line.startsWith("[quota] automatic provider selected=")
      ),
    );
    assertEquals(fixture.calls().credentialCalls, 0);
  });
});

Deno.test("babysitter auto mode ranks subscriptions by remaining quota", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      statuses: { claude: status("claude", 12), codex: status("codex", 73) },
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.overflow, false);
    assertEquals(fixture.calls().credentialCalls, 0);
  });
});

Deno.test("babysitter auto mode uses isolated DeepSeek env only after all subscriptions exhaust", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    const result = await chooseBabysitterProvider(fixture.deps);

    assertEquals(result.providerId, "deepseek");
    assertEquals(result.overflow, true);
    assertEquals(result.env["ANTHROPIC_AUTH_TOKEN"], "deepseek-dummy-secret");
    assertEquals(
      result.env["ANTHROPIC_BASE_URL"],
      "https://api.deepseek.com/anthropic",
    );
    assertEquals(result.env["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
    assertEquals(result.env["CODEX_API_KEY"], undefined);
    assert(
      fixture.logs.some((line) =>
        line ===
          "[quota] babysitter paid overflow selected=deepseek reason=claude/claude-account:exhausted,codex/codex-account:exhausted"
      ),
    );
    assertEquals(
      fixture.logs.some((line) => line.includes("dummy-secret")),
      false,
    );
  });
});

Deno.test("restored subscription quota keeps babysitter off DeepSeek", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      statuses: {
        claude: status("claude", 0, "exhausted"),
        codex: status("codex", 1),
      },
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.overflow, false);
    assertEquals(fixture.calls().credentialCalls, 0);
    assertEquals(
      fixture.logs.some((line) => line.includes("babysitter paid overflow")),
      false,
    );
  });
});

Deno.test("exhausted subscriptions without a DeepSeek credential fail with the cause", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({ credential: false });
    const error = await assertRejects(
      () => chooseBabysitterProvider(fixture.deps),
      Error,
      "no subscription has budget and no DeepSeek credential is configured",
    );
    assertEquals(
      error.message,
      "no subscription has budget and no DeepSeek credential is configured",
    );
  });
});

Deno.test("DeepSeek credential export errors retain the original cause", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    const cause = new Error("credential store is unreadable");
    fixture.deps.exportDeepSeekCredential = async () => {
      throw cause;
    };
    try {
      await chooseBabysitterProvider(fixture.deps);
      assert(false, "expected credential export to fail");
    } catch (error) {
      assertEquals(error, cause);
    }
  });
});

Deno.test("missing optional config keeps the default provider pinned", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    fixture.deps.readTextFile = async () => {
      throw new Deno.errors.NotFound("config absent");
    };
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "claude");
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("invalid babysitter config shape fails with the config path", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    fixture.deps.readTextFile = async () => "[]";
    await assertRejects(
      () => chooseBabysitterProvider(fixture.deps),
      Error,
      "babysitter provider config /mounted/.config.json must contain a JSON object",
    );
  });
});

Deno.test("configured pinned mode returns the configured provider without probing or overflow", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      config: { agent_provider: "codex", agent_providers: ["claude", "codex"] },
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.overflow, false);
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("VIBE_AGENT_PROVIDER pin wins in auto mode without probing or overflow", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      env: testEnv({
        CONFIG_PATH: "/mounted/.config.json",
        VIBE_AGENT_PROVIDER: "codex",
      }),
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.overflow, false);
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("babysitter chooser preserves config read errors as their cause", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    const cause = new Error("config disk unavailable");
    fixture.deps.readTextFile = async () => {
      throw cause;
    };
    try {
      await chooseBabysitterProvider(fixture.deps);
      assert(false, "expected config read to fail");
    } catch (error) {
      assertEquals((error as Error).cause, cause);
      assertEquals(
        ((error as Error).cause as Error).message,
        "config disk unavailable",
      );
    }
  });
});
