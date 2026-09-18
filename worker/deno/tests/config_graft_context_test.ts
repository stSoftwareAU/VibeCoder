/**
 * `.config.json` → `WorkerConfig.graftContext` wiring (Issue #2098, part of
 * #2060).
 *
 * The switch ships **off**: a host that never writes the block must behave
 * exactly as it does today, and a malformed block must stop the worker at
 * config load rather than reading as off.
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  assertGraftContextConfig,
  GRAFT_DEEP_DEFAULT_API_KEY_ENV,
  GRAFT_DEEP_DEFAULT_TIMEOUT_SECONDS,
  GRAFT_DEEP_PROVIDERS,
  graftContextOff,
  graftDeepConfig,
  isGraftContextEnabled,
  parseGraftContextConfig,
} from "../lib/graft_context_config.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";

async function withConfig(
  body: (
    path: string,
    write: (json: unknown) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-config-graft-" });
  const path = `${dir}/.config.json`;
  try {
    await body(
      path,
      (json) => Deno.writeTextFile(path, JSON.stringify(json, null, 2)),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Run `body` with console warning sinks captured, returning what they saw. */
async function captureWarnings(
  body: () => Promise<void>,
): Promise<string[]> {
  const captured: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => captured.push(args.join(" "));
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    await body();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  return captured;
}

// --- loadConfig wiring ---

Deno.test("config graft_context - an absent block loads as disabled with no warning", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"] });
    let enabled: boolean | undefined;
    const warnings = await captureWarnings(async () => {
      enabled = (await loadConfig(path)).graftContext.enabled;
    });
    assertEquals(enabled, false);
    assertEquals(
      warnings.filter((line) => line.includes("graft_context")),
      [],
    );
  });
});

Deno.test("config graft_context - `{ enabled: true }` loads as enabled", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], graft_context: { enabled: true } });
    const config = await loadConfig(path);
    assertEquals(config.graftContext.enabled, true);
  });
});

Deno.test("config graft_context - `{ enabled: false }` loads as disabled", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], graft_context: { enabled: false } });
    const config = await loadConfig(path);
    assertEquals(config.graftContext.enabled, false);
  });
});

Deno.test("config graft_context - a non-boolean `enabled` fails the config load", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], graft_context: { enabled: "yes" } });
    const error = await assertRejects(() => loadConfig(path), Error);
    assert(error.message.includes("graft_context.enabled"), error.message);
    assert(error.message.includes("boolean"), error.message);
  });
});

Deno.test("config graft_context - a non-object block fails the config load", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], graft_context: true });
    const error = await assertRejects(() => loadConfig(path), Error);
    assert(error.message.includes("graft_context"), error.message);
  });
});

Deno.test("config graft_context - an unknown key inside the block warns and is ignored", async () => {
  await withConfig(async (path, write) => {
    await write({
      repos: ["org/repo"],
      graft_context: { enabledd: true },
    });
    let enabled: boolean | undefined;
    const warnings = await captureWarnings(async () => {
      enabled = (await loadConfig(path)).graftContext.enabled;
    });
    assertEquals(enabled, false);
    const relevant = warnings.filter((line) =>
      line.includes("graft_context.enabledd")
    );
    assertEquals(relevant.length, 1, warnings.join("\n"));
    assert(relevant[0]?.includes("graft_context.enabled"), relevant[0]);
  });
});

Deno.test("config graft_context - `graft_context` is a recognised top-level key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("graft_context"), true);
  assertEquals(
    detectUnknownConfigKeys({ graft_context: { enabled: true } }),
    [],
  );
});

// --- parseGraftContextConfig / assertGraftContextConfig ---

Deno.test("graft_context_config - absent and null both yield the off default", () => {
  for (const raw of [undefined, null]) {
    const parsed = parseGraftContextConfig(raw);
    assert(parsed.ok);
    assertEquals(parsed.value, graftContextOff());
  }
});

Deno.test("graft_context_config - an empty block yields the off default", () => {
  const parsed = parseGraftContextConfig({});
  assert(parsed.ok);
  assertEquals(parsed.value.enabled, false);
});

Deno.test("graft_context_config - an array block is rejected, naming the key", () => {
  const parsed = parseGraftContextConfig([]);
  assert(!parsed.ok);
  assert(parsed.error.includes("graft_context"), parsed.error);
});

Deno.test("graft_context_config - a null `enabled` is rejected, naming the key", () => {
  const parsed = parseGraftContextConfig({ enabled: null });
  assert(!parsed.ok);
  assert(parsed.error.includes("graft_context.enabled"), parsed.error);
});

Deno.test("graft_context_config - unknown nested keys warn through the supplied sink", () => {
  const warnings: string[] = [];
  const parsed = parseGraftContextConfig(
    { enabled: true, graftEnabled: 1 },
    { warn: (message) => warnings.push(message) },
  );
  assert(parsed.ok);
  assertEquals(parsed.value.enabled, true);
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assert(warnings[0]?.includes("graft_context.graftEnabled"), warnings[0]);
});

Deno.test("graft_context_config - the off default is a fresh object each call", () => {
  const first = graftContextOff();
  first.enabled = true;
  assertEquals(graftContextOff().enabled, false);
});

Deno.test("graft_context_config - assertGraftContextConfig throws on a fault", () => {
  assertEquals(assertGraftContextConfig({ enabled: true }).enabled, true);
  let thrown: Error | undefined;
  try {
    assertGraftContextConfig({ enabled: 1 });
  } catch (error) {
    thrown = error as Error;
  }
  assert(thrown, "expected assertGraftContextConfig to throw");
  assert(thrown.message.includes("graft_context.enabled"), thrown.message);
});

// --- isGraftContextEnabled ---

Deno.test("graft_context_config - isGraftContextEnabled reads the loaded switch", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], graft_context: { enabled: true } });
    assertEquals(isGraftContextEnabled(await loadConfig(path)), true);
  });
});

Deno.test("graft_context_config - isGraftContextEnabled is false on the default config", () => {
  assertEquals(isGraftContextEnabled(buildDefaultWorkerConfig()), false);
});

// ---------------------------------------------------------------------------
// The summary pass — `graft_context.deep` (Issue #2315)
// ---------------------------------------------------------------------------

Deno.test("config graft_context.deep - a provider alone loads with that provider's defaults", async () => {
  await withConfig(async (path, write) => {
    await write({
      repos: ["org/repo"],
      graft_context: { enabled: true, deep: { provider: "anthropic" } },
    });
    const config = await loadConfig(path);
    assertEquals(config.graftContext.deep, {
      provider: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      timeoutSeconds: GRAFT_DEEP_DEFAULT_TIMEOUT_SECONDS,
    });
    assertEquals(graftDeepConfig(config)?.provider, "anthropic");
  });
});

Deno.test("config graft_context.deep - every optional key is carried through", () => {
  const parsed = parseGraftContextConfig({
    enabled: true,
    deep: {
      provider: "openai",
      model: "openai/gpt-4o-mini",
      base_url: "https://openrouter.ai/api/v1",
      api_key_env: "OPENROUTER_API_KEY",
      timeout_seconds: 600,
      concurrency: 3,
    },
  }, { warn: () => {} });
  assert(parsed.ok, parsed.ok ? "" : parsed.error);
  assertEquals(parsed.value.deep, {
    provider: "openai",
    model: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    timeoutSeconds: 600,
    concurrency: 3,
  });
});

Deno.test("config graft_context.deep - each provider has a default key variable", () => {
  for (const provider of GRAFT_DEEP_PROVIDERS) {
    const parsed = parseGraftContextConfig({ deep: { provider } }, {
      warn: () => {},
    });
    assert(parsed.ok);
    assertEquals(
      parsed.value.deep?.apiKeyEnv,
      GRAFT_DEEP_DEFAULT_API_KEY_ENV[provider],
    );
  }
});

Deno.test("config graft_context.deep - a missing or unknown provider fails naming the key", () => {
  for (const deep of [{}, { provider: "gemini" }, { provider: 3 }]) {
    const parsed = parseGraftContextConfig({ enabled: true, deep }, {
      warn: () => {},
    });
    assert(!parsed.ok, "must be rejected");
    assert(
      parsed.error.includes("graft_context.deep.provider") &&
        parsed.error.includes("anthropic, openai, litellm, orcarouter"),
      parsed.error,
    );
  }
});

Deno.test("config graft_context.deep - a key pasted where a name belongs stops the worker", () => {
  const parsed = parseGraftContextConfig({
    deep: {
      provider: "anthropic",
      api_key_env: "sk-ant-not-a-name-0123456789",
    },
  }, { warn: () => {} });
  assert(!parsed.ok);
  assert(parsed.error.includes("graft_context.deep.api_key_env"), parsed.error);
  assert(
    !parsed.error.includes("sk-ant-"),
    "the rejected value must not be echoed back",
  );
});

Deno.test("config graft_context.deep - limits must be positive whole numbers", () => {
  for (
    const [key, value] of [
      ["timeout_seconds", 0],
      ["timeout_seconds", "30"],
      ["concurrency", 1.5],
      ["concurrency", -2],
    ] as const
  ) {
    const parsed = parseGraftContextConfig({
      deep: { provider: "anthropic", [key]: value },
    }, { warn: () => {} });
    assert(!parsed.ok, `${key}=${String(value)} must be rejected`);
    assert(parsed.error.includes(`graft_context.deep.${key}`), parsed.error);
  }
});

Deno.test("config graft_context.deep - a non-object block fails and an unknown key warns", () => {
  const rejected = parseGraftContextConfig({ deep: "yes" }, { warn: () => {} });
  assert(!rejected.ok);
  assert(rejected.error.includes("graft_context.deep"), rejected.error);

  const warnings: string[] = [];
  const parsed = parseGraftContextConfig({
    deep: { provider: "anthropic", modle: "x" },
  }, { warn: (m) => warnings.push(m) });
  assert(parsed.ok);
  assertEquals(parsed.value.deep?.model, undefined);
  assert(
    warnings.some((w) => w.includes("graft_context.deep.modle")),
    warnings.join("\n"),
  );
});

Deno.test("config graft_context.deep - the pass is not read while the switch is off", () => {
  const config = buildDefaultWorkerConfig();
  config.graftContext = {
    enabled: false,
    deep: {
      provider: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      timeoutSeconds: 10,
    },
  };
  assertEquals(graftDeepConfig(config), undefined);
  config.graftContext.enabled = true;
  assertEquals(graftDeepConfig(config)?.provider, "anthropic");
});
