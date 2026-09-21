/**
 * Tests for the maintenance-lease decision — identity, clock and dead-holder
 * rules (Issue #2448).
 *
 * The lease lets one host run a repository's fixed-cost maintenance sweeps
 * while the others skip. This module is the pure decision, so every test
 * drives the real `maintenance_lease.ts` functions through an injected holder
 * and clock, and asserts on the marker or the decision.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideMaintenanceLease,
  formatMaintenanceLeaseMarker,
  MAINTENANCE_LEASE_MARKER_PREFIX,
  MAINTENANCE_LEASE_SECONDS,
  parseMaintenanceLeaseMarker,
} from "../lib/maintenance_lease.ts";

const REPO = "stSoftwareAU/VibeCoder";
const INSTALL = "1079448c-0b73-4259-ad4e-e2f5dd922657";
const OTHER_INSTALL = "ffffffff-0000-1111-2222-333344445555";
const NOW = 1_700_000_000;

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

Deno.test("maintenance lease marker - round-trips the repo, host and epoch", () => {
  const marker = formatMaintenanceLeaseMarker(REPO, INSTALL, NOW);
  assertStringIncludes(marker, `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} `);
  assertStringIncludes(marker, `repo=${REPO}`);
  assertStringIncludes(marker, `host=${INSTALL}`);
  assertStringIncludes(marker, `at=${NOW}`);

  const parsed = parseMaintenanceLeaseMarker(`${marker}\nsome visible text`);
  assert(parsed !== null);
  assertEquals(parsed.repo, REPO);
  assertEquals(parsed.host, INSTALL);
  assertEquals(parsed.atEpoch, NOW);
});

Deno.test("maintenance lease marker - a body with no marker parses to null", () => {
  assertEquals(parseMaintenanceLeaseMarker("just a comment"), null);
  assertEquals(
    parseMaintenanceLeaseMarker("<!-- vibe-maintenance-lease repo=x -->"),
    null,
  );
});

Deno.test("maintenance lease marker - clamps a negative epoch to zero and floors a fractional one", () => {
  assertStringIncludes(formatMaintenanceLeaseMarker(REPO, INSTALL, -5), "at=0");
  assertStringIncludes(
    formatMaintenanceLeaseMarker(REPO, INSTALL, NOW + 0.75),
    `at=${NOW}`,
  );
});

Deno.test("maintenance lease marker - sanitises a repository and host with whitespace and unicode", () => {
  const marker = formatMaintenanceLeaseMarker(
    "  stSoftwareAU/VibeCoder  ",
    "host with space \u{1F680}",
    NOW,
  );
  const parsed = parseMaintenanceLeaseMarker(marker);
  assert(parsed !== null);
  assertEquals(parsed.repo, REPO);
  assertEquals(parsed.host, "host-with-space");
});

Deno.test("maintenance lease marker - a non-numeric at is rejected", () => {
  assertEquals(
    parseMaintenanceLeaseMarker(
      `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} repo=${REPO} ` +
        `host=${INSTALL} at=tomorrow -->`,
    ),
    null,
  );
});

Deno.test("maintenance lease marker - a missing host is rejected", () => {
  assertEquals(
    parseMaintenanceLeaseMarker(
      `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} repo=${REPO} at=${NOW} -->`,
    ),
    null,
  );
});

Deno.test("maintenance lease marker - a repository that is not owner/repo is rejected", () => {
  assertEquals(
    parseMaintenanceLeaseMarker(
      `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} repo=not-a-repo ` +
        `host=${INSTALL} at=${NOW} -->`,
    ),
    null,
  );
  assertEquals(
    parseMaintenanceLeaseMarker(
      `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} repo=${REPO}/extra ` +
        `host=${INSTALL} at=${NOW} -->`,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// The lease decision
// ---------------------------------------------------------------------------

Deno.test("decideMaintenanceLease - no holder means this host runs", () => {
  const decision = decideMaintenanceLease({
    holder: null,
    thisHost: `vibe-coder-31555-${INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "no-holder");
  assertEquals(decision.holderHost, undefined);
});

Deno.test("decideMaintenanceLease - the holder host runs (own-lease)", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW - 60 },
    thisHost: `vibe-coder-31555-${INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "own-lease");
});

Deno.test("decideMaintenanceLease - the same install id with a new hostname is own-lease", () => {
  // The container hostname changes every hourly launch (#2403); the persisted
  // install uuid does not. A relaunch must recognise its own lease.
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW - 60 },
    thisHost: `vibe-coder-9190-${INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "own-lease");
});

Deno.test("decideMaintenanceLease - a bare install id is recognised as own-lease", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW - 60 },
    thisHost: INSTALL,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "own-lease");
});

Deno.test("decideMaintenanceLease - a dead holder may be taken over (holder-expired)", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW - 23 * 3600 },
    thisHost: `vibe-coder-31555-${OTHER_INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "holder-expired");
  assertEquals(decision.holderHost, INSTALL);
});

Deno.test("decideMaintenanceLease - a live foreign holder blocks this host (held-elsewhere)", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW - 60 },
    thisHost: `vibe-coder-31555-${OTHER_INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, false);
  assertEquals(decision.reason, "held-elsewhere");
  assertEquals(decision.holderHost, INSTALL);
  assertEquals(decision.secondsLeft, MAINTENANCE_LEASE_SECONDS - 60);
});

Deno.test("decideMaintenanceLease - the lease expires exactly at the boundary", () => {
  const at = (age: number) =>
    decideMaintenanceLease({
      holder: { host: INSTALL, atEpoch: NOW - age },
      thisHost: `vibe-coder-31555-${OTHER_INSTALL}`,
      nowSeconds: NOW,
    });
  // One second inside the lease is still held elsewhere, with one second left.
  assertEquals(at(MAINTENANCE_LEASE_SECONDS - 1).run, false);
  assertEquals(
    at(MAINTENANCE_LEASE_SECONDS - 1).secondsLeft,
    1,
  );
  // At the boundary the holder is dead and this host takes over.
  const expired = at(MAINTENANCE_LEASE_SECONDS);
  assertEquals(expired.run, true);
  assertEquals(expired.reason, "holder-expired");
});

Deno.test("decideMaintenanceLease - a marker from the future is clamped to now, never trusted as extra time", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW + 3600 },
    thisHost: `vibe-coder-31555-${OTHER_INSTALL}`,
    nowSeconds: NOW,
  });
  // Clock skew: the stamp is treated as fresh, so the lease is fully live.
  assertEquals(decision.run, false);
  assertEquals(decision.reason, "held-elsewhere");
  assertEquals(decision.secondsLeft, MAINTENANCE_LEASE_SECONDS);
});

Deno.test("decideMaintenanceLease - a future-stamped marker from this host is own-lease", () => {
  const decision = decideMaintenanceLease({
    holder: { host: INSTALL, atEpoch: NOW + 3600 },
    thisHost: `vibe-coder-31555-${INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, true);
  assertEquals(decision.reason, "own-lease");
});

Deno.test("decideMaintenanceLease - the same hostname on a different install is a foreign holder", () => {
  const decision = decideMaintenanceLease({
    holder: { host: OTHER_INSTALL, atEpoch: NOW - 60 },
    thisHost: `vibe-coder-31555-${INSTALL}`,
    nowSeconds: NOW,
  });
  assertEquals(decision.run, false);
  assertEquals(decision.reason, "held-elsewhere");
});
