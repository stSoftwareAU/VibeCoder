/**
 * Tests for the `upgrade` command (Issue #691, part of #674).
 *
 * One command moves a frozen host onto the newest release: it rewrites
 * `pinned_ref` and all three `pinned_tool_versions` in `.config.json` and
 * nothing else. Every test runs the real command against a real temporary
 * `.config.json` with injected release-check deps — no `gh`, no git, no
 * network — and asserts on the file the command left behind as well as the
 * message it printed.
 *
 * The properties under test are the ones a wrong pin would cost an operator:
 * every other key survives, a re-run writes nothing at all, a release with no
 * manifest is refused rather than half-pinned, and a resolution failure leaves
 * the file byte-identical.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  runUpgrade,
  upgradeCommand,
  UPGRADE_COMMAND_NAME,
} from "../commands/upgrade.ts";
import { readCheckoutUpdateMode } from "../commands/worker_checkout_update.ts";
import { validateUpdateModeSettings } from "../lib/config_validator.ts";
import { formatReleaseManifest } from "../lib/release_manifest.ts";
import type { ReleaseCheckDeps } from "../lib/release_check.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import type { Result } from "../types.ts";

/** A successful `gh` invocation carrying `stdout`. */
function ghOk(stdout: string): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: true, code: 0, stdout, stderr: "", timedOut: false },
  };
}

/** A `gh` invocation that exited non-zero. */
function ghFailed(stderr: string): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: false, code: 1, stdout: "", stderr, timedOut: false },
  };
}

/** `gh release list --json` output for the tags given. */
function releaseList(tags: readonly string[]): string {
  return JSON.stringify(
    tags.map((tag) => ({ tagName: tag, isDraft: false, isPrerelease: false })),
  );
}

/** `gh release view --json assets` output naming the assets given. */
function assetList(names: readonly string[]): string {
  return JSON.stringify({ assets: names.map((name) => ({ name })) });
}

/** Deps serving one canned `gh` response per call, in order. */
function sequenceDeps(
  responses: readonly Result<SubprocessResult>[],
): ReleaseCheckDeps {
  let call = 0;
  return {
    resolveRepo: () => Promise.resolve({ ok: true, value: "stSoftwareAU/Vc" }),
    runGh: () => {
      const response = responses[call++];
      if (!response) throw new Error(`unexpected gh call ${call}`);
      return Promise.resolve(response);
    },
  };
}

/**
 * Deps for a repository whose newest release is `tag` and which records the
 * tool versions given — the whole happy path in one call.
 */
function releaseDeps(
  tag: string,
  tools: { claude: string; gh: string; deno: string },
): ReleaseCheckDeps {
  return sequenceDeps([
    ghOk(releaseList(["1.0.1", tag, "1.0.0"])),
    ghOk(assetList(["tool-versions.json"])),
    ghOk(formatReleaseManifest({ release: tag, tools })),
  ]);
}

/** The versions the fixture release records. */
const RELEASE_TOOLS = { claude: "2.0.80", gh: "2.63.0", deno: "2.5.6" };

/** A frozen host one release behind, plus unrelated config it must keep. */
function frozenConfig(): Record<string, unknown> {
  return {
    repos: ["org/repo1"],
    allowed_authors: ["someone"],
    update_mode: "frozen",
    pinned_ref: "1.0.4",
    pinned_tool_versions: {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    },
    max_concurrent_issues: 2,
  };
}

/** Write a `.config.json` into a fresh temporary checkout. */
async function makeCheckout(
  config: Record<string, unknown> | null,
): Promise<{ baseDir: string; configPath: string }> {
  const baseDir = await Deno.makeTempDir({ prefix: "upgrade_test_" });
  const configPath = `${baseDir}/.config.json`;
  if (config !== null) {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  }
  return { baseDir, configPath };
}

/** The `.config.json` as parsed JSON. */
async function readConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(configPath));
}

Deno.test("upgrade - moves pinned_ref and all three tool versions in one write", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );

    assert(result.success, result.message);
    const written = await readConfig(configPath);
    assertEquals(written["pinned_ref"], "1.0.5");
    assertEquals(written["pinned_tool_versions"], RELEASE_TOOLS);
    assertEquals(written["update_mode"], "frozen");

    // Every other key survives the upgrade untouched.
    assertEquals(written["repos"], ["org/repo1"]);
    assertEquals(written["allowed_authors"], ["someone"]);
    assertEquals(written["max_concurrent_issues"], 2);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - names the old and new ref and every old → new version", async () => {
  const { baseDir } = await makeCheckout(frozenConfig());
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );

    assert(result.success, result.message);
    assertStringIncludes(result.message, "1.0.4 → 1.0.5");
    assertStringIncludes(result.message, "2.0.76 → 2.0.80");
    assertStringIncludes(result.message, "2.62.0 → 2.63.0");
    assertStringIncludes(result.message, "2.5.4 → 2.5.6");
    assertStringIncludes(result.message, "next launch");
    assertEquals(result.data?.changed, true);
    assertEquals(result.data?.previousRef, "1.0.4");
    assertEquals(result.data?.ref, "1.0.5");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - the written config validates and the launch path reads it back", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );
    assert(result.success, result.message);

    const written = await readConfig(configPath);
    assertEquals(
      validateUpdateModeSettings({
        updateMode: written["update_mode"] as "frozen",
        pinnedRef: written["pinned_ref"] as string,
        pinnedToolVersions: written["pinned_tool_versions"] as Record<
          string,
          string
        >,
      }),
      [],
    );

    // The frozen launch path (Issue #624) reads exactly what was written.
    const readBack = await readCheckoutUpdateMode(baseDir);
    assert(readBack.ok, readBack.ok ? "" : readBack.error.message);
    assertEquals(readBack.value, { mode: "frozen", ref: "1.0.5" });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a second run says so and leaves the file byte-identical", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  try {
    const first = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );
    assert(first.success, first.message);
    const after = await Deno.readTextFile(configPath);

    const second = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );
    assert(second.success, second.message);
    assertEquals(second.message, "Vibe Coder is already up to date (1.0.5).");
    assertEquals(second.data?.changed, false);
    assertEquals(await Deno.readTextFile(configPath), after);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a dynamic host has nothing to pin and exits clean", async () => {
  const { baseDir, configPath } = await makeCheckout({
    repos: ["org/repo1"],
    update_mode: "dynamic",
  });
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade({ "base-dir": baseDir }, sequenceDeps([]));

    assert(result.success, result.message);
    assertStringIncludes(result.message, "update_mode");
    assertStringIncludes(result.message, "every launch");
    assertEquals(result.data?.changed, false);
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a host with no update_mode is dynamic and is not pinned", async () => {
  const { baseDir, configPath } = await makeCheckout({ repos: ["org/repo1"] });
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade({ "base-dir": baseDir }, sequenceDeps([]));

    assert(result.success, result.message);
    assertEquals(result.data?.mode, "dynamic");
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a release with no manifest is refused, naming it", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      sequenceDeps([
        ghOk(releaseList(["1.0.5"])),
        ghOk(assetList(["vibe-coder.tar.gz"])),
      ]),
    );

    assert(!result.success);
    assertStringIncludes(result.message, "1.0.5");
    assertStringIncludes(result.message, "tool-versions.json");
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a failed release resolution leaves the config unchanged", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      sequenceDeps([ghFailed("could not resolve host api.github.com")]),
    );

    assert(!result.success);
    assertStringIncludes(result.message, "api.github.com");
    assertStringIncludes(result.message, configPath);
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a manifest download failure leaves the config unchanged", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      sequenceDeps([
        ghOk(releaseList(["1.0.5"])),
        ghOk(assetList(["tool-versions.json"])),
        ghFailed("release asset download failed"),
      ]),
    );

    assert(!result.success);
    assertStringIncludes(result.message, "download failed");
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a repository with no releases pins nothing", async () => {
  const { baseDir, configPath } = await makeCheckout(frozenConfig());
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      sequenceDeps([ghOk(releaseList([]))]),
    );

    assert(!result.success);
    assertStringIncludes(result.message, "release");
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a commit-SHA pin is moved onto the release, saying it could not be compared", async () => {
  const config = frozenConfig();
  config["pinned_ref"] = "3f2a1b9c4d5e6f708192a3b4c5d6e7f809a1b2c3";
  const { baseDir, configPath } = await makeCheckout(config);
  try {
    const result = await runUpgrade(
      { "base-dir": baseDir },
      releaseDeps("1.0.5", RELEASE_TOOLS),
    );

    assert(result.success, result.message);
    assertStringIncludes(result.message, "commit SHA");
    assertEquals((await readConfig(configPath))["pinned_ref"], "1.0.5");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - an unreadable update_mode fails loud rather than guessing", async () => {
  const config = frozenConfig();
  config["update_mode"] = "pinned-ish";
  const { baseDir, configPath } = await makeCheckout(config);
  const before = await Deno.readTextFile(configPath);
  try {
    const result = await runUpgrade({ "base-dir": baseDir }, sequenceDeps([]));

    assert(!result.success);
    assertStringIncludes(result.message, "update_mode");
    assertEquals(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - a checkout with no .config.json says so", async () => {
  const { baseDir, configPath } = await makeCheckout(null);
  try {
    const result = await runUpgrade({ "base-dir": baseDir }, sequenceDeps([]));

    assert(!result.success);
    assertStringIncludes(result.message, configPath);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("upgrade - refuses to run without --base-dir", async () => {
  const result = await runUpgrade({}, sequenceDeps([]));
  assert(!result.success);
  assertStringIncludes(result.message, "--base-dir");
});

Deno.test("upgrade - the registered command carries the documented name", () => {
  assertEquals(upgradeCommand.name, UPGRADE_COMMAND_NAME);
  assertEquals(UPGRADE_COMMAND_NAME, "upgrade");
});
