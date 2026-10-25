/**
 * The production `reportHardKills` wiring (Issue #4254).
 *
 * Exercises the real deps object with the host log directory taken from an
 * injected environment, so no operator directory is read. With no evidence
 * present the hook completes quietly; with no HOME it skips and says so.
 *
 * The end-to-end tests drive the same real deps object over an evidence file
 * in a temporary HOME, with an injected `gh` runner and real hook executables.
 * They prove the wiring the reporter depends on: the issue is filed once, the
 * `failure` hook runs once with class `hard_kill` and the killed run's id, the
 * kill is counted as one fleet failure, and the file is removed only after
 * that. A failed filing keeps the file and fires no hook.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createProductionRunCoreDeps,
  type ProductionDepsOptions,
} from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { noCallbacks } from "../lib/run_callbacks_config.ts";
import { envFrom } from "./support/env_lookup.ts";
import {
  HARD_KILL_EVIDENCE_VERSION,
  type HardKillEvidence,
} from "../lib/hard_kill_evidence.ts";
import { hardKillSignature } from "../lib/hard_kill_report.ts";
import type { SelfDiagnosticFiling } from "../lib/self_diagnostic_attestation.ts";
import { formatRunFailureMarker } from "../lib/run_failure_issue.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";

function optionsWith(
  env: ReturnType<typeof envFrom>,
  logger = createLogger({ write: () => {} }),
): ProductionDepsOptions {
  return {
    repoDir: "/tmp/test-repo",
    workDir: "/tmp/test-work",
    githubUser: "test-user",
    logger,
    config: buildDefaultWorkerConfig(),
    env,
  };
}

const CONTAINER = "vibe-coder-4254-test";
const RUN_ID = "vibe-abc123-0f0f0f";
const CAPTURED_AT = "2026-10-25T01:02:03.000Z";
const LOG_LINE =
  "[2026-10-25T01:00:00Z] [phase] execute (stSoftwareAU/VibeCoder#4254)";

/** A valid evidence record for a run wedged in `execute`. */
function evidenceRecord(): HardKillEvidence {
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt: CAPTURED_AT,
    host: "test-host",
    container: CONTAINER,
    runId: RUN_ID,
    trigger: "watchdog",
    reason: "the launcher's 8100s watchdog deadline expired",
    lastLogLine: LOG_LINE,
    lastLogTimestamp: "2026-10-25T01:00:00Z",
    lastToolCall: "none",
    evidence: {
      workerLogTail: `[2026-10-25T00:59:00Z] starting\n${LOG_LINE}`,
      agentTranscriptTail: "",
      bootLogs: "",
      guest: {
        ps: "",
        meminfo: "",
        pressureCpu: "",
        pressureMemory: "",
        pressureIo: "",
      },
    },
  };
}

/** Write the evidence file under `<home>/logs`; returns its path. */
async function writeEvidence(home: string): Promise<string> {
  const dir = `${home}/logs`;
  await Deno.mkdir(dir, { recursive: true });
  const epoch = Math.floor(Date.parse(CAPTURED_AT) / 1000);
  const path = `${dir}/hard-kill-${CONTAINER}-${epoch}.json`;
  await Deno.writeTextFile(path, JSON.stringify(evidenceRecord()));
  return path;
}

/**
 * Two executable hooks. Each appends `<event>:<failureClass>:<runId>` to one
 * shared file, so the file records every hook call in the order it ran.
 */
async function writeHooks(
  dir: string,
): Promise<{ failure: string; always: string; calls: string }> {
  const calls = `${dir}/calls.txt`;
  const hook = async (name: string): Promise<string> => {
    const path = `${dir}/${name}.sh`;
    await Deno.writeTextFile(
      path,
      `#!/bin/sh\nprintf '%s:%s:%s\\n' "$VIBECODER_CALLBACK_EVENT" "$VIBECODER_OUTCOME_FAILURE_CLASS" "$VIBECODER_RUN_ID" >> '${calls}'\n`,
      { mode: 0o700 },
    );
    await Deno.chmod(path, 0o700);
    return path;
  };
  return {
    failure: await hook("failure"),
    always: await hook("always"),
    calls,
  };
}

/** A fake `gh`: an empty dedup search, then a created issue #777. */
function fakeGh(createFails: boolean): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "create") {
      return createFails
        ? Promise.reject(new Error("gh: HTTP 502"))
        : Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/issues/777\n",
        );
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { fn, calls };
}

/**
 * A fake attestation recorder: records each filing and reports it reached the
 * audit chain, so no test appends to the host's real audit journal.
 */
function fakeRecorder(): {
  fn: (filing: SelfDiagnosticFiling) => Promise<boolean>;
  calls: SelfDiagnosticFiling[];
} {
  const calls: SelfDiagnosticFiling[] = [];
  const fn = (filing: SelfDiagnosticFiling): Promise<boolean> => {
    calls.push(filing);
    return Promise.resolve(true);
  };
  return { fn, calls };
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Non-empty lines of a file; none when the file was never written. */
async function linesOf(path: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(path);
    return text.split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

Deno.test("reportHardKills - no evidence under HOME completes without throwing (Issue #4254)", async () => {
  const home = await Deno.makeTempDir();
  try {
    const { deps, cleanup } = await createProductionRunCoreDeps(
      optionsWith(envFrom({ HOME: home })),
    );
    try {
      assertEquals(typeof deps.reportHardKills, "function");
      await deps.reportHardKills!();
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("reportHardKills - no HOME skips with an info line and does not throw (Issue #4254)", async () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (message) => lines.push(message) });
  const { deps, cleanup } = await createProductionRunCoreDeps(
    optionsWith(envFrom({}), logger),
  );
  try {
    await deps.reportHardKills!();
  } finally {
    cleanup();
  }
  assert(
    lines.some((line) => line.includes("Hard-kill reporting skipped")),
    lines.join("\n"),
  );
});

Deno.test("reportHardKills - files one issue, runs the failure hook with hard_kill, counts one failure and removes the evidence (Issue #4254)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-4254-hard-kill-" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  const hooksDir = `${root}/hooks`;
  const gh = fakeGh(false);
  const recorder = fakeRecorder();
  const lines: string[] = [];
  startFleetTelemetry();
  try {
    await Deno.mkdir(work, { recursive: true });
    await Deno.mkdir(hooksDir, { recursive: true });
    const evidencePath = await writeEvidence(home);
    const hooks = await writeHooks(hooksDir);
    const config = buildDefaultWorkerConfig();
    config.workDir = work;
    config.callbacks = {
      ...noCallbacks(),
      failure: hooks.failure,
      always: hooks.always,
    };
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: work,
      workDir: work,
      githubUser: "test-user",
      logger: createLogger({ write: (message) => lines.push(message) }),
      config,
      env: envFrom({ HOME: home }),
      hardKillGhFn: gh.fn,
      hardKillRecordFiling: recorder.fn,
    });
    try {
      await deps.reportHardKills!();
    } finally {
      cleanup();
    }

    const creates = gh.calls.filter((a) =>
      a[0] === "issue" && a[1] === "create"
    );
    assertEquals(creates.length, 1, JSON.stringify(gh.calls));
    const createArgs = creates[0]!;
    const body = createArgs[createArgs.indexOf("--body") + 1] ?? "";
    const failureClass = hardKillSignature(evidenceRecord()).failureClass;
    assert(
      body.includes(formatRunFailureMarker(failureClass)),
      `issue body lacks the marker for ${failureClass}`,
    );

    // The failure hook runs once, then `always`, both for the killed run.
    assertEquals(await linesOf(hooks.calls), [
      `failure:hard_kill:${RUN_ID}`,
      `always:hard_kill:${RUN_ID}`,
    ]);
    assertEquals(await exists(evidencePath), false);
    assertEquals(getFleetTelemetry().failures, 1);

    // The filing goes through the injected recorder, never the real journal.
    assertEquals(recorder.calls.length, 1, JSON.stringify(recorder.calls));
    assertEquals(recorder.calls[0]!.familyId, "run-failure");
    assertEquals(recorder.calls[0]!.repo, "stSoftwareAU/VibeCoder");
    assert(
      lines.some((line) =>
        line.includes(
          "Hard-kill reporting: found 1, reported 1, kept 0 for the next start (Issue #4254).",
        )
      ),
      lines.join("\n"),
    );
  } finally {
    resetFleetTelemetry();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reportHardKills - a failed filing keeps the evidence, fires no hook and counts no failure (Issue #4254)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-4254-hard-kill-" });
  const home = `${root}/home`;
  const work = `${root}/work`;
  const hooksDir = `${root}/hooks`;
  const gh = fakeGh(true);
  const recorder = fakeRecorder();
  startFleetTelemetry();
  try {
    await Deno.mkdir(work, { recursive: true });
    await Deno.mkdir(hooksDir, { recursive: true });
    const evidencePath = await writeEvidence(home);
    const hooks = await writeHooks(hooksDir);
    const config = buildDefaultWorkerConfig();
    config.workDir = work;
    config.callbacks = {
      ...noCallbacks(),
      failure: hooks.failure,
      always: hooks.always,
    };
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: work,
      workDir: work,
      githubUser: "test-user",
      logger: createLogger({ write: () => {} }),
      config,
      env: envFrom({ HOME: home }),
      hardKillGhFn: gh.fn,
      hardKillRecordFiling: recorder.fn,
    });
    try {
      await deps.reportHardKills!();
    } finally {
      cleanup();
    }

    assert(gh.calls.some((a) => a[0] === "issue" && a[1] === "create"));
    assertEquals(await exists(evidencePath), true);
    assertEquals(await linesOf(hooks.calls), []);
    assertEquals(getFleetTelemetry().failures, 0);
    assertEquals(recorder.calls.length, 0, JSON.stringify(recorder.calls));
  } finally {
    resetFleetTelemetry();
    await Deno.remove(root, { recursive: true });
  }
});
