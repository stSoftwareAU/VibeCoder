/**
 * The external orchestration gate parks a run before any provider call when
 * the executor could not be admitted to build (PR #4611 review of the
 * NEAT-AI-Discovery startup fix). A cargo checkout at 58.2 GB with the trim
 * refused is below the 46 GB floor plus 25 GB headroom, so the executor would
 * be parked after the manager's paid plan call; the run ends first instead.
 *
 * The ephemeral cargo root is an empty fake, so the real
 * `/var/tmp/vibe-cargo-target` is never read or pruned.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import type { ExternalIssueRunInput } from "../lib/execute_claude_phase.ts";
import {
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  type HeavyBuildDiskReading,
  HOST_DISK_PARK_NOTE,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import {
  type IssueRunGateDeps,
  runOrchestratedIssueRun,
} from "../lib/orchestration/issue_run_gate.ts";
import type { Result } from "../types.ts";

const GB = 1_073_741_824;
const REPO = "stSoftwareAU/NEAT-AI-Discovery";

const emptyRoot: EphemeralRootDeps = {
  listTargetDirs: () => Promise.resolve([]),
  removeDir: () => Promise.resolve(),
  nowMs: () => Date.now(),
};

/** A trim-refused reading with `freeGb` free against a 46 GB floor. */
function reading(freeGb: number): HeavyBuildDiskReading {
  return {
    status: {
      level: freeGb < 46 ? "low" : "ok",
      availableBytes: freeGb * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GB,
    trimRefused: true,
  };
}

/** One orchestrated run in a checkout holding `files`; returns the run and the provider calls. */
async function runAt(
  freeGb: number,
  files: Record<string, string>,
): Promise<{ run: Result<ClaudeRunResult>; calls: RunClaudeOptions[] }> {
  const dir = await Deno.makeTempDir({ prefix: "orch-park-2422-" });
  const calls: RunClaudeOptions[] = [];
  const deps: IssueRunGateDeps = {
    runClaudeWithRetry: (options) => {
      calls.push(options);
      return Promise.resolve({
        ok: true,
        value: {
          exitCode: 0,
          output: "step output",
          timedOut: false,
        },
      });
    },
    preflight: async () => {},
    stateDir: `${dir}/state`,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token", CODEX_HOME: `${dir}/codex` },
    now: () => 1_000,
    ephemeralRootDeps: emptyRoot,
  };
  const input: ExternalIssueRunInput = {
    claudeOptions: { prompt: "unused", cwd: dir },
    retryOptions: {},
    workDir: dir,
    repo: REPO,
    issueNumber: 2422,
    branch: "issue-2422-park",
    workspaceDir: dir,
    brief: "Fix the startup disk preflight",
    settings: {},
  };
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(reading(freeGb)));
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    return { run: await runOrchestratedIssueRun(input, deps), calls };
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
    await Deno.remove(dir, { recursive: true });
  }
}

const CARGO = { "Cargo.toml": '[package]\nname = "fixture"\n' };

Deno.test({
  name:
    "orchestrated run - a cargo checkout short of headroom ends before the manager call",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, env: true },
  async fn() {
    const { run, calls } = await runAt(58.2, CARGO);
    assert(!run.ok, "the run must end parked");
    assertStringIncludes(run.error.message, "headroom");
    assertStringIncludes(run.error.message, HOST_DISK_PARK_NOTE);
    assertEquals(calls.length, 0, "no provider call may be made");
  },
});

Deno.test({
  name:
    "orchestrated run - a host below its floor ends before the manager call",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, env: true },
  async fn() {
    const { run, calls } = await runAt(30, CARGO);
    assert(!run.ok, "the run must end parked");
    assertStringIncludes(run.error.message, HOST_DISK_PARK_NOTE);
    assertEquals(calls.length, 0);
  },
});

Deno.test({
  name:
    "orchestrated run - a cargo checkout with the full headroom, and a non-cargo checkout at 58.2 GB, still run",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, env: true },
  async fn() {
    const roomy = await runAt(72, CARGO);
    assert(roomy.run.ok, "72 GB covers the floor plus headroom");
    assert(roomy.calls.length > 0);
    const nonCargo = await runAt(58.2, { "deno.json": "{}" });
    assert(nonCargo.run.ok, "a non-cargo checkout is held to the floor only");
    assert(nonCargo.calls.length > 0);
  },
});
