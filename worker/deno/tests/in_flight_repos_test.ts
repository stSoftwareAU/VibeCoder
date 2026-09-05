/**
 * Tests for the host-local in-flight repository registry (Issue #4176).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  formatInFlightHold,
  InFlightRepoRegistry,
} from "../lib/in_flight_repos.ts";

Deno.test("in_flight_repos - acquire/release round trip; heldRepos and heldIssues reflect it", () => {
  const registry = new InFlightRepoRegistry(() => 5_000);
  assertEquals(registry.tryAcquire("o/a", 1, "s1"), true);
  assertEquals(registry.isHeld("o/a"), true);
  assertEquals([...registry.heldRepos()], ["o/a"]);
  // Issue #1091: the hold carries the work stream it occupies — the default
  // branch, for an issue with no milestone.
  assertEquals(registry.heldIssues(), [
    { repo: "o/a", issueNumber: 1, milestone: "" },
  ]);
  assertEquals(registry.holds()[0]?.slotId, "s1");
  assertEquals(registry.holds()[0]?.sinceMs, 5_000);
  registry.release("o/a");
  assertEquals(registry.isHeld("o/a"), false);
  assertEquals(registry.size, 0);
  // Releasing again is a no-op.
  registry.release("o/a");
});

Deno.test("in_flight_repos - two acquires of the same repo: exactly one wins (Issue #4176)", () => {
  const registry = new InFlightRepoRegistry();
  const results = [
    registry.tryAcquire("o/a", 1, "s1"),
    registry.tryAcquire("o/a", 2, "s2"),
  ];
  assertEquals(results.filter(Boolean).length, 1);
  assertEquals(registry.holds()[0]?.slotId, "s1");
  // A different repo is independent.
  assertEquals(registry.tryAcquire("o/b", 7, "s2"), true);
  assertEquals(registry.size, 2);
});

Deno.test("in_flight_repos - releasing makes the repo immediately claimable by the next slot", () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/a", 1, "s1");
  assertEquals(registry.tryAcquire("o/a", 3, "s2"), false);
  registry.release("o/a");
  assertEquals(registry.tryAcquire("o/a", 3, "s2"), true);
});

// ---------------------------------------------------------------------------
// Run deadlines on a hold (Issue #4297)
// ---------------------------------------------------------------------------

Deno.test("in_flight_repos - a progress-extended run's deadline is recorded on its hold and rendered for the drain log (Issue #4297)", () => {
  const now = 1_000_000_000_000;
  const registry = new InFlightRepoRegistry(() => now);
  registry.tryAcquire("o/a", 12, "s2");

  // Run start: the original one-hour budget, no extensions yet.
  assertEquals(
    registry.noteRunDeadline("o/a", "", {
      deadlineMs: now + 3600_000,
      extensionsGranted: 0,
    }),
    true,
  );
  assertEquals(
    formatInFlightHold(registry.holds()[0]!, now),
    "s2 o/a#12 (deadline in 3600s)",
  );

  // Two grants later the run legitimately lives past the original budget.
  registry.noteRunDeadline("o/a", "", {
    deadlineMs: now + 4500_000,
    extensionsGranted: 2,
  });
  const hold = registry.holds()[0]!;
  assertEquals(hold.runDeadline?.extensionsGranted, 2);
  assertEquals(
    formatInFlightHold(hold, now + 3600_000),
    "s2 o/a#12 (extended 2×, deadline in 900s)",
  );
});

Deno.test("in_flight_repos - a hold with no reported deadline renders exactly as before (Issue #4297)", () => {
  const registry = new InFlightRepoRegistry(() => 5_000);
  registry.tryAcquire("o/a", 1, "s1");
  assertEquals(formatInFlightHold(registry.holds()[0]!, 5_000), "s1 o/a#1");
});

Deno.test("in_flight_repos - a deadline reported after the slot released is dropped, not resurrected (Issue #4297)", () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/a", 1, "s1");
  registry.release("o/a");
  assertEquals(
    registry.noteRunDeadline("o/a", "", {
      deadlineMs: 1_000,
      extensionsGranted: 3,
    }),
    false,
  );
  assertEquals(registry.size, 0);
  assertEquals(registry.isHeld("o/a"), false);
});
