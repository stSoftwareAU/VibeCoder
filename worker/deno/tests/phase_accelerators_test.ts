/**
 * Tests for `preparePhaseAccelerators` (Issue #2569).
 *
 * The one preparation clarity, refinement, revision and quorum share: Graft,
 * CodeGraph and RTK prepared once per run, folded into the prompt and spawn
 * options, and reported for the run's stats comment.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { preparePhaseAccelerators } from "../lib/phase_accelerators.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import {
  type CollectGraftContextOptions,
  GRAFT_PROMPT_LINE,
  type GraftContextResult,
} from "../lib/graft_context.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
} from "../lib/codegraph_context.ts";
import { RTK_PROMPT_LINE } from "../lib/rtk_output.ts";
import {
  rtkGain,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
  rtkVersion,
} from "./support/rtk_seam.ts";

const silent = { info: () => {}, warn: () => {} };

const OK_GRAFT: GraftContextResult = {
  status: "ok",
  enabled: true,
  buildSeconds: 1,
  bundleChars: 30,
  nodeCount: 10,
  callEdgeCount: 5,
  bundle: "export function parseDate() {}",
};

/** Prepare against scripted seams; returns the helper and what it asked for. */
async function prepare(
  graft: GraftContextResult,
  codegraph: CodegraphContextResult,
  seam: RtkSeam,
  flags: { rtk: boolean; codegraph: boolean } = { rtk: true, codegraph: true },
) {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/phase-accel-2569";
  config.rtkOutput = { enabled: flags.rtk };
  config.codegraphContext = { enabled: flags.codegraph };
  const collected: CollectGraftContextOptions[] = [];
  const accel = await preparePhaseAccelerators({
    config,
    repo: "org/repo",
    issueNumber: 7,
    issueTitle: "Fix the date parser",
    issueBody: "parseDate drops the timezone.",
    claude: {
      prepareCodegraphContext: () => Promise.resolve(codegraph),
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => CLAUDE_PROVIDER_ID,
    },
    logger: silent,
    collectGraftContext: (options) => {
      collected.push(options);
      return Promise.resolve({ ...graft });
    },
  });
  return { accel, collected, seam };
}

Deno.test("preparePhaseAccelerators - all three healthy wire the prompt, both MCP servers and the hook", async () => {
  const { accel, collected, seam } = await prepare(
    OK_GRAFT,
    { status: "ok", enabled: true, nodeCount: 500 },
    rtkSeam([rtkVersion(), rtkGain(100), rtkGain(150)]),
  );

  assertEquals(collected.length, 1, "one collection per run");
  assertEquals(collected[0]?.repoDir, "/tmp/phase-accel-2569/repo");
  assertStringIncludes(collected[0]?.query ?? "", "Fix the date parser");
  assertEquals(seam.prepared[0]?.cwd, "/tmp/phase-accel-2569/repo");

  const prompt = accel.applyPrompt("Base prompt.");
  assert(prompt.startsWith(GRAFT_PROMPT_LINE), "Graft's rule goes first");
  assertStringIncludes(prompt, "Base prompt.");
  assertStringIncludes(prompt, "export function parseDate() {}");
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assert(prompt.endsWith(RTK_PROMPT_LINE), "RTK's rule goes last");

  const options = accel.spawnOptions();
  const mcp = options.mcpConfig as {
    servers?: Record<string, { command?: string }>;
  };
  assertEquals(mcp.servers?.graft?.command, "graft");
  assert(mcp.servers?.codegraph !== undefined);
  assert(typeof options.settingsJson === "string");

  await accel.afterSpawn();
  assertEquals(accel.report().rtk.status, "ok");
  assertEquals(accel.report().rtk.savedTokens, 50);
});

Deno.test("preparePhaseAccelerators - all off leaves the prompt and spawn untouched", async () => {
  const { accel } = await prepare(
    { status: "off", enabled: false },
    { status: "off", enabled: false },
    rtkSeam([]),
    { rtk: false, codegraph: false },
  );

  assertEquals(accel.applyPrompt("Base prompt."), "Base prompt.");
  assertEquals(accel.spawnOptions(), {});
  await accel.afterSpawn();
  const report = accel.report();
  assertEquals(report.graft.status, "off");
  assertEquals(report.codegraph.status, "off");
  assertEquals(report.rtk.status, "off");
});

Deno.test("preparePhaseAccelerators - failed Graft and a missing rtk degrade without throwing", async () => {
  const { accel } = await prepare(
    {
      status: "failed",
      enabled: true,
      buildSeconds: 300,
      nodeCount: 0,
      callEdgeCount: 0,
    },
    { status: "off", enabled: false },
    rtkSeam([rtkMissing()]),
    { rtk: true, codegraph: false },
  );

  const prompt = accel.applyPrompt("Base prompt.");
  assertEquals(prompt.includes(GRAFT_PROMPT_LINE), false);
  assertEquals(prompt.includes(RTK_PROMPT_LINE), false);
  assertEquals(accel.spawnOptions(), {});
  assertEquals(accel.report().graft.status, "failed");
  assertEquals(accel.report().rtk.status, "failed");
});

Deno.test("preparePhaseAccelerators - recordSuccess tallies Graft queries across invocations", async () => {
  const { accel } = await prepare(
    OK_GRAFT,
    { status: "off", enabled: false },
    rtkSeam([]),
    { rtk: false, codegraph: false },
  );

  accel.recordSuccess({ toolCallCounts: { mcp__graft__graft_find_code: 3 } });
  accel.recordSuccess({ toolCallCounts: { mcp__graft__graft_file_api: 2 } });
  assertEquals(accel.report().graft.queries, 5);
});
