/**
 * Progress extensions are on by default (Issue #422, parent #397).
 *
 * The re-armable issue-work deadline shipped dark (#4290/#4295/#4296): the
 * mechanism was complete and tested but `progressExtensionEnabled` defaulted
 * to `false`, so a worker with no `progress_extension_*` keys kept the flat
 * `claude_timeout` kill and a demonstrably-progressing run still died on the
 * clock. With the supervisor hard cap bounding every grant (Issue #421) the
 * chain is bounded, so the default flips on.
 *
 * These tests pin the three things that must hold together:
 *   - both config readers resolve the same new default,
 *   - the switch still works — `progress_extension_enabled: false` keeps the
 *     one-shot kill,
 *   - the operator-facing documentation no longer describes the feature as
 *     opt-in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { loadConfigCommand } from "../commands/load_config.ts";
import {
  buildDefaultWorkerConfig,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { buildProgressExtension } from "../lib/progress_extension_runtime.ts";
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

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

Deno.test("progress extension default - an empty config resolves enabled through lib/config.ts (Issue #422)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(
      config.progressExtensionEnabled,
      true,
      "a worker with no progress_extension_* keys must extend on progress",
    );
  });
});

Deno.test("progress extension default - the companion defaults pass their own validation (Issue #422)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    // loadConfig throws on a non-positive grant/stall/check or on a stall
    // window shorter than the check interval, so reaching here already proves
    // the defaults are self-consistent. Pin the production values too.
    const config = await loadConfig(configPath);
    assertEquals(config.progressExtensionGrantSeconds, 900);
    assertEquals(config.progressExtensionStallSeconds, 300);
    assertEquals(config.progressExtensionCheckSeconds, 300);
    assert(
      config.progressExtensionStallSeconds! >=
        config.progressExtensionCheckSeconds!,
      "the stall window may not be shorter than the check interval",
    );
  });
});

Deno.test("progress extension default - commands/load_config.ts exports the same default (Issue #422)", async () => {
  await withTempConfig(minimalConfig(), async (configPath) => {
    const result = await loadConfigCommand.execute(
      { "config-path": configPath },
      buildDefaultWorkerConfig(),
    );
    assert(
      result.message.includes(
        'export PROGRESS_EXTENSION_ENABLED="${PROGRESS_EXTENSION_ENABLED:-true}"',
      ),
      `the shell export must agree with lib/config.ts: ${result.message}`,
    );
  });
});

Deno.test("progress extension default - an explicit false still yields the one-shot kill (Issue #422)", async () => {
  await withTempConfig(
    minimalConfig({ progress_extension_enabled: false }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.progressExtensionEnabled, false);

      // No option means the runner keeps its unconditional hard timeout.
      const option = await buildProgressExtension(config, Deno.cwd());
      assertEquals(
        option,
        undefined,
        "an operator who switched extensions off must keep the flat kill",
      );

      const result = await loadConfigCommand.execute(
        { "config-path": configPath },
        buildDefaultWorkerConfig(),
      );
      assert(
        result.message.includes(
          'export PROGRESS_EXTENSION_ENABLED="${PROGRESS_EXTENSION_ENABLED:-false}"',
        ),
        `the shell export must follow the operator's switch: ${result.message}`,
      );
    },
  );
});

Deno.test("progress extension default - an unconfigured worker builds a runner option (Issue #422)", async () => {
  const option = await buildProgressExtension(
    buildDefaultWorkerConfig(),
    Deno.cwd(),
  );
  assert(option !== undefined, "the default config must build an option");
  assertEquals(option.policy.enabled, true);
  assertEquals(
    option.policy.grantSeconds,
    OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds,
  );
  assertEquals(
    option.policy.activityStallSeconds,
    OPERATIONAL_DEFAULTS.progressExtensionStallSeconds,
  );
  assertEquals(
    option.policy.checkSeconds,
    OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds,
  );
});

Deno.test("progress extension default - CONFIGURATION.md documents the on-by-default behaviour (Issue #422)", async () => {
  const doc = await Deno.readTextFile(repoPath("docs/CONFIGURATION.md"));

  const row = doc.split("\n").find((line) =>
    line.includes("| `progress_extension_enabled` |")
  );
  assert(row !== undefined, "no progress_extension_enabled reference row");
  assert(
    row.includes("| `true` |"),
    `the documented default must be the shipped default: ${row}`,
  );
  assertEquals(
    /off by default/i.test(row),
    false,
    `the reference row still calls the feature opt-in: ${row}`,
  );

  // The operator must be told how to get the old flat kill back.
  assert(
    doc.includes('"progress_extension_enabled": false'),
    "the docs must show how to switch extensions off",
  );
  // And that the chain is bounded, not open-ended (Issue #421).
  assert(
    doc.includes("The run hard cap bounds every grant"),
    "the docs must state the ceiling that bounds the on-by-default chain",
  );
});
