/**
 * The update-mode setup conversation (Issue #626, part of #583; the default
 * flipped to `frozen` by Issue #692, part of #674).
 *
 * Every test drives the real command with injected input, injected git, an
 * injected release lookup and an injected "what would dynamic install"
 * resolver, then asserts on what landed in a temporary `.config.json` — no
 * terminal, no network, no real checkout.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  readUpdateModeSettings,
  writeUpdateModeConfig,
} from "../setup/config_writer.ts";
import {
  runUpdateModeSetup,
  type UpdateModeSetupDeps,
} from "../setup/update_mode_setup.ts";
import type { DynamicVersionCandidate } from "../lib/software_updates.ts";
import { RELEASE_MANIFEST_ASSET } from "../lib/release_manifest.ts";

/** Versions the injected resolver reports as today's dynamic choice. */
const DYNAMIC_VERSIONS: DynamicVersionCandidate[] = [
  { tool: "claude", version: "2.0.76", eligible: true, reason: "aged out" },
  { tool: "gh", version: "2.62.0", eligible: true, reason: "aged out" },
  { tool: "deno", version: "2.5.4", eligible: true, reason: "aged out" },
];

/** The newest release the injected lookup reports. */
const LATEST_RELEASE = "1.5.0";

/** The versions that release recorded in its manifest (Issue #688). */
const RELEASE_TOOLS = { claude: "2.0.70", gh: "2.61.0", deno: "2.5.2" };

/** A checkout in which only these refs resolve. */
const KNOWN_REFS: Record<string, string> = {
  "v1.4.0": "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
  [LATEST_RELEASE]: "1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3d4",
  "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3":
    "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
};

/** A release lookup that reports no `tool-versions.json` asset. */
const NO_MANIFEST: Partial<UpdateModeSetupDeps> = {
  releaseToolVersions: (_repoDir, tag) =>
    Promise.resolve({
      ok: true,
      value: {
        kind: "no-manifest",
        tag,
        reason: `Release ${tag} carries no ${RELEASE_MANIFEST_ASSET} asset.`,
      },
    }),
};

/** A release lookup that cannot reach GitHub at all. */
const NO_RELEASE: Partial<UpdateModeSetupDeps> = {
  latestRelease: () =>
    Promise.resolve({ ok: false, error: new Error("gh release list failed") }),
};

interface Harness {
  deps: Partial<UpdateModeSetupDeps>;
  /** Questions the conversation asked, in order. */
  asked: string[];
  /** Lines the conversation printed. */
  said: string[];
  /** Refs handed to the resolver. */
  resolved: string[];
  /** How many times origin was fetched. */
  fetches: number;
}

/**
 * A scripted operator: each entry is one typed answer ("" is a bare Enter).
 * Running out of answers is EOF, which the conversation must treat as
 * "nothing was written" rather than a guess.
 */
function harness(
  answers: string[],
  overrides: Partial<UpdateModeSetupDeps> = {},
): Harness {
  const asked: string[] = [];
  const said: string[] = [];
  const resolved: string[] = [];
  const queue = [...answers];
  const state = { fetches: 0 };

  const deps: Partial<UpdateModeSetupDeps> = {
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(queue.length > 0 ? queue.shift()! : null);
    },
    say: (message) => said.push(message),
    interactive: () => true,
    fetchOrigin: () => {
      state.fetches++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    resolveCommit: (_repoDir, ref) => {
      resolved.push(ref);
      return Promise.resolve(KNOWN_REFS[ref] ?? null);
    },
    dynamicVersions: () => Promise.resolve(DYNAMIC_VERSIONS),
    latestRelease: () =>
      Promise.resolve({
        ok: true,
        value: { tag: LATEST_RELEASE, version: [1, 5, 0] },
      }),
    releaseToolVersions: (_repoDir, tag) =>
      Promise.resolve({
        ok: true,
        value: { kind: "manifest", tag, tools: { ...RELEASE_TOOLS } },
      }),
    ...overrides,
  };

  return {
    deps,
    asked,
    said,
    resolved,
    get fetches() {
      return state.fetches;
    },
  };
}

/** A temporary checkout root holding a `.config.json` with `contents`. */
async function tempConfig(
  contents: Record<string, unknown> | null,
): Promise<{ dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-update-mode-" });
  const path = `${dir}/.config.json`;
  if (contents !== null) {
    await Deno.writeTextFile(path, JSON.stringify(contents, null, 2) + "\n");
  }
  return { dir, path };
}

/** Read the config back as a plain record. */
async function readConfig(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

// ---------------------------------------------------------------------------
// Frozen — the default for a fresh host (Issue #692)
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - accepting every default pins a fresh host to the latest release", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness(["", "", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok, "the conversation should succeed");
    assertEquals(result.value.settings.update_mode, "frozen");
    assertEquals(result.value.changed, true);

    const config = await readConfig(path);
    assertEquals(config.update_mode, "frozen");
    assertEquals(config.pinned_ref, LATEST_RELEASE);
    assertEquals(config.pinned_tool_versions, RELEASE_TOOLS);
    // Unrelated keys survive the merge.
    assertEquals(config.repos, ["org/repo"]);
    // The mode prompt offered `frozen`, not `dynamic`.
    assertStringIncludes(h.asked[0] ?? "", "[frozen]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - typing dynamic still writes dynamic and no pins", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness(["dynamic"]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok, "the conversation should succeed");
    assertEquals(result.value.settings.update_mode, "dynamic");
    assertEquals(result.value.changed, true);

    const config = await readConfig(path);
    assertEquals(config.update_mode, "dynamic");
    assertEquals(config.pinned_ref, undefined);
    assertEquals(config.pinned_tool_versions, undefined);
    // Dynamic ends the conversation: only the mode was asked.
    assertEquals(h.asked.length, 1);
    assertEquals(config.repos, ["org/repo"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - dynamic leaves stale pin fields where they are", async () => {
  const { dir, path } = await tempConfig({
    update_mode: "frozen",
    pinned_ref: "v1.4.0",
    pinned_tool_versions: { claude: "2.0.1", gh: "2.60.0", deno: "2.5.0" },
  });
  try {
    const h = harness(["dynamic"]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const config = await readConfig(path);
    assertEquals(config.update_mode, "dynamic");
    assertEquals(config.pinned_ref, "v1.4.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Frozen — ref and versions
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - frozen with a valid tag writes the ref and all three versions", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", "v1.4.0", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok, "a resolvable tag should be accepted");
    const config = await readConfig(path);
    assertEquals(config.update_mode, "frozen");
    assertEquals(config.pinned_ref, "v1.4.0");
    // A typed ref does not change where the version defaults come from: the
    // latest release's manifest still supplies them (Issue #688).
    assertEquals(config.pinned_tool_versions, RELEASE_TOOLS);
    assertEquals(h.fetches, 1, "origin is fetched before the ref is resolved");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - frozen accepts a commit SHA", async () => {
  const sha = "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3";
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", sha, "2.0.9", "2.61.0", "2.5.1"]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const config = await readConfig(path);
    assertEquals(config.pinned_ref, sha);
    assertEquals(config.pinned_tool_versions, {
      claude: "2.0.9",
      gh: "2.61.0",
      deno: "2.5.1",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - an unresolvable ref is rejected by name and asked again", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", "v9.9.9-nope", "v1.4.0", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const rejection = h.said.find((line) => line.includes("v9.9.9-nope"));
    assert(rejection, "the rejection must name the ref that did not resolve");
    assertStringIncludes(rejection, "does not resolve");

    const config = await readConfig(path);
    assertEquals(config.pinned_ref, "v1.4.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a ref that never resolves writes nothing at all", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  const before = await Deno.readTextFile(path);
  try {
    const h = harness(["frozen", "v9.9.9-nope"]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(!result.ok, "input ending mid-conversation must fail loud");
    assertStringIncludes(result.error.message, "pinned ref");
    assertEquals(await Deno.readTextFile(path), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a ref with shell metacharacters is refused before git sees it", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", "v1.4.0; rm -rf /", "v1.4.0", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals(
      h.resolved,
      ["v1.4.0"],
      "the unsafe value must never reach the resolver",
    );
    const config = await readConfig(path);
    assertEquals(config.pinned_ref, "v1.4.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - an unresolvable tool version default is reported and typed by hand", async () => {
  const { dir, path } = await tempConfig({});
  try {
    // No release manifest, so the defaults fall back to dynamic (Issue #692)
    // — and this run's dynamic resolver cannot answer for the Claude CLI.
    const h = harness(["frozen", "v1.4.0", "2.0.5", "", ""], {
      ...NO_MANIFEST,
      dynamicVersions: () =>
        Promise.resolve([
          {
            tool: "claude",
            version: null,
            eligible: false,
            reason: "Claude CLI: npm did not answer.",
          },
          ...DYNAMIC_VERSIONS.slice(1),
        ]),
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assert(
      h.said.some((line) => line.includes("npm did not answer")),
      "the unresolved default must be explained, not silently blank",
    );
    const config = await readConfig(path);
    assertEquals(config.pinned_tool_versions, {
      claude: "2.0.5",
      gh: "2.62.0",
      deno: "2.5.4",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Release defaults and their fallbacks (Issue #692)
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - a release with no manifest falls back to the dynamic versions and says so", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["", "", "", "", ""], NO_MANIFEST);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const fallback = h.said.find((line) =>
      line.includes(RELEASE_MANIFEST_ASSET)
    );
    assert(fallback, "the missing manifest must be stated in the output");
    assertStringIncludes(fallback, "Falling back");

    // The ref default still comes from the release; the versions from dynamic.
    const config = await readConfig(path);
    assertEquals(config.pinned_ref, LATEST_RELEASE);
    assertEquals(config.pinned_tool_versions, {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    });
    // Every version prompt carried a default, so a bare Enter answered it.
    for (const question of h.asked.filter((q) => q.includes("version"))) {
      assertStringIncludes(question, "[");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - an unresolvable release falls back to the dynamic versions and says why", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["", "v1.4.0", "", "", ""], NO_RELEASE);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const stated = h.said.find((line) =>
      line.includes("Could not resolve the latest release")
    );
    assert(stated, "an unresolvable release must be stated in the output");
    assertStringIncludes(stated, "gh release list failed");

    const config = await readConfig(path);
    assertEquals(config.update_mode, "frozen");
    assertEquals(config.pinned_ref, "v1.4.0");
    assertEquals(config.pinned_tool_versions, {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a failed fetch is reported and a local ref still pins", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", "v1.4.0", "", "", ""], {
      fetchOrigin: () =>
        Promise.resolve({
          ok: false,
          error: new Error("git fetch --tags origin failed (exit code 128)"),
        }),
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assert(
      h.said.some((line) => line.includes("Could not fetch origin")),
      "a failed fetch must be said out loud",
    );
    assertEquals((await readConfig(path)).pinned_ref, "v1.4.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Re-runs and non-interactive runs
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - re-running on a frozen host and pressing Enter changes nothing", async () => {
  const { dir, path } = await tempConfig({
    repos: ["org/repo"],
    update_mode: "frozen",
    pinned_ref: "v1.4.0",
    pinned_tool_versions: { claude: "2.0.1", gh: "2.60.0", deno: "2.5.0" },
  });
  const before = await Deno.readTextFile(path);
  try {
    const h = harness(["", "", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals(result.value.changed, false);
    assertEquals(await Deno.readTextFile(path), before);
    // Every default came from the file — not from today's dynamic versions,
    // and not from the latest release either (Issue #692).
    assertEquals(result.value.settings.pinned_ref, "v1.4.0");
    assertEquals(result.value.settings.pinned_tool_versions, {
      claude: "2.0.1",
      gh: "2.60.0",
      deno: "2.5.0",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - re-running on a dynamic host and pressing Enter changes nothing", async () => {
  const { dir, path } = await tempConfig({
    repos: ["org/repo"],
    update_mode: "dynamic",
  });
  const before = await Deno.readTextFile(path);
  try {
    const h = harness([""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    // The flipped default must not re-ask a dynamic host into a pin.
    assertEquals(result.value.settings.update_mode, "dynamic");
    assertEquals(result.value.changed, false);
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(h.asked.length, 1);
    assertStringIncludes(h.asked[0] ?? "", "[dynamic]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a non-interactive run neither prompts nor changes existing values", async () => {
  const { dir, path } = await tempConfig({
    update_mode: "frozen",
    pinned_ref: "v1.4.0",
    pinned_tool_versions: { claude: "2.0.1", gh: "2.60.0", deno: "2.5.0" },
  });
  const before = await Deno.readTextFile(path);
  try {
    const h = harness([], {
      interactive: () => false,
      ask: () => {
        throw new Error("a non-interactive run must not prompt");
      },
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals(result.value.prompted, false);
    assertEquals(result.value.changed, false);
    assertEquals(await Deno.readTextFile(path), before);
    assertEquals(h.asked.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a non-interactive fresh config pins to the latest release without prompting", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness([], {
      interactive: () => false,
      ask: () => {
        throw new Error("a non-interactive run must not prompt");
      },
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals(result.value.prompted, false);
    assertEquals(result.value.changed, true);
    const config = await readConfig(path);
    assertEquals(config.update_mode, "frozen");
    assertEquals(config.pinned_ref, LATEST_RELEASE);
    assertEquals(config.pinned_tool_versions, RELEASE_TOOLS);
    assertEquals(config.repos, ["org/repo"]);
    assertEquals(h.asked.length, 0);
    assert(
      h.said.some((line) => line.includes(`release ${LATEST_RELEASE}`)),
      "the pin an unattended run chose must be stated",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a non-interactive fresh config with no release stays dynamic with one warning", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness([], {
      ...NO_RELEASE,
      interactive: () => false,
      ask: () => {
        throw new Error("a non-interactive run must not prompt");
      },
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const config = await readConfig(path);
    assertEquals(config.update_mode, "dynamic");
    assertEquals(config.pinned_ref, undefined);
    assertEquals(config.pinned_tool_versions, undefined);

    const warnings = h.said.filter((line) => line.includes("dynamic"));
    assertEquals(warnings.length, 1, "exactly one warning line, not a wall");
    assertStringIncludes(warnings[0] ?? "", "gh release list failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a non-interactive fresh config with no manifest stays dynamic rather than half-pinned", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness([], { ...NO_MANIFEST, interactive: () => false });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const config = await readConfig(path);
    // A ref without the versions it ships with is the partial pin frozen mode
    // exists to prevent, so nothing is pinned at all.
    assertEquals(config.update_mode, "dynamic");
    assertEquals(config.pinned_ref, undefined);
    assert(
      h.said.some((line) => line.includes(RELEASE_MANIFEST_ASSET)),
      "the reason the host was not pinned must be stated",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a missing config file is created pinned to the latest release", async () => {
  const { dir, path } = await tempConfig(null);
  try {
    const h = harness([], { interactive: () => false });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const config = await readConfig(path);
    assertEquals(config.update_mode, "frozen");
    assertEquals(config.pinned_ref, LATEST_RELEASE);
    assertEquals(config.pinned_tool_versions, RELEASE_TOOLS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-loud reads and writes
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - malformed JSON fails loud rather than being overwritten", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-update-mode-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, "{ not json");
  try {
    const h = harness(["dynamic"]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(!result.ok);
    assertStringIncludes(result.error.message, "invalid JSON");
    assertEquals(await Deno.readTextFile(path), "{ not json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readUpdateModeSettings - an unrecognised update_mode is a fail-loud error", async () => {
  const { dir, path } = await tempConfig({ update_mode: "thawed" });
  try {
    const result = await readUpdateModeSettings(path);
    assert(!result.ok);
    assertStringIncludes(result.error.message, "thawed");
    assertStringIncludes(result.error.message, "dynamic, frozen");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readUpdateModeSettings - a config with no update-mode keys reads as empty", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const result = await readUpdateModeSettings(path);
    assert(result.ok);
    assertEquals(result.value, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeUpdateModeConfig - keeps the file at owner-only permissions", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const written = await writeUpdateModeConfig(path, {
      update_mode: "frozen",
      pinned_ref: "v1.4.0",
      pinned_tool_versions: { claude: "2.0.1", gh: "2.60.0", deno: "2.5.0" },
    });
    assert(written.ok);
    assertEquals(written.value, true);

    const mode = (await Deno.stat(path)).mode;
    if (mode !== null && Deno.build.os !== "windows") {
      assertEquals(mode & 0o777, 0o600);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The delegation contract setup.sh keeps
// ---------------------------------------------------------------------------

Deno.test("setup.sh - delegates the update mode to the Deno command and keeps no mode logic", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const source = await Deno.readTextFile(`${repoRoot}/setup.sh`);

  const runs = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .some((line) => /run_setup_cli\s+update-mode\b/.test(line));
  assert(runs, "setup.sh must invoke `run_setup_cli update-mode`");

  // The shell must not have grown its own copy of the conversation: no jq
  // merge of the pin fields, which is what "the logic lives in Deno" means.
  const shellMergesPins =
    /jq[^\n]*(update_mode|pinned_ref|pinned_tool_versions)/
      .test(source);
  assertEquals(
    shellMergesPins,
    false,
    "setup.sh must not merge update-mode fields itself",
  );
});

// ---------------------------------------------------------------------------
// House style — glyphs and bracketed defaults (Issue #870)
// ---------------------------------------------------------------------------

/** The line as a terminal without colour would show it. */
function unstyled(line: string): string {
  // deno-lint-ignore no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Lines that begin with `glyph`, stripped of any colour. */
function glyphLines(said: string[], glyph: string): string[] {
  return said.map(unstyled).filter((line) => line.startsWith(`${glyph}  `));
}

Deno.test("runUpdateModeSetup - explanatory lines carry the info glyph", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["", "", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const info = glyphLines(h.said, "ℹ");
    assert(
      info.some((line) => line.startsWith("ℹ  Update mode: 'dynamic' tracks")),
      `the mode explanation must print with ℹ — got ${JSON.stringify(info)}`,
    );
    assert(
      info.some((line) => line.startsWith("ℹ  Pinned ref: the commit SHA")),
      "the pinned-ref explanation must print with ℹ",
    );
    assert(
      info.some((line) => line.startsWith("ℹ  Tool versions: the exact")),
      "the tool-versions explanation must print with ℹ",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a rejected answer carries the warning glyph", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness([
      "sideways",
      "frozen",
      "v9.9.9-nope",
      "v1.4.0",
      "",
      "",
      "",
    ]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const warnings = glyphLines(h.said, "⚠");
    assert(
      warnings.some((line) => line.includes("is not an update mode")),
      `a rejected mode must print with ⚠ — got ${JSON.stringify(warnings)}`,
    );
    assert(
      warnings.some((line) => line.includes("does not resolve to a commit")),
      "a rejected ref must print with ⚠",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a failed fetch and a missing manifest carry the warning glyph", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["", "", "", "", ""], {
      ...NO_MANIFEST,
      fetchOrigin: () =>
        Promise.resolve({ ok: false, error: new Error("offline") }),
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const warnings = glyphLines(h.said, "⚠");
    assert(
      warnings.some((line) => line.includes("Could not fetch origin")),
      "a failed fetch must print with ⚠",
    );
    assert(
      warnings.some((line) => line.includes("Falling back")),
      "the manifest fallback must print with ⚠",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a confirmed answer carries the success glyph", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["frozen", "v1.4.0", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    const confirmed = glyphLines(h.said, "✓");
    assert(
      confirmed.includes("✓  Update mode: frozen."),
      `the chosen mode must be confirmed with ✓ — got ${
        JSON.stringify(confirmed)
      }`,
    );
    assert(
      confirmed.some((line) => line.startsWith("✓  v1.4.0 resolves to ")),
      "the resolved ref must be confirmed with ✓",
    );
    assert(
      confirmed.some((line) => line.startsWith("✓  Pinned Claude CLI ")),
      "the pinned versions must be confirmed with ✓",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - every question shows its default in brackets", async () => {
  const { dir, path } = await tempConfig({});
  try {
    const h = harness(["", "", "", "", ""]);
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals(h.asked.length, 5);
    const defaults = [
      "frozen",
      LATEST_RELEASE,
      ...Object.values(RELEASE_TOOLS),
    ];
    for (const [index, question] of h.asked.entries()) {
      assertStringIncludes(question, `[${defaults[index]}]`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a question with no default never renders a stray []", async () => {
  const { dir, path } = await tempConfig({});
  try {
    // No release to default the ref from, and nothing dynamic mode can offer:
    // every pin question therefore has no default at all.
    const h = harness(["frozen", "v1.4.0", "2.0.5", "2.61.1", "2.5.3"], {
      ...NO_RELEASE,
      dynamicVersions: () =>
        Promise.resolve(
          DYNAMIC_VERSIONS.map((candidate) => ({
            ...candidate,
            version: null,
            eligible: false,
            reason: `${candidate.tool}: the registry did not answer.`,
          })),
        ),
    });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    for (const question of h.asked) {
      assert(
        !question.includes("[]"),
        `a defaultless question must render bare — got "${question}"`,
      );
    }
    // The ref and version questions carried no default; only the mode did.
    assertEquals(
      h.asked.filter((question) => question.includes("[")).length,
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
