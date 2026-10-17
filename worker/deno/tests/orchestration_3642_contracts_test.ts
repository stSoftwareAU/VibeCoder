/**
 * Unit tests for the orchestration building blocks (Issue #3642): the
 * checkpoint store, the idempotency key, the state transition table and the
 * provider capability probe. Each assertion runs the real function.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  idempotencyKey,
  loadCheckpoint,
  ORCHESTRATION_CHECKPOINT_SCHEMA,
  type OrchestrationCheckpoint,
  saveCheckpoint,
} from "../lib/orchestration/checkpoint.ts";
import {
  assertRoleSupported,
  providerCapabilities,
} from "../lib/orchestration/capabilities.ts";
import {
  assertTransition,
  ORCHESTRATION_TRANSITIONS,
} from "../lib/orchestration/types.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function checkpointFor(issueId: string): OrchestrationCheckpoint {
  return {
    schema: ORCHESTRATION_CHECKPOINT_SCHEMA,
    issueId,
    leaseId: "lease-1",
    leaseHeartbeatMs: 1_000,
    state: "dispatched",
    invocations: 2,
    costUsd: 0.5,
    steps: { "3642:phase:plan": "plan output" },
    results: [],
  };
}

Deno.test("a saved checkpoint loads back unchanged", async () => {
  await withDir(async (dir) => {
    const checkpoint = checkpointFor("3642");
    await saveCheckpoint(dir, checkpoint);
    const loaded = await loadCheckpoint(dir, "3642");
    assertEquals(loaded.warning, undefined);
    assertEquals(loaded.checkpoint, checkpoint);
  });
});

Deno.test("a missing checkpoint loads as nothing and no warning", async () => {
  await withDir(async (dir) => {
    assertEquals(await loadCheckpoint(dir, "3642"), {});
  });
});

Deno.test("a checkpoint naming another issue is ignored with a warning", async () => {
  await withDir(async (dir) => {
    await saveCheckpoint(dir, checkpointFor("9999"));
    await Deno.rename(`${dir}/9999.json`, `${dir}/3642.json`);
    const loaded = await loadCheckpoint(dir, "3642");
    assertEquals(loaded.checkpoint, undefined);
    assertEquals(typeof loaded.warning, "string");
  });
});

Deno.test("a checkpoint that is not valid JSON is ignored with a warning", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/3642.json`, "{not json");
    const loaded = await loadCheckpoint(dir, "3642");
    assertEquals(loaded.checkpoint, undefined);
    assertEquals(typeof loaded.warning, "string");
  });
});

Deno.test("an idempotency key is stable for the same call and changes with the attempt or brief", async () => {
  const base = await idempotencyKey("3642", "executor", 0, "brief");
  assertEquals(base, await idempotencyKey("3642", "executor", 0, "brief"));
  assertNotEquals(base, await idempotencyKey("3642", "executor", 1, "brief"));
  assertNotEquals(base, await idempotencyKey("3642", "executor", 0, "other"));
  assertEquals(base.startsWith("3642:executor:0:"), true);
});

Deno.test("an illegal transition throws and a legal one does not", () => {
  assertThrows(
    () => assertTransition("claimed", "done"),
    Error,
    "illegal orchestration transition: claimed -> done",
  );
  assertTransition("planning", "dispatched");
});

Deno.test("released is terminal and recovering may enter released", () => {
  assertEquals(ORCHESTRATION_TRANSITIONS.released, []);
  assertEquals(ORCHESTRATION_TRANSITIONS.recovering.includes("released"), true);
});

Deno.test("claude carries compaction, denied-tool enforcement and the agents flag", () => {
  const caps = providerCapabilities("claude");
  assertEquals(caps.compaction, true);
  assertEquals(caps.agents, true);
  assertEquals(
    assertRoleSupported({ provider: "claude" }, "manager", ["Task"]),
    undefined,
  );
});

Deno.test("codex cannot enforce a denied tool, so a role denying one is refused", () => {
  const refusal = assertRoleSupported({ provider: "codex" }, "executor", [
    "Task",
  ]);
  assertEquals(refusal?.kind, "missing_tool_support");
  assertEquals(
    assertRoleSupported({ provider: "codex" }, "explorer", []),
    undefined,
  );
});
