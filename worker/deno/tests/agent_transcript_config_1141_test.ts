/**
 * The agent transcript tee is switched on from `.config.json` (Issue #1141).
 *
 * Every one of the twenty fleet run records archived on 2026-09-05 carried
 * `sessionLog.present: false` with the reason "the worker exported no
 * VIBECODER_SESSION_LOG_PATH (agent transcript tee not enabled for this
 * run)", because nothing anywhere set `VIBE_AGENT_TRANSCRIPT` and there was
 * no config key that could. A failed run therefore recorded its cost and its
 * duration and nothing about why it failed.
 *
 * These tests pin the switch that fixes that, and the two rules around it:
 *
 *   - `.config.json` is the **only** operator interface. `DEBUG=true` no
 *     longer turns raw content capture on as a side effect, and a host
 *     export cannot override what the file states.
 *   - The tee is **off by default**, so a deployment that does not ask keeps
 *     today's behaviour exactly.
 *
 * It also pins the two transcript call sites — the writer and the callback
 * context — to one shared directory helper, in both directions, so Issue
 * #873's platform-standard log directory has a single place to change rather
 * than two spellings that silently disagree.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  AGENT_TRANSCRIPT_ENV,
  agentTranscriptDir,
  agentTranscriptEnabled,
  agentTranscriptPath,
  maybeCreateAgentTranscriptWriter,
} from "../lib/agent_transcript.ts";
import { resolveSessionLogPath } from "../lib/run_callback_context.ts";
import { loadConfig } from "../lib/config.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runWorker, type RunWorkerDeps } from "../lib/run_worker.ts";
import type { BootstrapResult } from "../lib/run_bootstrap.ts";
import type { WorkerConfig } from "../types.ts";

/** An environment reader over a fixed map — never the host's own. */
function env(values: Record<string, string>): (name: string) => string {
  return (name: string) => values[name] as string;
}

/** Write a `.config.json` and load it, in a directory of this test's own. */
async function loadWith(
  contents: Record<string, unknown>,
): Promise<WorkerConfig> {
  const dir = await Deno.makeTempDir({ prefix: "transcript_config_1141_" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, JSON.stringify(contents));
    return await loadConfig(path);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The config key
// ---------------------------------------------------------------------------

Deno.test("agent transcript (#1141) - agent_transcript_enabled is a recognised config key", () => {
  assertEquals(
    KNOWN_CONFIG_KEYS.has("agent_transcript_enabled"),
    true,
    "an operator setting the documented key must not be warned it is unknown",
  );
});

Deno.test("agent transcript (#1141) - the key switches the tee on, and is off by default", async () => {
  assertEquals(
    (await loadWith({ repos: ["org/repo"] })).agentTranscriptEnabled,
    false,
    "default off: a deployment that does not ask keeps today's behaviour",
  );
  assertEquals(
    (await loadWith({ repos: ["org/repo"], agent_transcript_enabled: true }))
      .agentTranscriptEnabled,
    true,
  );
  assertEquals(
    (await loadWith({ repos: ["org/repo"], agent_transcript_enabled: false }))
      .agentTranscriptEnabled,
    false,
  );
});

Deno.test("agent transcript (#1141) - the default worker config leaves the tee off", () => {
  assertEquals(buildDefaultWorkerConfig().agentTranscriptEnabled, false);
});

// ---------------------------------------------------------------------------
// `DEBUG` no longer captures content
// ---------------------------------------------------------------------------

Deno.test("agent transcript (#1141) - DEBUG=true no longer enables raw content capture", () => {
  assertEquals(
    agentTranscriptEnabled(env({ DEBUG: "true" })),
    false,
    "a transcript is the raw agent stream (docs/CALLBACKS.md); DEBUG must " +
      "not turn content capture on as a side effect",
  );
  assertEquals(agentTranscriptEnabled(env({})), false);
  assertEquals(
    agentTranscriptEnabled(env({ [AGENT_TRANSCRIPT_ENV]: "1" })),
    false,
    'only the exact string "true" switches the tee on',
  );
});

// ---------------------------------------------------------------------------
// Config → the run environment, at worker start
// ---------------------------------------------------------------------------

/** A bootstrap result good enough for the driver to carry on past step 3. */
function okBootstrap(): BootstrapResult {
  return {
    ok: true,
    env: {
      PATH: "/bin",
      VIBE_RUN_ID: "vibe-testrun-1141",
      VIBE_SIDE_REPO_CLONE_ARGS: "",
      WORKER_LOG_FILE: "",
      LOG_FILE: "",
    },
    stepsRun: ["path", "run-id", "log-init", "default-branch"],
    defaultBranch: "main",
  };
}

/**
 * Drive a full worker run with every seam stubbed, and return the variables
 * the driver established. Nothing here touches the process environment: the
 * `setEnv` seam records instead (Issue #967).
 */
async function establishedEnv(
  config: WorkerConfig,
  ambient: Record<string, string> = {},
): Promise<Record<string, string>> {
  const setEnv: Record<string, string> = {};
  const deps: Partial<RunWorkerDeps> = {
    evaluateRunGuard: () =>
      Promise.resolve({ action: "proceed", reason: "no PID file" }),
    claimPidFile: () => Promise.resolve(),
    bootstrap: () => Promise.resolve(okBootstrap()),
    validateConfig: () => {},
    checkCredentials: () => Promise.resolve(null),
    resolveGithubUser: () => Promise.resolve("octocat"),
    assertIdentity: () => null,
    logGhScopes: () => Promise.resolve(),
    runHousekeeping: () => Promise.resolve(),
    runMainLoop: () =>
      Promise.resolve({ success: true, message: "planned shutdown" }),
    declareQuotaPause: () => Promise.resolve(),
    cleanup: () => Promise.resolve(),
    applyOptionalFeatureEnv: () => Promise.resolve({}),
    setEnv: (name, value) => {
      setEnv[name] = value;
    },
    log: () => {},
    logError: () => {},
  };
  await runWorker({
    baseDir: "/repo",
    config,
    pid: 4242,
    env: env({
      HOME: "/home/worker",
      PATH: "/bin",
      WORK_DIR: "/work",
      ...ambient,
    }),
  }, deps);
  return setEnv;
}

Deno.test("agent transcript (#1141) - the driver exports the config decision into the run", async () => {
  const on = buildDefaultWorkerConfig();
  on.agentTranscriptEnabled = true;
  assertEquals((await establishedEnv(on))[AGENT_TRANSCRIPT_ENV], "true");

  const off = buildDefaultWorkerConfig();
  off.agentTranscriptEnabled = false;
  assertEquals((await establishedEnv(off))[AGENT_TRANSCRIPT_ENV], "false");
});

Deno.test("agent transcript (#1141) - a host export cannot override what the config states", async () => {
  const off = buildDefaultWorkerConfig();
  off.agentTranscriptEnabled = false;
  const established = await establishedEnv(off, {
    [AGENT_TRANSCRIPT_ENV]: "true",
    DEBUG: "true",
  });
  assertEquals(
    established[AGENT_TRANSCRIPT_ENV],
    "false",
    ".config.json is the only operator switch, so the driver settles the " +
      "variable unconditionally rather than deferring to an ambient value",
  );
});

// ---------------------------------------------------------------------------
// The tee, and the callback context that publishes it
// ---------------------------------------------------------------------------

Deno.test("agent transcript (#1141) - enabled writes a transcript, disabled writes nothing", async () => {
  const home = await Deno.makeTempDir({ prefix: "transcript_home_1141_" });
  try {
    const values = {
      HOME: home,
      VIBE_RUN_ID: "vibe-testrun-1141",
    } as Record<string, string>;

    assertEquals(
      maybeCreateAgentTranscriptWriter({ env: env(values), issueNumber: 1141 }),
      undefined,
      "off is off: nothing is created and nothing is written",
    );

    values[AGENT_TRANSCRIPT_ENV] = "true";
    const writer = maybeCreateAgentTranscriptWriter({
      env: env(values),
      issueNumber: 1141,
    });
    assert(writer, "the tee must exist once the config switched it on");
    writer.feed('{"type":"assistant"}\n');
    writer.close();
    assertEquals(
      await Deno.readTextFile(writer.filePath),
      '{"type":"assistant"}\n',
    );

    // The path the callback publishes is the path the tee actually wrote.
    assertEquals(
      resolveSessionLogPath(
        { runId: "vibe-testrun-1141", host: "h", home },
        1141,
        { transcriptEnabled: () => true },
      ),
      writer.filePath,
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("agent transcript (#1141) - with the tee off the callback context carries no transcript", () => {
  assertEquals(
    resolveSessionLogPath(
      { runId: "vibe-testrun-1141", host: "h", home: "/home/vibe" },
      1141,
      { transcriptEnabled: () => false, exists: () => true },
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// One directory, not two spellings (Issue #873's landing ground)
// ---------------------------------------------------------------------------

Deno.test("agent transcript (#1141) - the writer and the callback resolve one shared directory", async () => {
  const home = await Deno.makeTempDir({ prefix: "transcript_dir_1141_" });
  try {
    const writer = maybeCreateAgentTranscriptWriter({
      env: env({
        [AGENT_TRANSCRIPT_ENV]: "true",
        HOME: home,
        VIBE_RUN_ID: "vibe-testrun-1141",
      }),
      issueNumber: 873,
    });
    assert(writer);
    const published = resolveSessionLogPath(
      { runId: "vibe-testrun-1141", host: "h", home },
      873,
      { transcriptEnabled: () => true, exists: () => true },
    );

    // Both directions: each call site agrees with the helper, so moving the
    // helper moves both and moving only one of them fails here.
    const expected = agentTranscriptPath(
      agentTranscriptDir(home),
      "vibe-testrun-1141",
      873,
    );
    assertEquals(writer.filePath, expected);
    assertEquals(published, expected);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});
