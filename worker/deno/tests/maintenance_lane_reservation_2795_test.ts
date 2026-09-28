/**
 * Tests for dropping a lane reservation only on a positive signal (Issue
 * #2795).
 *
 * #2793 dropped every reservation a full lane pass sequence did not renew.
 * The single-candidate passes (CI fix, PR feedback) pick one PR a cycle, so a
 * reservation also dropped while its PR was still broken — the pass picked a
 * PR elsewhere, or failed before it reached the lease — and the drain could
 * restart. A reservation now ends only when its own PR wins the repository,
 * its PR is closed or merged, or the two-hour TTL lapses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  InFlightRepoRegistry,
  LANE_RESERVATION_TTL_MS,
} from "../lib/in_flight_repos.ts";
import { MAINTENANCE_LANE_SLOT_ID } from "../lib/maintenance_lane.ts";

const REPO = "stSoftwareAU/GRQ-AutoTrader";

/** A registry with `repo` reserved by PR `ref` behind a slot's hold. */
function reserved(
  registry: InFlightRepoRegistry,
  repo: string,
  ref: number,
): void {
  registry.tryAcquire(repo, 1642, "s1");
  registry.tryAcquire(repo, ref, MAINTENANCE_LANE_SLOT_ID, {
    maintenance: true,
    reserve: true,
  });
  registry.release(repo);
}

Deno.test("reservations - lists each reserved repository with the PR that reserved it (Issue #2795)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  reserved(registry, REPO, 1631);
  reserved(registry, "o/other", 9);
  assertEquals(registry.reservations(), [
    { repo: REPO, ref: 1631 },
    { repo: "o/other", ref: 9 },
  ]);
});

Deno.test("reservations - empty when nothing is reserved (edge)", () => {
  assertEquals(new InFlightRepoRegistry(() => 0).reservations(), []);
});

Deno.test("reservations - omits and prunes a lapsed reservation (edge)", () => {
  let now = 0;
  const registry = new InFlightRepoRegistry(() => now);
  reserved(registry, REPO, 1631);
  now = LANE_RESERVATION_TTL_MS;
  assertEquals(registry.reservations(), []);
  assertEquals([...registry.reservedRepos()], []);
});

Deno.test("releaseReservation - the reserving PR's positive signal drops it (Issue #2795)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  reserved(registry, REPO, 1631);
  assertEquals(registry.releaseReservation(REPO, 1631), true);
  assertEquals([...registry.reservedRepos()], []);
  assertEquals(registry.tryAcquire(REPO, 1700, "s2"), true);
});

Deno.test("releaseReservation - a stale ref cannot drop a reservation another PR has since made (error path)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  registry.tryAcquire(REPO, 1642, "s1");
  const laneOptions = { maintenance: true, reserve: true };
  registry.tryAcquire(REPO, 1631, MAINTENANCE_LANE_SLOT_ID, laneOptions);
  // PR 1700's refusal, while the slot still holds it, re-reserves the
  // repository under its own ref.
  registry.tryAcquire(REPO, 1700, MAINTENANCE_LANE_SLOT_ID, laneOptions);
  registry.release(REPO);
  assertEquals(registry.releaseReservation(REPO, 1631), false);
  assertEquals(registry.reservations(), [{ repo: REPO, ref: 1700 }]);
});

Deno.test("releaseReservation - releasing an unreserved repository is a no-op (edge)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(registry.releaseReservation(REPO, 1631), false);
  assertEquals([...registry.reservedRepos()], []);
});
