import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  IMAGE_AGENT_PROVIDERS_ENV,
  setConfiguredAgentProviderId,
} from "../lib/agent_provider.ts";
import { chooseBabysitterProvider } from "../lib/babysitter_provider_choice.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import type { ProviderSubscriptionStatus } from "../lib/provider_quota.ts";
import type { AutomaticProviderStatusResolver } from "../lib/provider_auto_runtime.ts";
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
    resolveStatus: (
      providerId: string,
      _context: Parameters<AutomaticProviderStatusResolver>[1],
    ) => {
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

Deno.test("missing optional config still honours the environment provider pin", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      env: testEnv({
        CONFIG_PATH: "/mounted/.config.json",
        VIBE_AGENT_PROVIDER: "codex",
      }),
    });
    fixture.deps.readTextFile = async () => {
      throw new Deno.errors.NotFound("config absent");
    };
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("invalid babysitter config shape fails with the config path", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps();
    for (const text of ["[]", "null", '"auto"', "1", "true"]) {
      fixture.deps.readTextFile = async () => text;
      await assertRejects(
        () => chooseBabysitterProvider(fixture.deps),
        Error,
        "babysitter provider config /mounted/.config.json must contain a JSON object",
      );
    }
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

Deno.test("existing provider-less config honours the environment pin without probing or overflow", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      config: {},
      env: testEnv({ VIBE_AGENT_PROVIDER: "codex" }),
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.overflow, false);
    assertEquals(result.env, fixture.runtimeEnv);
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("malformed babysitter config retains the syntax error cause", async () => {
  const fixture = baseDeps();
  fixture.deps.readTextFile = async () => "{malformed";
  const error = await assertRejects(
    () => chooseBabysitterProvider(fixture.deps),
    Error,
    "cannot parse babysitter provider config /mounted/.config.json",
  );
  assert(error.cause instanceof SyntaxError);
});

Deno.test("provider list leaves pinned selection to the environment", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      config: { agent_providers: ["claude", "codex"] },
      env: testEnv({ VIBE_AGENT_PROVIDER: "codex" }),
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.env, fixture.runtimeEnv);
    assertEquals(result.overflow, false);
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("provider list order does not override the default pin", async () => {
  const fixture = baseDeps({
    config: { agent_providers: ["codex", "claude"] },
  });
  const result = await chooseBabysitterProvider(fixture.deps);
  assertEquals(result.providerId, "claude");
  assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
});

Deno.test("auto mode rejects an environment pin outside the enabled set", async () => {
  const fixture = baseDeps({
    env: testEnv({ VIBE_AGENT_PROVIDER: "deepseek" }),
  });
  await assertRejects(
    () => chooseBabysitterProvider(fixture.deps),
    Error,
    'VIBE_AGENT_PROVIDER pin "deepseek" is not in the enabled agent_providers set',
  );
  assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
});

Deno.test("configured single-provider pin takes precedence over an environment pin", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({
      config: { agent_provider: "codex" },
      env: testEnv({ VIBE_AGENT_PROVIDER: "claude" }),
    });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(result.env, fixture.runtimeEnv);
    assertEquals(fixture.calls(), { statusCalls: 0, credentialCalls: 0 });
  });
});

Deno.test("automatic status resolution receives the babysitter work directory and environment", async () => {
  await withProviderState(async () => {
    const fixture = baseDeps({ config: { agent_provider_mode: "auto" } });
    const contexts: unknown[] = [];
    fixture.deps.resolveStatus = (providerId, context) => {
      contexts.push({
        providerId,
        workDir: context.workDir,
        marker: context.env("BABYSITTER_TEST_CONTEXT"),
        now: context.now,
      });
      return status(providerId, providerId === "codex" ? 70 : 10);
    };
    fixture.deps.env = testEnv({ BABYSITTER_TEST_CONTEXT: "repair-context" });
    const result = await chooseBabysitterProvider(fixture.deps);
    assertEquals(result.providerId, "codex");
    assertEquals(contexts, [
      {
        providerId: "claude",
        workDir: "/work",
        marker: "repair-context",
        now: NOW,
      },
      {
        providerId: "codex",
        workDir: "/work",
        marker: "repair-context",
        now: NOW,
      },
    ]);
  });
});

Deno.test("default DeepSeek export reads only its provider credential and isolates the child environment", async () => {
  const dir = await Deno.makeTempDir({ prefix: "babysitter_credentials_" });
  try {
    await Deno.mkdir(`${dir}/deepseek`);
    await Deno.mkdir(`${dir}/claude`);
    await Deno.writeTextFile(
      `${dir}/deepseek/provider.env`,
      "DEEPSEEK_API_KEY=deepseek-fixture\n",
    );
    await Deno.writeTextFile(
      `${dir}/claude/provider.env`,
      "ANTHROPIC_API_KEY=claude-fixture\n",
    );
    const moduleUrl =
      new URL("../lib/babysitter_provider_choice.ts", import.meta.url).href;
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `
        import { chooseBabysitterProvider } from ${JSON.stringify(moduleUrl)};
        const result = await chooseBabysitterProvider({
          workDir: ${JSON.stringify(dir)},
          enabledProviderIds: ["claude"],
          readTextFile: async () => JSON.stringify({agent_provider_mode: "auto", agent_providers: ["claude"]}),
          resolveStatus: (provider) => ({provider, credentialLabel: "exhausted", billingMode: "fixed-subscription", availability: "exhausted", windows: [], observedAt: 0, confidence: "authoritative"}),
          readEnvironment: () => ({PATH: "/fixture-bin"}),
          log: () => {},
        });
        console.log(JSON.stringify({result, leaked: Deno.env.get("DEEPSEEK_API_KEY") ?? null}));
      `,
      ],
      env: {
        VIBE_CREDENTIAL_DIR: dir,
        VIBE_IMAGE_AGENT_PROVIDERS: "claude,codex,deepseek",
      },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
      result: {
        providerId: "deepseek",
        overflow: true,
        env: {
          PATH: "/fixture-bin",
          VIBE_AUDIT_DISABLED: "1",
          DEEPSEEK_API_KEY: "deepseek-fixture",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: "deepseek-fixture",
          BASH_MAX_TIMEOUT_MS: "1800000",
        },
      },
      leaked: null,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
