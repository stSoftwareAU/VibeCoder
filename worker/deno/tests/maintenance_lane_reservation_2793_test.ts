/**
 * Tests for the maintenance-lane reservation follow-up (Issue #2793).
 *
 * Two leaks in the #2789 reservation:
 *
 * - Every refused lane lease reserved the repository, so Milestone Branch
 *   Sync — which leases every cloned repository each cycle — reserved every
 *   busy repository on the host every cycle. Only a pass servicing a PR now
 *   opts in with `reserve: true`.
 * - Any lane win spent the reservation, so a sync pass (ref 0) rotated ahead
 *   of PR Feedback won the drained repository and handed it straight back to
 *   the slots. Only the ref that reserved it spends it now (and, since
 *   Issue #2795, its PR closing or merging, or the TTL).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import {
  acquireMaintenanceRepoLease,
  MAINTENANCE_LANE_SLOT_ID,
  type MaintenanceLaneBroker,
  runInMaintenanceLane,
} from "../lib/maintenance_lane.ts";

const REPO = "stSoftwareAU/GRQ-AutoTrader";

function lane(
  registry: InFlightRepoRegistry,
  ref: number,
  reserve: boolean,
): boolean {
  return registry.tryAcquire(REPO, ref, MAINTENANCE_LANE_SLOT_ID, {
    maintenance: true,
    reserve,
  });
}

Deno.test("reservation opt-in - a refused sync-style lease (no reserve flag) does not reserve (Issue #2793)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(registry.tryAcquire(REPO, 1642, "s1"), true);
  assertEquals(lane(registry, 0, false), false, "a slot holds the repository");
  assertEquals([...registry.reservedRepos()], []);
  registry.release(REPO);
  assertEquals(
    registry.tryAcquire(REPO, 1643, "s2"),
    true,
    "an unreserved repository stays claimable",
  );
});

Deno.test("reservation opt-in - an omitted reserve flag defaults to defer-only (edge)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  registry.tryAcquire(REPO, 1642, "s1");
  assertEquals(
    registry.tryAcquire(REPO, 0, MAINTENANCE_LANE_SLOT_ID, {
      maintenance: true,
    }),
    false,
  );
  assertEquals([...registry.reservedRepos()], []);
});

Deno.test("reservation owner - a sync win does not spend a PR pass's reservation (Issue #2793)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(registry.tryAcquire(REPO, 1642, "s1"), true);
  assertEquals(lane(registry, 1631, true), false, "a slot holds the repo");
  registry.release(REPO);

  // The rotated sync pass wins the drained repository and gives it back.
  assertEquals(lane(registry, 0, false), true);
  registry.releaseRepoLease(REPO);
  assertEquals([...registry.reservedRepos()], [REPO]);
  assertEquals(
    registry.tryAcquire(REPO, 1643, "s2"),
    false,
    "the reservation still refuses a new slot stream",
  );

  // The PR pass that reserved the repository wins it and spends it.
  assertEquals(lane(registry, 1631, true), true);
  assertEquals([...registry.reservedRepos()], []);
});

Deno.test("reservation owner - a different PR winning keeps the reservation (edge)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  registry.tryAcquire(REPO, 1642, "s1");
  lane(registry, 1631, true);
  registry.release(REPO);
  assertEquals(lane(registry, 1700, true), true);
  registry.releaseRepoLease(REPO);
  assertEquals([...registry.reservedRepos()], [REPO]);
});

Deno.test("acquireMaintenanceRepoLease - threads the reserve opt-in to the broker", async () => {
  const seen: Array<{ ref: number; reserve: boolean | undefined }> = [];
  const broker: MaintenanceLaneBroker = {
    tryAcquire: (_repo, ref, options) => {
      seen.push({ ref, reserve: options?.reserve });
      return false;
    },
    release: () => {},
  };
  await runInMaintenanceLane(broker, () => {
    assertEquals(
      acquireMaintenanceRepoLease(REPO, 1631, { reserve: true }),
      null,
    );
    assertEquals(acquireMaintenanceRepoLease(REPO), null);
    return Promise.resolve();
  });
  assertEquals(seen, [
    { ref: 1631, reserve: true },
    { ref: 0, reserve: undefined },
  ]);
});
