/**
 * Tests for run_mode.ts — the container/native run-mode setting (Issue #4146,
 * parent #4145, milestone #4060).
 *
 * The setting is the spelling every launcher and `setup.sh` reads, so these
 * tests pin the three things that must never drift: container is the default,
 * `VIBE_RUN_MODE` beats `.config.json` `run_mode`, and an unrecognised value
 * fails loudly naming both valid modes instead of being coerced to a default.
 *
 * They also pin the invariant that gives the setting its meaning: nothing in
 * the resolver may select `native` because a container runtime is missing. A
 * missing runtime in container mode stays the fatal error it is today, so the
 * only way to run natively is an explicit opt-in.
 *
 * Migrated off the now-deleted `tests/support/env.ts` (Issues #944, #969): the
 * `run-mode` command reached `CONFIG_PATH` and `VIBE_RUN_MODE` through
 * `Deno.env`, so a test could only state them by writing them into the
 * process — a mutation shared with every other worker under
 * `deno test --parallel`. The command now takes the lookup as an optional
 * third argument, and `loadConfig` passes its own lookup through to
 * `resolveRunMode`, so the whole suite declares the environment it wants.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  DEFAULT_RUN_MODE,
  isRunMode,
  parseRunMode,
  REMOVED_RUN_MODES,
  resolveRunMode,
  RUN_MODE_CONFIG_KEY,
  RUN_MODE_ENV,
  RUN_MODES,
} from "../lib/run_mode.ts";
import { runModeCommand } from "../commands/run_mode.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { validateConfigFileJson } from "../lib/validation.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";
import { runWorker } from "../lib/run_worker.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

/** Write a `.config.json` into a fresh temp directory and return its path. */
async function configFileWith(body: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-run-mode-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(body, null, 2));
  return path;
}

/** Remove the temp directory holding a config file written for one test. */
async function removeConfigFile(path: string): Promise<void> {
  await Deno.remove(path.slice(0, path.lastIndexOf("/")), { recursive: true });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

Deno.test("run mode - defaults to container with no configuration and no environment", () => {
  assertEquals(resolveRunMode({ env: emptyEnv }), "container");
  assertEquals(DEFAULT_RUN_MODE, "container");
  // Containment is mandatory (Issue #4): container is the only run mode.
  assertEquals([...RUN_MODES], ["container"]);
});

Deno.test("run mode - .config.json run_mode may name container explicitly", () => {
  assertEquals(
    resolveRunMode({ configured: "container", env: emptyEnv }),
    "container",
  );
});

Deno.test("run mode - VIBE_RUN_MODE may name container explicitly", () => {
  assertEquals(
    resolveRunMode({ env: envFrom({ [RUN_MODE_ENV]: "container" }) }),
    "container",
  );
});

Deno.test("run mode - the environment wins over .config.json: a valid override rescues a removed configured mode", () => {
  assertEquals(
    resolveRunMode({
      configured: "native",
      env: envFrom({ [RUN_MODE_ENV]: "container" }),
    }),
    "container",
  );
});

Deno.test("run mode - surrounding whitespace is tolerated, a blank value is not a selection", () => {
  assertEquals(
    resolveRunMode({ env: envFrom({ [RUN_MODE_ENV]: "  container  " }) }),
    "container",
  );
  // A blank override falls through to the configured value rather than
  // overriding it with nothing.
  assertEquals(
    resolveRunMode({
      configured: "container",
      env: envFrom({ [RUN_MODE_ENV]: "  " }),
    }),
    "container",
  );
  assertEquals(
    resolveRunMode({ configured: "  ", env: emptyEnv }),
    "container",
  );
});

// ---------------------------------------------------------------------------
// Fail loud — no silent coercion (Issue #3234)
// ---------------------------------------------------------------------------

Deno.test("run mode - an unrecognised .config.json value throws, naming the only mode", () => {
  const error = assertThrows(
    () => resolveRunMode({ configured: "host", env: emptyEnv }),
    Error,
  );
  assertStringIncludes(error.message, "container");
  assertStringIncludes(error.message, RUN_MODE_CONFIG_KEY);
});

Deno.test("run mode - an unrecognised VIBE_RUN_MODE value throws, naming the variable", () => {
  const error = assertThrows(
    () => resolveRunMode({ env: envFrom({ [RUN_MODE_ENV]: "docker" }) }),
    Error,
  );
  assertStringIncludes(error.message, RUN_MODE_ENV);
  assertStringIncludes(error.message, "container");
});

Deno.test("run mode - the removed modes fail loud with the removal explained, wherever they were set (Issue #4)", () => {
  for (const removed of REMOVED_RUN_MODES) {
    const fromConfig = assertThrows(
      () => resolveRunMode({ configured: removed, env: emptyEnv }),
      Error,
    );
    assertStringIncludes(fromConfig.message, "removed");
    assertStringIncludes(fromConfig.message, "Issue #4");
    assertStringIncludes(fromConfig.message, RUN_MODE_CONFIG_KEY);
    assertStringIncludes(fromConfig.message, removed);

    const fromEnv = assertThrows(
      () => resolveRunMode({ env: envFrom({ [RUN_MODE_ENV]: removed }) }),
      Error,
    );
    assertStringIncludes(fromEnv.message, RUN_MODE_ENV);
    assertStringIncludes(fromEnv.message, "removed");
    // Never coerced: a host that asked for a host-mode run must not be
    // silently run in the container it did not know it was getting.
    assert(!isRunMode(removed));
  }
  assertEquals([...REMOVED_RUN_MODES], ["native", "seatbelt"]);
});

Deno.test("run mode - case variants are rejected rather than normalised", () => {
  assertThrows(() =>
    resolveRunMode({ configured: "Container", env: emptyEnv })
  );
  assertThrows(() => parseRunMode("CONTAINER", "test"));
});

Deno.test("run mode - parseRunMode returns the mode and isRunMode guards it", () => {
  assertEquals(parseRunMode("container", "test"), "container");
  assert(isRunMode("container"));
  assert(!isRunMode("native"));
  assert(!isRunMode("podman"));
  assert(!isRunMode(undefined));
});

// ---------------------------------------------------------------------------
// No auto-fallback — a missing runtime never selects native
// ---------------------------------------------------------------------------

Deno.test("run mode - an absent container runtime never changes the result", () => {
  // An environment with no runtime reachable at all: an empty PATH, no
  // DOCKER_HOST, no CONTAINER_HOST. Container mode stays selected, so the
  // missing runtime stays the fatal error it is rather than a demotion to
  // any host-mode run (there is none).
  const noRuntime = envFrom({ PATH: "", HOME: "/tmp" });
  assertEquals(resolveRunMode({ env: noRuntime }), "container");
  assertEquals(
    resolveRunMode({ configured: "container", env: noRuntime }),
    "container",
  );
});

// ---------------------------------------------------------------------------
// The CLI contract `run.sh` will capture with $(...)
// ---------------------------------------------------------------------------

Deno.test("run-mode command - prints exactly the resolved mode with no configuration", async () => {
  const result = await runModeCommand.execute(
    { config: "/nonexistent/.config.json" },
    buildDefaultWorkerConfig(),
    emptyEnv,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "container");
});

Deno.test("run-mode command - reads run_mode out of the configuration file", async () => {
  const path = await configFileWith({ run_mode: "container" });
  try {
    const result = await runModeCommand.execute(
      { config: path },
      buildDefaultWorkerConfig(),
      emptyEnv,
    );
    assertEquals(result.success, true);
    assertEquals(result.message, "container");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - a configured removed mode fails loud with the removal explained (Issue #4)", async () => {
  const path = await configFileWith({ run_mode: "native" });
  try {
    const error = await assertRejects(
      () =>
        runModeCommand.execute(
          { config: path },
          buildDefaultWorkerConfig(),
          emptyEnv,
        ),
      Error,
    );
    assertStringIncludes(error.message, "removed");
    assertStringIncludes(error.message, "Issue #4");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - VIBE_RUN_MODE overrides the configuration file", async () => {
  const path = await configFileWith({ run_mode: "native" });
  try {
    const result = await runModeCommand.execute(
      { config: path },
      buildDefaultWorkerConfig(),
      envFrom({ [RUN_MODE_ENV]: "container" }),
    );
    assertEquals(result.message, "container");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - honours CONFIG_PATH when no --config is given", async () => {
  // A removed mode in the file CONFIG_PATH names is what proves the file
  // was read: the default alone would print container either way.
  const path = await configFileWith({ run_mode: "native" });
  try {
    const error = await assertRejects(
      () =>
        runModeCommand.execute(
          {},
          buildDefaultWorkerConfig(),
          envFrom({ CONFIG_PATH: path }),
        ),
      Error,
    );
    assertStringIncludes(error.message, "removed");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - an invalid configured value fails, leaving stdout empty", async () => {
  const path = await configFileWith({ run_mode: "vm" });
  try {
    // The command throws rather than returning a failure result: `mod.ts`
    // prints a returned message on stdout, which would corrupt the
    // `$(...)` capture in `run.sh`. A throw exits non-zero with the reason
    // on stderr instead.
    const error = await assertRejects(
      () =>
        runModeCommand.execute(
          { config: path },
          buildDefaultWorkerConfig(),
          emptyEnv,
        ),
      Error,
    );
    assertStringIncludes(error.message, "container");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - an invalid VIBE_RUN_MODE fails", async () => {
  const error = await assertRejects(
    () =>
      runModeCommand.execute(
        { config: "/nonexistent/.config.json" },
        buildDefaultWorkerConfig(),
        envFrom({ [RUN_MODE_ENV]: "host" }),
      ),
    Error,
  );
  assertStringIncludes(error.message, RUN_MODE_ENV);
});

Deno.test("run-mode command - a non-string run_mode fails rather than being ignored", async () => {
  const path = await configFileWith({ run_mode: true });
  try {
    const error = await assertRejects(
      () =>
        runModeCommand.execute(
          { config: path },
          buildDefaultWorkerConfig(),
          emptyEnv,
        ),
      Error,
    );
    assertStringIncludes(error.message, RUN_MODE_CONFIG_KEY);
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run-mode command - unparseable configuration fails rather than defaulting", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-run-mode-" });
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, "{ not json");
  try {
    const error = await assertRejects(
      () =>
        runModeCommand.execute(
          { config: path },
          buildDefaultWorkerConfig(),
          emptyEnv,
        ),
      Error,
    );
    assertStringIncludes(error.message, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run-mode command - is registered in the worker command registry", async () => {
  const { createDefaultRegistry } = await import("../mod.ts");
  const registry = createDefaultRegistry();
  assert(registry.has("run-mode"), "run-mode is not registered in mod.ts");
});

// ---------------------------------------------------------------------------
// Config surfaces
// ---------------------------------------------------------------------------

Deno.test("run mode - the default worker config carries the container default", () => {
  assertEquals(buildDefaultWorkerConfig().runMode, "container");
});

Deno.test("run mode - loadConfig resolves run_mode from the configuration file", async () => {
  const path = await configFileWith({ run_mode: "container" });
  try {
    const config = await loadConfig(path, { env: emptyEnv });
    assertEquals(config.runMode, "container");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run mode - loadConfig rejects a removed run_mode rather than coercing it (Issue #4)", async () => {
  const path = await configFileWith({ run_mode: "seatbelt" });
  try {
    const error = await assertRejects(
      () => loadConfig(path, { env: emptyEnv }),
      Error,
    );
    assertStringIncludes(error.message, "removed");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run mode - loadConfig defaults to container when run_mode is absent", async () => {
  const path = await configFileWith({});
  try {
    const config = await loadConfig(path, { env: emptyEnv });
    assertEquals(config.runMode, "container");
  } finally {
    await removeConfigFile(path);
  }
});

Deno.test("run mode - the worker logs the mode it resolved for the run", async () => {
  const lines: string[] = [];
  const config = {
    ...buildDefaultWorkerConfig(),
    runMode: "container" as const,
  };

  const result = await runWorker(
    {
      baseDir: "/repo",
      config,
      pid: 4242,
      env: (name: string) =>
        ({ HOME: "/home/worker", PATH: "/bin", WORK_DIR: "/work" })[name],
    },
    {
      evaluateRunGuard: () =>
        Promise.resolve({ action: "proceed", reason: "no PID file" }),
      claimPidFile: () => Promise.resolve(),
      bootstrap: () =>
        Promise.resolve({
          ok: true,
          env: {
            PATH: "/bin",
            VIBE_RUN_ID: "run-1",
            VIBE_SIDE_REPO_CLONE_ARGS: "",
            WORKER_LOG_FILE: "",
            LOG_FILE: "",
          },
          stepsRun: [],
          defaultBranch: "main",
        }),
      validateConfig: () => {},
      checkCredentials: () => Promise.resolve(null),
      resolveGithubUser: () => Promise.resolve("octocat"),
      assertIdentity: () => null,
      logGhScopes: () => Promise.resolve(),
      runHousekeeping: () => Promise.resolve(),
      runMainLoop: () =>
        Promise.resolve({ success: true, message: "planned shutdown" }),
      cleanup: () => Promise.resolve(),
      setEnv: () => {},
      log: (message: string) => lines.push(message),
      logError: () => {},
    },
  );

  assertEquals(result.outcome, "completed");
  assert(
    lines.some((line) => line.includes("run mode: container")),
    `expected the resolved run mode in the startup log, got: ${
      lines.join(" | ")
    }`,
  );
});

Deno.test("run mode - validateConfigFileJson accepts container and rejects anything else, naming a removed mode as removed", () => {
  for (const mode of RUN_MODES) {
    const result = validateConfigFileJson({ run_mode: mode });
    assertEquals(result.ok, true, `${mode} must be accepted`);
  }

  const invalid = validateConfigFileJson({ run_mode: "vm" });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) {
    assertEquals(invalid.error.field, RUN_MODE_CONFIG_KEY);
    assertStringIncludes(invalid.error.message, "container");
  }

  const removed = validateConfigFileJson({ run_mode: "native" });
  assertEquals(removed.ok, false);
  if (!removed.ok) {
    assertEquals(removed.error.field, RUN_MODE_CONFIG_KEY);
    assertStringIncludes(removed.error.message, "removed");
    assertStringIncludes(removed.error.message, "Issue #4");
  }

  const wrongType = validateConfigFileJson({ run_mode: 3 });
  assertEquals(wrongType.ok, false);
});

Deno.test("run mode - run_mode is a recognised configuration key", () => {
  assert(
    KNOWN_CONFIG_KEYS.has(RUN_MODE_CONFIG_KEY),
    "run_mode must be a known key or operators get a spurious unknown-key warning",
  );
});

// Issue #97: the "shell defaults carry the same container default" test was
// removed with worker/shared/config_defaults.sh. It was already stale since
// Issue #4 — the launchers read `mod.ts run-mode`, not the shell shim — so
// the shim's RUN_MODE default no longer feeds any launcher. `DEFAULT_RUN_MODE`
// remains the single source of truth, exercised by the tests above.
