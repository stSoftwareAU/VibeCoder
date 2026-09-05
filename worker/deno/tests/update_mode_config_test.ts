/**
 * Tests for the update-mode configuration schema (Issue #622, part of #583).
 *
 * The update mode decides whether a host tracks the latest Vibe Coder
 * (`dynamic`) or is held at a pinned checkout and pinned tool versions
 * (`frozen`). These tests cover loading, the `dynamic` default, the fail-loud
 * validation of a hand-edited pin, and the shell export `run.sh` reads.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { loadConfigCommand } from "../commands/load_config.ts";
import {
  buildDefaultWorkerConfig,
  DEFAULT_UPDATE_MODE,
  PINNED_TOOLS,
  SETUP_DEFAULT_UPDATE_MODE,
  UPDATE_MODES,
} from "../lib/config_defaults.ts";
import {
  validateConfigFull,
  validateUpdateModeSettings,
} from "../lib/config_validator.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";

/** Write an arbitrary (possibly invalid) config object to a temp file. */
async function withTempConfig(
  config: Record<string, unknown>,
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

/** A complete, valid frozen configuration. */
function frozenConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    update_mode: "frozen",
    pinned_ref: "3f2a1b9c4d5e6f708192a3b4c5d6e7f809a1b2c3",
    pinned_tool_versions: {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Loading and the dynamic default
// ---------------------------------------------------------------------------

Deno.test("update mode - absent keys resolve to dynamic with no pins", async () => {
  await withTempConfig(
    { allowed_authors: ["testuser"], repos: ["org/repo"] },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.updateMode, "dynamic");
      assertEquals(config.pinnedRef, undefined);
      assertEquals(config.pinnedToolVersions, undefined);
    },
  );
});

Deno.test("update mode - the default is dynamic in the default WorkerConfig", () => {
  assertEquals(DEFAULT_UPDATE_MODE, "dynamic");
  assertEquals(buildDefaultWorkerConfig().updateMode, "dynamic");
  assertEquals([...UPDATE_MODES], ["dynamic", "frozen"]);
});

Deno.test("update mode - the setup default is frozen while an absent key still loads as dynamic", async () => {
  // Issue #692 flipped the setup conversation's default answer only. An
  // existing host carries no pins, so resolving an absent key to `frozen`
  // would fail its config validation at the next launch.
  assertEquals(SETUP_DEFAULT_UPDATE_MODE, "frozen");
  assertEquals(DEFAULT_UPDATE_MODE, "dynamic");

  // Issue #1066: a config validates only with a non-empty fleet login set.
  const config = {
    allowed_authors: ["testuser"],
    repos: ["org/repo"],
    service_accounts: ["vibe-worker"],
  };
  await withTempConfig(config, async (configPath) => {
    const loaded = await loadConfig(configPath);
    assertEquals(loaded.updateMode, DEFAULT_UPDATE_MODE);
    // No validation failure, and no new pin requirement.
    assertEquals(validateConfigFull(loaded).valid, true);
    assertEquals(validateUpdateModeSettings({ updateMode: undefined }), []);
  });
});

Deno.test("update mode - the update-mode keys are recognised, so no unknown-key warning is raised", () => {
  const warnings = detectUnknownConfigKeys(frozenConfig());
  assertEquals(
    warnings.map((w) => w.field),
    [],
    "update_mode / pinned_ref / pinned_tool_versions must be known keys",
  );
});

Deno.test("update mode - frozen with a ref and all three tool versions is exposed", async () => {
  await withTempConfig(frozenConfig(), async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.updateMode, "frozen");
    assertEquals(config.pinnedRef, "3f2a1b9c4d5e6f708192a3b4c5d6e7f809a1b2c3");
    assertEquals(config.pinnedToolVersions, {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    });
  });
});

Deno.test("update mode - a tag name is an acceptable pinned ref", async () => {
  await withTempConfig(
    frozenConfig({ pinned_ref: "release/v1.2.3" }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.pinnedRef, "release/v1.2.3");
    },
  );
});

Deno.test("update mode - dynamic ignores stale pin fields rather than rejecting them", async () => {
  await withTempConfig(
    frozenConfig({ update_mode: "dynamic" }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.updateMode, "dynamic");
      // The pins stay readable so a host can flip back to frozen by hand.
      assertEquals(
        config.pinnedRef,
        "3f2a1b9c4d5e6f708192a3b4c5d6e7f809a1b2c3",
      );
    },
  );
});

Deno.test("update mode - dynamic ignores a pin that would be rejected under frozen", async () => {
  await withTempConfig(
    {
      allowed_authors: ["testuser"],
      repos: ["org/repo"],
      update_mode: "dynamic",
      pinned_ref: "v1.0; rm -rf /",
      pinned_tool_versions: { claude: "" },
    },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.updateMode, "dynamic");
    },
  );
});

// ---------------------------------------------------------------------------
// Fail-loud validation at config load
// ---------------------------------------------------------------------------

async function assertLoadFails(
  config: Record<string, unknown>,
  ...expectedFragments: string[]
): Promise<void> {
  await withTempConfig(config, async (configPath) => {
    const error = await assertRejects(
      () => loadConfig(configPath),
      Error,
    );
    for (const fragment of expectedFragments) {
      assert(
        error.message.includes(fragment),
        `expected error to name ${
          JSON.stringify(fragment)
        }, got: ${error.message}`,
      );
    }
  });
}

Deno.test("update mode - an unrecognised mode fails loud naming the accepted values", async () => {
  await assertLoadFails(
    { allowed_authors: ["u"], repos: ["org/repo"], update_mode: "pinned" },
    "update_mode",
    "dynamic",
    "frozen",
  );
});

Deno.test("update mode - a non-string mode fails loud naming the field", async () => {
  await assertLoadFails(
    { allowed_authors: ["u"], repos: ["org/repo"], update_mode: 7 },
    "update_mode",
  );
});

Deno.test("update mode - frozen without a pinned ref fails loud", async () => {
  const config = frozenConfig();
  delete config.pinned_ref;
  await assertLoadFails(config, "pinned_ref");
});

Deno.test("update mode - frozen with a blank pinned ref fails loud", async () => {
  await assertLoadFails(frozenConfig({ pinned_ref: "   " }), "pinned_ref");
});

Deno.test("update mode - frozen with a missing tool version names the tool", async () => {
  await assertLoadFails(
    frozenConfig({ pinned_tool_versions: { claude: "2.0.76", deno: "2.5.4" } }),
    "pinned_tool_versions.gh",
  );
});

Deno.test("update mode - frozen with no pinned_tool_versions block names every tool", async () => {
  const config = frozenConfig();
  delete config.pinned_tool_versions;
  await assertLoadFails(
    config,
    "pinned_tool_versions.claude",
    "pinned_tool_versions.gh",
    "pinned_tool_versions.deno",
  );
});

Deno.test("update mode - frozen with a blank tool version names the tool", async () => {
  await assertLoadFails(
    frozenConfig({
      pinned_tool_versions: { claude: "2.0.76", gh: "", deno: "2.5.4" },
    }),
    "pinned_tool_versions.gh",
  );
});

Deno.test("update mode - a pinned ref carrying shell metacharacters fails loud", async () => {
  await assertLoadFails(
    frozenConfig({ pinned_ref: "v1.0.0; rm -rf /" }),
    "pinned_ref",
  );
});

Deno.test("update mode - a pinned ref carrying a command substitution fails loud", async () => {
  await assertLoadFails(
    frozenConfig({ pinned_ref: "$(id)" }),
    "pinned_ref",
  );
});

Deno.test("update mode - a tool version carrying whitespace fails loud", async () => {
  await assertLoadFails(
    frozenConfig({
      pinned_tool_versions: {
        claude: "2.0.76 beta",
        gh: "2.62.0",
        deno: "2.5.4",
      },
    }),
    "pinned_tool_versions.claude",
  );
});

Deno.test("update mode - a non-object pinned_tool_versions fails loud", async () => {
  await assertLoadFails(
    frozenConfig({ pinned_tool_versions: "claude=2.0.76" }),
    "pinned_tool_versions",
  );
});

Deno.test("update mode - a non-string tool version fails loud", async () => {
  await assertLoadFails(
    frozenConfig({
      pinned_tool_versions: { claude: 2.0, gh: "2.62.0", deno: "2.5.4" },
    }),
    "pinned_tool_versions.claude",
  );
});

// ---------------------------------------------------------------------------
// Validator unit tests
// ---------------------------------------------------------------------------

Deno.test("update mode - validateUpdateModeSettings accepts a complete frozen pin", () => {
  assertEquals(
    validateUpdateModeSettings({
      updateMode: "frozen",
      pinnedRef: "v1.2.3",
      pinnedToolVersions: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
    }),
    [],
  );
});

Deno.test("update mode - validateUpdateModeSettings accepts an absent mode", () => {
  assertEquals(validateUpdateModeSettings({}), []);
});

Deno.test("update mode - validateUpdateModeSettings reports every missing tool once", () => {
  const errors = validateUpdateModeSettings({
    updateMode: "frozen",
    pinnedRef: "v1.2.3",
  });
  assertEquals(errors.length, PINNED_TOOLS.length);
  for (const tool of PINNED_TOOLS) {
    assert(
      errors.some((e) => e.includes(`pinned_tool_versions.${tool}`)),
      `expected an error naming ${tool}, got: ${errors.join(" | ")}`,
    );
  }
});

Deno.test("update mode - validateConfigFull rejects a malformed mode on a loaded config", () => {
  const result = validateConfigFull(
    buildDefaultWorkerConfig({
      allowedAuthors: ["testuser"],
      repos: ["org/repo"],
      // A caller that built the config itself must still be caught.
      updateMode: "frozen",
    }),
  );
  assertEquals(result.valid, false);
  assert(
    result.errors.some((e) => e.includes("pinned_ref")),
    `expected a pinned_ref error, got: ${result.errors.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// Shell surface
// ---------------------------------------------------------------------------

Deno.test("load-config - exports VIBE_UPDATE_MODE as dynamic by default", async () => {
  await withTempConfig(
    { allowed_authors: ["testuser"], repos: ["org/repo"] },
    async (configPath) => {
      const result = await loadConfigCommand.execute(
        { "config-path": configPath },
        buildDefaultWorkerConfig(),
      );
      assert(
        result.message.includes(
          'export VIBE_UPDATE_MODE="${VIBE_UPDATE_MODE:-dynamic}"',
        ),
        `expected a dynamic VIBE_UPDATE_MODE export, got: ${result.message}`,
      );
    },
  );
});

Deno.test("load-config - exports VIBE_UPDATE_MODE as frozen when the host is pinned", async () => {
  await withTempConfig(frozenConfig(), async (configPath) => {
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      buildDefaultWorkerConfig(),
    );
    assert(
      result.message.includes(
        'export VIBE_UPDATE_MODE="${VIBE_UPDATE_MODE:-frozen}"',
      ),
      `expected a frozen VIBE_UPDATE_MODE export, got: ${result.message}`,
    );
  });
});
