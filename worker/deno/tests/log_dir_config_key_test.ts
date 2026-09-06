/**
 * The log directory is pinned from `.config.json`, not from the environment
 * (Issue #873).
 *
 * Host-side operator configuration lives in `.config.json`. Before this suite
 * the only way to pin the log directory was `LAUNCH_LOG_DIR` or `LOG_DIR` — a
 * host environment variable — so a deployment that keeps its logs somewhere
 * other than the platform default could not say so in the file the rest of its
 * configuration lives in. `log_dir` is that key.
 *
 * The precedence the whole fleet shares: **`log_dir` wins, then the platform
 * default.** The two variables that used to sit between them, `LAUNCH_LOG_DIR`
 * and `LOG_DIR`, are ignored since Issue #1388 — on the host, `.config.json`
 * is the only configuration — and a host still exporting one is told so by
 * name.
 *
 * What this suite pins beyond the precedence itself:
 *
 *  - the launcher (`mod.ts log-dir`, which `run.sh`, `loop.sh` and `run.ps1`
 *    capture) and the worker (the container's writable log mount) resolve the
 *    **same** directory from the same key, so `launch-*.log` and
 *    `worker-*.log` cannot land in two places;
 *  - log compression keeps working on the pinned directory, because the
 *    cleanup and the gzip pass operate on the directory they are handed rather
 *    than on a re-spelled default.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  defaultLogDir,
  ignoredLogDirEnvNotice,
  legacyLogDirNotice,
  LOG_DIR_CONFIG_KEY,
  readConfiguredLogDir,
  readConfiguredLogDirSync,
  resolveLogDir,
} from "../lib/log_dir.ts";
import { logDirCommand, resolveLogDirForCommand } from "../commands/log_dir.ts";
import { resolveContainerLaunchHostPaths } from "../lib/container_launch.ts";
import { cleanupWorkerLogs } from "../lib/worker_log_cleanup.ts";
import { gzipOldWorkerLogs } from "../lib/worker_log_gzip.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { validateConfigFileJson } from "../lib/validation.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const envFrom =
  (vars: Record<string, string>) => (name: string): string | undefined =>
    vars[name];

/** Write a `.config.json` holding exactly the given keys. */
async function writeConfig(
  dir: string,
  data: Record<string, unknown>,
): Promise<string> {
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  return path;
}

// --- The key itself -------------------------------------------------------

Deno.test("log_dir - the config key pins the directory (Issue #873)", () => {
  assertEquals(LOG_DIR_CONFIG_KEY, "log_dir");
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({}),
      "posix",
      "linux",
      "/srv/vibe-logs",
    ),
    "/srv/vibe-logs",
  );
});

Deno.test("log_dir - the config key expands a leading ~, as every path key does", () => {
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({}), "posix", "linux", "~/logs"),
    "/home/vibe/logs",
  );
  assertEquals(
    resolveLogDir("/home/vibe", envFrom({}), "posix", "linux", "~"),
    "/home/vibe",
  );
});

Deno.test("log_dir - the config key wins over both environment names", () => {
  const env = envFrom({
    LAUNCH_LOG_DIR: "/var/launch-logs",
    LOG_DIR: "/var/log/vibe-coder",
  });
  assertEquals(
    resolveLogDir("/home/vibe", env, "posix", "linux", "/srv/vibe-logs"),
    "/srv/vibe-logs",
  );
});

Deno.test("log_dir - absent the key, the environment names are ignored (Issue #1388)", () => {
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({ LOG_DIR: "/var/log/vibe-coder" }),
      "posix",
      "linux",
    ),
    "/home/vibe/.local/state/vibe-coder",
  );
  assertEquals(
    resolveLogDir(
      "/home/vibe",
      envFrom({
        LAUNCH_LOG_DIR: "/var/launch-logs",
        LOG_DIR: "/var/log/vibe-coder",
      }),
      "posix",
      "linux",
      "",
    ),
    "/home/vibe/.local/state/vibe-coder",
    "a blank config value means unset, and the variables do not fill the gap",
  );
});

Deno.test("log_dir - a still-exported variable is named, with the line to write instead (Issue #1388)", () => {
  assertEquals(ignoredLogDirEnvNotice(envFrom({})), undefined);
  assertEquals(
    ignoredLogDirEnvNotice(envFrom({ LOG_DIR: "   " })),
    undefined,
    "a blank export never moved anything, so it is not worth a line",
  );
  const one = ignoredLogDirEnvNotice(
    envFrom({ LOG_DIR: "/var/log/vibe-coder" }),
  ) ?? "";
  assertStringIncludes(one, 'LOG_DIR="/var/log/vibe-coder" is set but ignored');
  assertStringIncludes(one, '"log_dir": "/var/log/vibe-coder"');
  assertStringIncludes(one, "Issue #1388");
  const both = ignoredLogDirEnvNotice(
    envFrom({ LAUNCH_LOG_DIR: "/var/launch-logs", LOG_DIR: "/var/log/vibe" }),
  ) ?? "";
  assertStringIncludes(both, 'LAUNCH_LOG_DIR="/var/launch-logs"');
  assertStringIncludes(both, 'LOG_DIR="/var/log/vibe"');
  assertStringIncludes(both, "are set but ignored");
});

Deno.test("log_dir - absent the key and the variables, the platform default applies", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assertEquals(
      resolveLogDir("/home/vibe", envFrom({}), "posix", platform, "   "),
      defaultLogDir("/home/vibe", envFrom({}), "posix", platform),
    );
  }
});

Deno.test("log_dir - a relative value is refused, naming the key", () => {
  const error = assertThrows(
    () => resolveLogDir("/home/vibe", envFrom({}), "posix", "linux", "logs"),
    Error,
  );
  assert(
    error.message.includes(LOG_DIR_CONFIG_KEY),
    `the message must name the key: ${error.message}`,
  );
  assert(
    error.message.includes("logs"),
    `the message must quote the offending value: ${error.message}`,
  );
});

Deno.test("log_dir - a pinned directory silences the legacy-default notice", () => {
  assertEquals(
    legacyLogDirNotice({
      home: "/home/vibe",
      env: envFrom({}),
      style: "posix",
      platform: "linux",
      exists: () => true,
      configured: "/srv/vibe-logs",
    }),
    undefined,
    "the location is the operator's own choice; there is nothing to migrate",
  );
});

// --- Reading it out of the file -------------------------------------------

Deno.test("log_dir - readConfiguredLogDir reads the key from .config.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-read-" });
  try {
    const path = await writeConfig(dir, { log_dir: "~/logs", repos: ["a/b"] });
    assertEquals(await readConfiguredLogDir(path), "~/logs");
    assertEquals(readConfiguredLogDirSync(path), "~/logs");

    const without = await writeConfig(dir, { repos: ["a/b"] });
    assertEquals(await readConfiguredLogDir(without), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("log_dir - a missing config file is not a pinned directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-missing-" });
  try {
    assertEquals(await readConfiguredLogDir(`${dir}/.config.json`), undefined);
    assertEquals(readConfiguredLogDirSync(`${dir}/.config.json`), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("log_dir - a broken config file fails loud rather than defaulting", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-broken-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, "{ not json");
    await assertRejects(() => readConfiguredLogDir(path), Error);

    await Deno.writeTextFile(path, JSON.stringify({ log_dir: 42 }));
    await assertRejects(() => readConfiguredLogDir(path), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- The launcher and the worker agree ------------------------------------

Deno.test("log_dir - the launcher and the container mount resolve the same directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-parity-" });
  try {
    const configFile = await writeConfig(dir, { log_dir: "~/logs" });
    const env = envFrom({ HOME: "/home/vibe", CONFIG_FILE: configFile });

    // What run.sh / loop.sh / run.ps1 capture from `mod.ts log-dir`.
    const launcher = await resolveLogDirForCommand({
      env,
      platform: "linux",
      exists: () => false,
      configFile,
    });

    // What the container's writable log mount points at — where every
    // `worker-*.log` is actually written.
    const hostPaths = resolveContainerLaunchHostPaths(
      "/opt/vibe-coder",
      env,
      "posix",
      "linux",
      await readConfiguredLogDir(configFile),
    );

    assertEquals(launcher.logDir, "/home/vibe/logs");
    assertEquals(
      hostPaths.logDir,
      launcher.logDir,
      "launch-*.log and worker-*.log must land in one directory",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("log_dir - the launcher ignores the variables and says so, then takes the default", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-fallback-" });
  try {
    const configFile = await writeConfig(dir, { repos: ["a/b"] });
    const withEnv = await resolveLogDirForCommand({
      env: envFrom({
        HOME: "/home/vibe",
        LOG_DIR: "/var/log/vibe-coder",
        CONFIG_FILE: configFile,
      }),
      platform: "linux",
      exists: () => false,
      configFile,
    });
    assertEquals(withEnv.logDir, "/home/vibe/.local/state/vibe-coder");
    assertStringIncludes(
      withEnv.ignoredEnvironment ?? "",
      'LOG_DIR="/var/log/vibe-coder" is set but ignored',
      "the launcher tells the operator, by name, what it ignored",
    );

    const bare = await resolveLogDirForCommand({
      env: envFrom({ HOME: "/home/vibe", CONFIG_FILE: configFile }),
      platform: "linux",
      exists: () => false,
      configFile,
    });
    assertEquals(bare.logDir, "/home/vibe/.local/state/vibe-coder");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Compression still happens where the logs actually are ----------------

Deno.test("log_dir - compression and retention run on the pinned directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "logdir-gzip-" });
  try {
    const pinned = `${root}/pinned-logs`;
    await Deno.mkdir(pinned);
    const configFile = await writeConfig(root, { log_dir: pinned });
    const env = envFrom({ HOME: root, CONFIG_FILE: configFile });

    const resolved = resolveLogDir(
      root,
      env,
      "posix",
      "linux",
      await readConfiguredLogDir(configFile),
    );
    assertEquals(resolved, pinned, "the pinned directory is the resolved one");

    // A prior run's log, and the current one.
    const prior = `${resolved}/worker-20260101-000000.log`;
    const current = `${resolved}/worker-20260102-000000.log`;
    await Deno.writeTextFile(prior, "x".repeat(4096));
    await Deno.writeTextFile(current, "y".repeat(4096));

    const gzip = await gzipOldWorkerLogs(resolved, { currentLogFile: current });
    assertEquals(gzip.failures, []);
    assertEquals(gzip.compressed, [`${prior}.gz`]);

    // Retention keeps the compressed history: it must not strip the `.gz`
    // files just because the directory was pinned rather than defaulted.
    const cleanup = await cleanupWorkerLogs(resolved);
    assertEquals(cleanup.deleted, []);
    const remaining = new Set<string>();
    for await (const entry of Deno.readDir(resolved)) remaining.add(entry.name);
    assert(
      remaining.has("worker-20260101-000000.log.gz"),
      `the compressed prior log survived: ${[...remaining].join(", ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- Registered, validated, and reachable through the command -------------

Deno.test("log_dir - is a recognised config key", () => {
  assert(
    KNOWN_CONFIG_KEYS.has(LOG_DIR_CONFIG_KEY),
    "an unregistered key earns the operator a spurious unknown-key warning",
  );
  assertEquals(detectUnknownConfigKeys({ log_dir: "~/logs" }), []);
});

Deno.test("log_dir - the config validator refuses a value that is not a path", () => {
  const notAString = validateConfigFileJson({ log_dir: 42 });
  assertEquals(notAString.ok, false);

  const relative = validateConfigFileJson({ log_dir: "logs" });
  assertEquals(relative.ok, false);
  if (!relative.ok) {
    assertEquals(relative.error.field, LOG_DIR_CONFIG_KEY);
    assert(
      relative.error.message.includes("absolute"),
      `the message must say what is wanted: ${relative.error.message}`,
    );
  }

  assertEquals(validateConfigFileJson({ log_dir: "~/logs" }).ok, true);
  assertEquals(validateConfigFileJson({ log_dir: "/srv/logs" }).ok, true);
});

Deno.test("log_dir - the log-dir command reports the configured directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "logdir-command-" });
  try {
    const configFile = await writeConfig(dir, { log_dir: `${dir}/pinned` });
    const result = await logDirCommand.execute(
      { config: configFile },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(result.message, `${dir}/pinned`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
