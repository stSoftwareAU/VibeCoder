/**
 * Config and wiring for the call-storm stall guard (Issue #2230).
 *
 * The guard is on by default, so the values an operator gets without writing
 * anything are the values that stop runs — and the ones that would stop every
 * run are refused loudly at load time rather than silently accepted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";
import {
  buildCallStormPolicy,
  buildProgressExtension,
} from "../lib/progress_extension_runtime.ts";
import type { ConfigFile } from "../types.ts";

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

Deno.test("call storm config - an empty config resolves the shipped guard (Issue #2230)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(
      config.callStormEnabled,
      true,
      "a worker with no call_storm_* keys must still stop a polling loop",
    );
    assertEquals(config.callStormCalls, 60);
    assertEquals(config.callStormWindowSeconds, 300);
    assertEquals(
      config.callStormWindowSeconds,
      config.progressExtensionCheckSeconds,
      "the window judged must be the window observed",
    );
  });
});

Deno.test("call storm config - explicit tunables are read (Issue #2230)", async () => {
  await withTempConfig(
    minimalConfig({
      call_storm_calls: 120,
      call_storm_window_seconds: 120,
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.callStormCalls, 120);
      assertEquals(config.callStormWindowSeconds, 120);
      assertEquals(
        detectUnknownConfigKeys({
          call_storm_enabled: true,
          call_storm_calls: 120,
          call_storm_window_seconds: 120,
        }),
        [],
        "the keys must be recognised, not warned about as typos",
      );
    },
  );
});

Deno.test("call storm config - a threshold that would stop every run is refused (Issue #2230)", async () => {
  await withTempConfig(
    minimalConfig({ call_storm_calls: 0 }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assert(
        error.message.includes("call_storm_calls must be positive"),
        `the refusal must name the key: ${error.message}`,
      );
      assert(
        error.message.includes("call_storm_enabled: false"),
        `the refusal must name the way to turn it off: ${error.message}`,
      );
    },
  );
});

Deno.test("call storm config - a window with no rate to measure is refused (Issue #2230)", async () => {
  await withTempConfig(
    minimalConfig({ call_storm_window_seconds: 0 }),
    async (configPath) => {
      const error = await assertRejects(() => loadConfig(configPath), Error);
      assert(
        error.message.includes("call_storm_window_seconds must be positive"),
        `the refusal must name the key: ${error.message}`,
      );
    },
  );
});

Deno.test("call storm config - the guard reaches the runner option (Issue #2230)", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await withTempConfig(minimalConfig(), async (configPath) => {
      const config = await loadConfig(configPath);
      const option = await buildProgressExtension(config, repoDir);
      assert(option, "progress extension is on by default");
      assertEquals(option?.callStorm, {
        enabled: true,
        windowSeconds: 300,
        callThreshold: 60,
      });
    });
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("call storm config - switching the guard off leaves the extension alone (Issue #2230)", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await withTempConfig(
      minimalConfig({ call_storm_enabled: false }),
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(buildCallStormPolicy(config), undefined);
        const option = await buildProgressExtension(config, repoDir);
        assert(option, "the extension itself must be untouched");
        assertEquals(
          option?.callStorm,
          undefined,
          "an operator who switched the guard off keeps the whole budget",
        );
      },
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("buildCallStormPolicy - a hand-built config with nonsense tunables guards nothing", () => {
  // loadConfig refuses these, so reaching the builder with them means a
  // caller assembled the config itself. Refuse to guard rather than stop
  // every run that reaches a check.
  assertEquals(
    buildCallStormPolicy({ callStormEnabled: true, callStormCalls: 0 }),
    undefined,
  );
  assertEquals(
    buildCallStormPolicy({
      callStormEnabled: true,
      callStormCalls: 60,
      callStormWindowSeconds: 0,
    }),
    undefined,
  );
  assertEquals(
    buildCallStormPolicy({
      callStormEnabled: true,
      callStormCalls: 60,
      callStormWindowSeconds: 300,
    }),
    { enabled: true, windowSeconds: 300, callThreshold: 60 },
  );
});
