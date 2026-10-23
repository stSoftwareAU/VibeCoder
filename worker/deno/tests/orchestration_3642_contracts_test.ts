/**
 * Unit tests for the orchestration building blocks (Issue #3642): the
 * checkpoint store, the idempotency key, the state transition table and the
 * provider capability probe. Each assertion runs the real function.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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

Deno.test("codex refuses arbitrary tool denials outside the role sandbox policy", () => {
  const refusal = assertRoleSupported({ provider: "codex" }, "executor", [
    "WebFetch",
  ]);
  assertEquals(refusal?.kind, "missing_tool_support");
  assertEquals(
    assertRoleSupported({ provider: "codex" }, "explorer", []),
    undefined,
  );
});

Deno.test("providerCapabilities - every registered target provider can be probed (Issue #4121)", () => {
  for (const p of ["claude", "codex", "gemini", "deepseek"] as const) {
    const caps = providerCapabilities(p);
    assertEquals(typeof caps, "object");
    assertEquals(typeof caps.settingsHook, "boolean");
  }
  assertEquals(providerCapabilities("codex").settingsHook, false);
});

Deno.test("a manager on a provider without compaction is refused as unsupported_capability", () => {
  // The denied list is empty, so only the compaction rule can refuse the manager.
  for (const provider of ["gemini"] as const) {
    const refusal = assertRoleSupported({ provider }, "manager", []);
    assertEquals(refusal?.kind, "unsupported_capability");
    assertStringIncludes(refusal?.message ?? "", "cannot compact its stream");
  }
  // Positive control: claude compacts, so the same manager call is not refused.
  assertEquals(
    assertRoleSupported({ provider: "claude" }, "manager", []),
    undefined,
  );
});

/**
 * Runs saveCheckpoint with Deno.rename failing and Deno.remove throwing
 * `removeError`, capturing console.warn. Every replaced API is restored in
 * finally, so no stub outlives the call.
 */
async function saveWithFailingRename(
  dir: string,
  removeError: Error,
): Promise<{ error: unknown; warnings: string[] }> {
  const originalRename = Deno.rename;
  const originalRemove = Deno.remove;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    Deno.rename = () => Promise.reject(new Error("rename refused"));
    Deno.remove = () => Promise.reject(removeError);
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    await saveCheckpoint(dir, checkpointFor("3642"));
    return { error: undefined, warnings };
  } catch (error) {
    return { error, warnings };
  } finally {
    Deno.rename = originalRename;
    Deno.remove = originalRemove;
    console.warn = originalWarn;
  }
}

Deno.test("a failed cleanup that is not NotFound warns with the temporary path and rethrows the rename error", async () => {
  await withDir(async (dir) => {
    const { error, warnings } = await saveWithFailingRename(
      dir,
      new Deno.errors.PermissionDenied("denied"),
    );
    assertEquals((error as Error).message, "rename refused");
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.includes(`${dir}/3642.json.`), true);
    assertEquals(warnings[0]?.includes("could not remove"), true);
  });
});

Deno.test("a cleanup that finds the temporary file missing is silent and rethrows the rename error", async () => {
  await withDir(async (dir) => {
    const { error, warnings } = await saveWithFailingRename(
      dir,
      new Deno.errors.NotFound("gone"),
    );
    assertEquals((error as Error).message, "rename refused");
    assertEquals(warnings, []);
  });
});
