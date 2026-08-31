/**
 * The update-mode setup conversation (Issue #626, part of #583).
 *
 * Every test drives the real command with injected input, injected git and an
 * injected "what would dynamic install" resolver, then asserts on what landed
 * in a temporary `.config.json` — no terminal, no network, no real checkout.
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

/** Versions the injected resolver reports as today's dynamic choice. */
const DYNAMIC_VERSIONS: DynamicVersionCandidate[] = [
  { tool: "claude", version: "2.0.76", eligible: true, reason: "aged out" },
  { tool: "gh", version: "2.62.0", eligible: true, reason: "aged out" },
  { tool: "deno", version: "2.5.4", eligible: true, reason: "aged out" },
];

/** A checkout in which only these refs resolve. */
const KNOWN_REFS: Record<string, string> = {
  "v1.4.0": "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
  "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3":
    "9f3c1a2b4d5e6f708192a3b4c5d6e7f809a1b2c3",
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
// Dynamic — the default
// ---------------------------------------------------------------------------

Deno.test("runUpdateModeSetup - accepting the defaults writes dynamic and no pins", async () => {
  const { dir, path } = await tempConfig({ repos: ["org/repo"] });
  try {
    const h = harness([""]);
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
    // Unrelated keys survive the merge.
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
    assertEquals(config.pinned_tool_versions, {
      claude: "2.0.76",
      gh: "2.62.0",
      deno: "2.5.4",
    });
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
    const h = harness(["frozen", "v1.4.0", "2.0.5", "", ""], {
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
    // Every default came from the file, not from today's dynamic versions.
    assertEquals(result.value.settings.pinned_tool_versions, {
      claude: "2.0.1",
      gh: "2.60.0",
      deno: "2.5.0",
    });
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

Deno.test("runUpdateModeSetup - a non-interactive fresh config defaults to dynamic", async () => {
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
    assertEquals(result.value.changed, true);
    const config = await readConfig(path);
    assertEquals(config.update_mode, "dynamic");
    assertEquals(config.repos, ["org/repo"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runUpdateModeSetup - a missing config file is created with the dynamic default", async () => {
  const { dir, path } = await tempConfig(null);
  try {
    const h = harness([], { interactive: () => false });
    const result = await runUpdateModeSetup({
      repoDir: dir,
      configPath: path,
      deps: h.deps,
    });

    assert(result.ok);
    assertEquals((await readConfig(path)).update_mode, "dynamic");
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
