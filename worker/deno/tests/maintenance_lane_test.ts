/**
 * Tests for the maintenance-lane repo lease (Issue #213).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  acquireMaintenanceRepoLease,
  inMaintenanceLane,
  MAINTENANCE_LANE_SLOT_ID,
  type MaintenanceLaneBroker,
  runInMaintenanceLane,
} from "../lib/maintenance_lane.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";

/** A broker backed by a real registry, as production wires it. */
function registryBroker(
  registry: InFlightRepoRegistry,
): MaintenanceLaneBroker {
  return {
    tryAcquire: (repo, ref) =>
      registry.tryAcquire(repo, ref, MAINTENANCE_LANE_SLOT_ID, {
        maintenance: true,
      }),
    // Issue #1091: a lane lease is repository-wide, so it is given back
    // through the lease path rather than the per-stream one.
    release: (repo) => registry.releaseRepoLease(repo),
  };
}

Deno.test("maintenance lane - outside the lane every lease is granted (Issue #213)", () => {
  assertEquals(inMaintenanceLane(), false);
  const lease = acquireMaintenanceRepoLease("o/a", 12);
  assert(lease !== null, "the serial ladder has nothing to exclude");
  lease.release();
});

Deno.test("maintenance lane - a free repo is leased and shows up as held (Issue #213)", async () => {
  const registry = new InFlightRepoRegistry();
  await runInMaintenanceLane(registryBroker(registry), () => {
    assertEquals(inMaintenanceLane(), true);
    const lease = acquireMaintenanceRepoLease("o/a", 7);
    assert(lease !== null);
    assertEquals(registry.isHeld("o/a"), true);
    assertEquals([...registry.heldRepos()], ["o/a"]);
    lease.release();
    assertEquals(registry.isHeld("o/a"), false);
    return Promise.resolve();
  });
});

Deno.test("maintenance lane - a repo an issue slot holds is refused (Issue #213)", async () => {
  const registry = new InFlightRepoRegistry();
  // A slot is mid-run in o/a.
  assertEquals(registry.tryAcquire("o/a", 42, "s1"), true);

  await runInMaintenanceLane(registryBroker(registry), () => {
    const refused = acquireMaintenanceRepoLease("o/a", 7);
    assertEquals(
      refused,
      null,
      "a maintenance pass must never share a slot's working tree",
    );
    // A different repository is still available.
    const granted = acquireMaintenanceRepoLease("o/b", 8);
    assert(granted !== null);
    granted.release();
    return Promise.resolve();
  });

  // The slot's hold is untouched by the refusal.
  assertEquals(registry.isHeld("o/a"), true);
});

Deno.test("maintenance lane - releasing twice frees the repo once (Issue #213)", async () => {
  const registry = new InFlightRepoRegistry();
  await runInMaintenanceLane(registryBroker(registry), () => {
    const lease = acquireMaintenanceRepoLease("o/a", 7);
    assert(lease !== null);
    lease.release();
    // A slot takes the repository the moment the lane lets it go.
    assertEquals(registry.tryAcquire("o/a", 42, "s1"), true);
    // The stale second release must NOT evict the slot's hold.
    lease.release();
    assertEquals(registry.isHeld("o/a"), true);
    assertEquals(registry.holds()[0]?.slotId, "s1");
    return Promise.resolve();
  });
});

Deno.test("in-flight registry - a maintenance hold is not an issue claim (Issue #213)", () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/a", 42, "s1");
  registry.tryAcquire("o/b", 3804, "m1", { maintenance: true });

  // Display sees both.
  assertEquals(registry.holds().length, 2);
  // The claim-shaped views see only the slot's.
  assertEquals(registry.heldIssues(), [
    { repo: "o/a", issueNumber: 42, milestone: "" },
  ]);
  assertEquals(registry.slotHolds().map((h) => h.repo), ["o/a"]);
  // Both repositories are still excluded from a slot's next scan.
  assertEquals(new Set(registry.heldRepos()), new Set(["o/a", "o/b"]));
});
