/**
 * Dispatch-slot tests for the PR body digest reconcile pass (Issue #3760).
 *
 * A push made outside the worker never reaches the post-push sync, so the
 * recorded summary digest can drift from the summary at the PR head. The pass
 * sits at priority 1.64: after the blocking-PR stall repair that may rerun
 * lanes against the same PRs, and before auto-merge.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPriorityDispatchTable,
  type PriorityHandlerResult,
  type RunCoreDeps,
} from "../lib/run_core.ts";

const SLOT = "Reconcile PR Body Digests";

Deno.test("pr body digest reconcile dispatch - the slot is at priority 1.64, deferrable, and ordered between stall repair and auto-merge", () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const slot = table.findIndex((h) => h.name === SLOT);
  const stall = table.findIndex((h) => h.name === "Blocking PR Stall Repair");
  const autoMerge = table.findIndex((h) => h.name === "Auto-Merge");

  assert(slot >= 0, "the PR body digest reconcile pass has no dispatch slot");
  assertEquals(table[slot]!.priority, 1.64);
  assertEquals(table[slot]!.budgetTier, "deferrable");
  assert(
    stall < slot,
    `the stall repair (${stall}) must run before the digest reconcile (${slot})`,
  );
  assert(
    slot < autoMerge,
    `the digest reconcile (${slot}) must run before auto-merge (${autoMerge})`,
  );
});

Deno.test("pr body digest reconcile dispatch - the slot invokes reconcilePrBodyDigests exactly once", async () => {
  const calls: string[] = [];
  const deps = {
    reconcilePrBodyDigests: () => {
      calls.push("reconcile");
      return Promise.resolve({ ok: true as const, value: undefined });
    },
  } as unknown as RunCoreDeps;

  const table = buildPriorityDispatchTable(deps);
  const result = await table.find((h) => h.name === SLOT)!.execute();

  assertEquals(calls, ["reconcile"]);
  assert(result.ok);
  assertEquals((result.value as PriorityHandlerResult).processed, false);
});

Deno.test("pr body digest reconcile dispatch - the slot is a no-op when the host wires no handler", async () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const result = await table.find((h) => h.name === SLOT)!.execute();

  assert(result.ok);
  assertEquals((result.value as PriorityHandlerResult).processed, false);
});

Deno.test("pr body digest reconcile dispatch - a failed reconcile propagates its error", async () => {
  const failure = new Error("digest reconcile failed");
  const deps = {
    reconcilePrBodyDigests: () =>
      Promise.resolve({ ok: false as const, error: failure }),
  } as unknown as RunCoreDeps;

  const table = buildPriorityDispatchTable(deps);
  const result = await table.find((h) => h.name === SLOT)!.execute();

  assert(!result.ok);
  assertEquals(result.error, failure);
});
