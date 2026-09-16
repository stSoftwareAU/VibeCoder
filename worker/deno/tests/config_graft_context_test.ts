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
  graftContextOff,
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
