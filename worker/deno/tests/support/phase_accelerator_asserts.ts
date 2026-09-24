/**
 * Shared fixtures and assertions for the Graft, CodeGraph and RTK phase wiring
 * tests (Issue #2569).
 *
 * Clarity, refinement, revision and quorum carry the same three accelerators
 * under the same contract, so their tests assert it with the same words.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CollectGraftContextOptions,
  GRAFT_PROMPT_LINE,
  type GraftContextCollector,
  type GraftContextResult,
} from "../../lib/graft_context.ts";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
} from "../../lib/codegraph_context.ts";
import { assertCarriesRtkHook, type SpawnOptions } from "./rtk_wiring_asserts.ts";

/** The bundle text an `ok` collection returns. */
export const GRAFT_BUNDLE = "export function parseDate() {}";

/** An `ok` Graft collection. */
export function okGraftOutcome(): GraftContextResult {
  return {
    status: "ok",
    enabled: true,
    buildSeconds: 12.5,
    bundleChars: GRAFT_BUNDLE.length,
    nodeCount: 820,
    callEdgeCount: 1204,
    bundle: GRAFT_BUNDLE,
  };
}

/** A switched-off Graft context. */
export function offGraftOutcome(): GraftContextResult {
  return { status: "off", enabled: false };
}

/** An `ok` CodeGraph preparation. */
export function okCodegraphOutcome(): CodegraphContextResult {
  return { status: "ok", enabled: true, nodeCount: 500 };
}

/** A switched-off CodeGraph context. */
export function offCodegraphOutcome(): CodegraphContextResult {
  return { status: "off", enabled: false };
}

/** A Graft collector that records every collection it is asked for. */
export function recordingCollector(outcome: GraftContextResult): {
  collect: GraftContextCollector;
  collected: CollectGraftContextOptions[];
} {
  const collected: CollectGraftContextOptions[] = [];
  return {
    collected,
    collect: (options) => {
      collected.push(options);
      return Promise.resolve({ ...outcome });
    },
  };
}

/** Run stats from a healthy spawn that made three Graft queries. */
export function graftQueryingRunStats(): {
  servedModels: string[];
  requestedModel: string;
  wallClockMs: number;
  toolCallCounts: Record<string, number>;
} {
  return {
    servedModels: [],
    requestedModel: "opus",
    wallClockMs: 1,
    toolCallCounts: { mcp__graft__graft_find_code: 3, Bash: 2 },
  };
}

/** Assert one spawn carries all three accelerators. */
export function assertAcceleratedSpawn(
  spawn: SpawnOptions | undefined,
  workDir: string,
): void {
  assert(spawn, "expected an agent invocation");
  assertEquals(spawn.cwd, workDir, "the MCP config is written under cwd");
  const prompt = String(spawn.prompt);
  assertStringIncludes(prompt, GRAFT_BUNDLE);
  assertStringIncludes(prompt, GRAFT_PROMPT_LINE);
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertCarriesRtkHook(spawn);
  const mcp = spawn.mcpConfig as {
    servers?: Record<string, { command?: string }>;
  };
  assertEquals(mcp.servers?.graft?.command, "graft");
  assert(mcp.servers?.codegraph !== undefined, "CodeGraph's entry is wired");
}

/** Assert one spawn carries none of the three accelerators. */
export function assertUnacceleratedSpawn(
  spawn: SpawnOptions | undefined,
): void {
  assert(spawn, "expected an agent invocation");
  const prompt = String(spawn.prompt);
  assertEquals(prompt.includes(GRAFT_PROMPT_LINE), false);
  assertEquals(prompt.includes(CODEGRAPH_PROMPT_LINE), false);
  assertEquals(spawn.mcpConfig, undefined);
  assertEquals(Object.hasOwn(spawn, "settingsJson"), false);
}

/** Assert a run-stats comment carries the Graft, CodeGraph and RTK lines. */
export function assertAcceleratorLines(body: string | undefined): void {
  assert(body, "expected a run-stats comment");
  const graftAt = body.indexOf("- **Graft:**");
  const codegraphAt = body.indexOf("- **CodeGraph:**");
  const rtkAt = body.indexOf("- **RTK:**");
  assert(graftAt >= 0, "the comment carries the Graft line");
  assert(codegraphAt > graftAt, "CodeGraph follows Graft");
  assert(rtkAt > codegraphAt, "RTK follows CodeGraph");
  assertStringIncludes(
    body.slice(graftAt, codegraphAt),
    "3 queries",
    "the spawn's Graft queries are recorded",
  );
}
