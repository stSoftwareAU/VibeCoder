/**
 * Dispatch-slot tests for the merge-conflict pass (Issue #84).
 *
 * The pass has to sit between the branch updater that detects the conflict
 * and refuses to side-pick it (Issue #4373) and the CI nudge that would
 * otherwise poke a PR no CI can ever run on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPriorityDispatchTable,
  type PriorityHandlerResult,
  type RunCoreDeps,
} from "../lib/run_core.ts";

const SLOT = "Resolve PR Merge Conflicts";

Deno.test("merge-conflict dispatch - the slot runs after branch updates and before the CI nudge", () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const conflict = table.findIndex((h) => h.name === SLOT);
  const update = table.findIndex((h) => h.name === "Update PR Branches");
  const nudge = table.findIndex((h) => h.name === "Nudge Stalled CI");

  assert(conflict >= 0, "the merge-conflict pass has no dispatch slot");
  assert(
    update < conflict,
    `branch updates (${update}) must run before the conflict pass (${conflict})`,
  );
  assert(
    conflict < nudge,
    `the conflict pass (${conflict}) must run before the CI nudge (${nudge})`,
  );
  assert(
    table[conflict]!.agentBacked,
    "the conflict pass runs an agent, so it must be marked agent-backed",
  );
});

Deno.test("merge-conflict dispatch - the slot invokes findAndProcessMergeConflict", async () => {
  const calls: string[] = [];
  const deps = {
    findAndProcessMergeConflict: () => {
      calls.push("merge-conflict");
      return Promise.resolve({
        ok: true as const,
        value: { processed: true },
      });
    },
  } as unknown as RunCoreDeps;

  const table = buildPriorityDispatchTable(deps);
  const result = await table.find((h) => h.name === SLOT)!.execute();

  assertEquals(calls, ["merge-conflict"]);
  assert(result.ok);
  assertEquals((result.value as PriorityHandlerResult).processed, true);
});

Deno.test("merge-conflict dispatch - the slot is a no-op when the host wires no handler", async () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const result = await table.find((h) => h.name === SLOT)!.execute();

  assert(result.ok);
  assertEquals((result.value as PriorityHandlerResult).processed, false);
});
