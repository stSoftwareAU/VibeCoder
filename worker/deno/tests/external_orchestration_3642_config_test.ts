/**
 * Host config for the external orchestration switch (Issue #3642).
 *
 * `external_orchestration` defaults off and is host-only. Its settings object
 * is validated at load: unknown keys, bad providers, bad efforts and
 * non-positive bounds fail the load rather than being silently dropped.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** The minimum a config file must carry to load at all. */
function minimalConfig(extra: ConfigFile = {}): ConfigFile {
  return {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    ...extra,
  };
}

/** Run `fn` with `console.error` captured, returning what it wrote. */
async function capturingConfigErrors(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = originalError;
  }
  return lines;
}

Deno.test("external orchestration config - the switch defaults off with no settings (Issue #3642)", () => {
  const defaults = buildDefaultWorkerConfig();
  assertEquals(defaults.externalOrchestration, false);
  assertEquals(defaults.externalOrchestrationSettings, {});
});

Deno.test("external orchestration config - an absent switch loads as off with no warning (Issue #3642)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const errors = await capturingConfigErrors(async () => {
      const config = await loadConfig(configPath);
      assertEquals(config.externalOrchestration, false);
      assertEquals(config.externalOrchestrationSettings, {});
    });
    assertEquals(errors, [], "the absent keys must not warn");
  });
});

Deno.test("external orchestration config - external_orchestration true loads as on (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({ external_orchestration: true }),
    async (configPath) => {
      const errors = await capturingConfigErrors(async () => {
        const config = await loadConfig(configPath);
        assertEquals(config.externalOrchestration, true);
      });
      assertEquals(errors, [], "a recognised key must not warn");
    },
  );
});

Deno.test("external orchestration config - a non-boolean switch fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration: "yes" as unknown as boolean,
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(error.message, "external_orchestration");
    },
  );
});

Deno.test("external orchestration config - a full settings object loads with camelCase fields (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration: true,
      external_orchestration_settings: {
        manager: { provider: "claude", model: "opus", effort: "high" },
        executor: { provider: "codex", model: "gpt-5", effort: "low" },
        max_retries: 2,
        max_concurrency: 1,
        max_invocations: 8,
        max_cost_usd: 5.5,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.externalOrchestrationSettings, {
        manager: { provider: "claude", model: "opus", effort: "high" },
        executor: { provider: "codex", model: "gpt-5", effort: "low" },
        maxRetries: 2,
        maxConcurrency: 1,
        maxInvocations: 8,
        maxCostUsd: 5.5,
      });
    },
  );
});

Deno.test("external orchestration config - an unknown settings key fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: { max_turns: 3 },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(error.message, "max_turns");
    },
  );
});

Deno.test("external orchestration config - an unknown role key fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: {
        manager: { provider: "claude", colour: "red" },
      },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(error.message, "colour");
    },
  );
});

Deno.test("external orchestration config - a provider outside the four fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: { executor: { provider: "openai" } },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(
        error.message,
        "external_orchestration_settings.executor.provider",
      );
    },
  );
});

Deno.test("external orchestration config - an effort outside low, medium and high fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: {
        manager: { effort: "xhigh" },
      },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(
        error.message,
        "external_orchestration_settings.manager.effort",
      );
    },
  );
});

Deno.test("external orchestration config - a zero cost cap fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: { max_cost_usd: 0 },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(error.message, "max_cost_usd");
    },
  );
});

Deno.test("external orchestration config - a zero invocation cap fails the load (Issue #3642)", async () => {
  await withTempConfig(
    minimalConfig({
      external_orchestration_settings: { max_invocations: 0 },
    }),
    async (configPath) => {
      const error = await assertRejects(
        () => loadConfig(configPath),
        Error,
      );
      assertStringIncludes(error.message, "max_invocations");
    },
  );
});
