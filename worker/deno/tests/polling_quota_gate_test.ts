/**
 * Tests for polling_quota_gate.ts — the quota-aware polling gate that parks
 * low-priority repositories and defers the idle-task tier while the fleet's
 * shared GraphQL quota is low (Issue #3628).
 *
 * Pure function tests: no I/O, no fixtures, deterministic.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatPollingGateIdleLine,
  formatPollingGateParkLine,
  pollingGateVerdict,
  type PollingQuotaThresholds,
} from "../lib/polling_quota_gate.ts";

const THRESHOLDS: PollingQuotaThresholds = {
  parkFloor: 1500,
  parkNice: 99,
  idleFloor: 500,
};

const READING = { limit: 5000, remaining: 1200 };

Deno.test("polling-quota-gate - a null reading polls everything (fail-open)", () => {
  assertEquals(pollingGateVerdict(0, null, THRESHOLDS), {
    parkRepo: false,
    deferIdle: false,
  });
  assertEquals(pollingGateVerdict(999, null, THRESHOLDS), {
    parkRepo: false,
    deferIdle: false,
  });
});

Deno.test("polling-quota-gate - a healthy reading polls everything", () => {
  assertEquals(
    pollingGateVerdict(99, { limit: 5000, remaining: 5000 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: false,
    },
  );
  assertEquals(
    pollingGateVerdict(99, { limit: 5000, remaining: 1500 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: false,
    },
  );
});

Deno.test("polling-quota-gate - below the park floor only repos at or above park nice are parked", () => {
  // Boundary: exactly at the floor is not gated.
  assertEquals(
    pollingGateVerdict(99, { limit: 5000, remaining: 1500 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: false,
    },
  );
  // One point below the floor parks a park-tier repo.
  assertEquals(
    pollingGateVerdict(99, { limit: 5000, remaining: 1499 }, THRESHOLDS),
    {
      parkRepo: true,
      deferIdle: false,
    },
  );
  // A repo below the park nice tier is never parked.
  assertEquals(
    pollingGateVerdict(98, { limit: 5000, remaining: 1499 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: false,
    },
  );
  // Negative nice (worked sooner) is never parked.
  assertEquals(
    pollingGateVerdict(-16, { limit: 5000, remaining: 1 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: true,
    },
  );
});

Deno.test("polling-quota-gate - below the idle floor defers idle collection fleet-wide", () => {
  // Boundary: exactly at the floor is not gated.
  assertEquals(
    pollingGateVerdict(0, { limit: 5000, remaining: 500 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: false,
    },
  );
  // One point below defers the idle tier for any repo below park nice.
  assertEquals(
    pollingGateVerdict(0, { limit: 5000, remaining: 499 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: true,
    },
  );
  assertEquals(
    pollingGateVerdict(50, { limit: 5000, remaining: 499 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: true,
    },
  );
});

Deno.test("polling-quota-gate - below both floors a park-tier repo is parked and idle is deferred", () => {
  assertEquals(
    pollingGateVerdict(99, { limit: 5000, remaining: 300 }, THRESHOLDS),
    {
      parkRepo: true,
      deferIdle: true,
    },
  );
  assertEquals(
    pollingGateVerdict(0, { limit: 5000, remaining: 300 }, THRESHOLDS),
    {
      parkRepo: false,
      deferIdle: true,
    },
  );
});

Deno.test("polling-quota-gate - a floor of zero disables its tier", () => {
  const parkOff: PollingQuotaThresholds = {
    parkFloor: 0,
    parkNice: 99,
    idleFloor: 500,
  };
  assertEquals(pollingGateVerdict(99, { limit: 5000, remaining: 1 }, parkOff), {
    parkRepo: false,
    deferIdle: true,
  });

  const idleOff: PollingQuotaThresholds = {
    parkFloor: 1500,
    parkNice: 99,
    idleFloor: 0,
  };
  assertEquals(pollingGateVerdict(0, { limit: 5000, remaining: 1 }, idleOff), {
    parkRepo: false,
    deferIdle: false,
  });
});

Deno.test("polling-quota-gate - the park line names remaining, floor and the parked count", () => {
  const line = formatPollingGateParkLine(READING, 3, THRESHOLDS);
  assertStringIncludes(line, "remaining=1200/5000");
  assertStringIncludes(line, "park_floor=1500");
  assertStringIncludes(line, "parked 3 repo(s)");
  assertStringIncludes(line, "nice >= 99");
  // Deterministic: no timestamp, no clock.
  assertStringIncludes(line, "polling-quota-gate:");
});

Deno.test("polling-quota-gate - the idle line names remaining, limit and floor", () => {
  const line = formatPollingGateIdleLine(READING, THRESHOLDS);
  assertStringIncludes(line, "remaining=1200/5000");
  assertStringIncludes(line, "idle_floor=500");
  assertStringIncludes(line, "idle-task collection deferred");
  assertStringIncludes(line, "polling-quota-gate:");
});
