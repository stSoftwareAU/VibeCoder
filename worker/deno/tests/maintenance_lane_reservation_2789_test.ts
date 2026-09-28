/**
 * Tests for the maintenance lane's repository reservation (Issue #2789).
 *
 * A busy repository whose issue slots claim back-to-back never went idle, so
 * the lane's whole-repository lease was refused on every pass and the repo's
 * PR feedback / CI fixes waited forever. A refused lane now reserves the
 * repository: no slot takes a new stream of it, the claim scan skips it, and
 * the lane wins it the moment the current holder releases.
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

function laneAcquire(registry: InFlightRepoRegistry, pr = 1631): boolean {
  return registry.tryAcquire(REPO, pr, MAINTENANCE_LANE_SLOT_ID, {
    maintenance: true,
    reserve: true,
  });
}

Deno.test("lane reservation - a refused lane reserves the repo, so the next slot cannot take it (Issue #2789)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(registry.tryAcquire(REPO, 1642, "s1"), true);
  assertEquals(laneAcquire(registry), false, "a slot holds the repository");
  assertEquals([...registry.reservedRepos()], [REPO]);
  assertEquals(
    [...registry.claimExcludedRepos()],
    [REPO],
    "the claim scan skips a reserved repository",
  );

  // The slot finishes; a sibling slot must not grab the repo again first.
  registry.release(REPO);
  assertEquals(
    registry.tryAcquire(REPO, 1643, "s2"),
    false,
    "a reserved repository refuses a new slot stream",
  );
  assertEquals(
    registry.tryAcquire(REPO, 1644, "s2", { milestone: "Alpha" }),
    false,
    "the reservation covers every stream, not just the default branch",
  );

  // The lane's next pass wins, and the reservation is spent.
  assertEquals(laneAcquire(registry), true);
  assertEquals([...registry.reservedRepos()], []);
  registry.releaseRepoLease(REPO);
  assertEquals(registry.tryAcquire(REPO, 1643, "s2"), true);
});

Deno.test("lane reservation - only the reserved repository is refused; others stay claimable", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  registry.tryAcquire(REPO, 1642, "s1");
  laneAcquire(registry);
  assertEquals(registry.tryAcquire("o/other", 7, "s2"), true);
  assertEquals([...registry.claimExcludedRepos()], [REPO]);
});

Deno.test("lane reservation - a slot already holding a stream keeps it; only new streams are refused", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(registry.tryAcquire(REPO, 1642, "s1"), true);
  assertEquals(laneAcquire(registry), false);
  assertEquals(registry.isStreamHeld(REPO), true);
  assertEquals(registry.heldIssues().length, 1);
});

Deno.test("lane reservation - lapses after the TTL once the lane stops asking (edge)", () => {
  let now = 1_000;
  const registry = new InFlightRepoRegistry(() => now);
  registry.tryAcquire(REPO, 1642, "s1");
  laneAcquire(registry);
  registry.release(REPO);

  // Just inside the TTL the reservation still holds.
  now += LANE_RESERVATION_TTL_MS - 1;
  assertEquals(registry.tryAcquire(REPO, 1643, "s2"), false);

  // At the TTL it lapses — a lane that lost interest cannot starve issues.
  now += 1;
  assertEquals([...registry.reservedRepos()], []);
  assertEquals(registry.tryAcquire(REPO, 1643, "s2"), true);
});

Deno.test("lane reservation - each refused lane pass refreshes the TTL", () => {
  let now = 1_000;
  const registry = new InFlightRepoRegistry(() => now);
  registry.tryAcquire(REPO, 1642, "s1");
  laneAcquire(registry);
  now += LANE_RESERVATION_TTL_MS - 1;
  assertEquals(laneAcquire(registry), false, "the slot still holds the repo");
  now += LANE_RESERVATION_TTL_MS - 1;
  assertEquals(
    [...registry.reservedRepos()],
    [REPO],
    "the second refusal restarted the TTL",
  );
});

Deno.test("lane reservation - a lane that wins first time never reserves (no regression)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(laneAcquire(registry), true);
  assertEquals([...registry.reservedRepos()], []);
  // The lease itself still excludes the repo from the claim scan.
  assertEquals([...registry.claimExcludedRepos()], [REPO]);
  registry.releaseRepoLease(REPO);
  assertEquals([...registry.claimExcludedRepos()], []);
});

Deno.test("lane reservation - a lane refused by its own live lease does not reserve (error path)", () => {
  const registry = new InFlightRepoRegistry(() => 1_000);
  assertEquals(laneAcquire(registry, 1631), true);
  assertEquals(laneAcquire(registry, 1634), false, "one lease per repo");
  registry.releaseRepoLease(REPO);
  assertEquals([...registry.reservedRepos()], []);
  assertEquals(registry.tryAcquire(REPO, 1643, "s1"), true);
});
