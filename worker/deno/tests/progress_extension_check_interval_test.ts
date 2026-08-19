/**
 * Tests for the progress-extension check interval (Issue #4295, part of #4290).
 *
 * The check interval is the resolution of the working-tree signal: between
 * deadline checks the runner samples the tree every `checkSeconds`, so the
 * verdict the deadline decision reads describes a recent window rather than
 * the whole grant. Both helpers are pure — the clock is an argument — so the
 * rules are pinned here without a timer, a subprocess or a repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  combineTreeEvidence,
  nextProgressCheckDelayMs,
  type ProgressExtensionPolicy,
} from "../lib/progress_extension.ts";

const POLICY: ProgressExtensionPolicy = {
  enabled: true,
  grantSeconds: 900,
  activityStallSeconds: 300,
  checkSeconds: 300,
};

const NOW = 5_000_000;

Deno.test("nextProgressCheckDelayMs - wakes at the check interval while the deadline is further away", () => {
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 900_000, POLICY),
    300_000,
    "an interim sample is due one check interval from now",
  );
});

Deno.test("nextProgressCheckDelayMs - never overshoots the deadline", () => {
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 10_000, POLICY),
    10_000,
    "the deadline is closer than the check interval, so wake on it",
  );
});

Deno.test("nextProgressCheckDelayMs - an expired deadline wakes immediately", () => {
  assertEquals(nextProgressCheckDelayMs(NOW, NOW - 60_000, POLICY), 0);
});

Deno.test("nextProgressCheckDelayMs - without a check interval the wake is the deadline (Issue #4296 behaviour)", () => {
  const noInterval: ProgressExtensionPolicy = {
    enabled: true,
    grantSeconds: 900,
    activityStallSeconds: 300,
  };
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 900_000, noInterval),
    900_000,
    "no interval configured means the deadline is the only wake",
  );
});

Deno.test("nextProgressCheckDelayMs - a disabled policy never samples", () => {
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 900_000, {
      ...POLICY,
      enabled: false,
    }),
    900_000,
  );
});

Deno.test("nextProgressCheckDelayMs - a non-positive check interval is ignored", () => {
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 900_000, {
      ...POLICY,
      checkSeconds: 0,
    }),
    900_000,
  );
  assertEquals(
    nextProgressCheckDelayMs(NOW, NOW + 900_000, {
      ...POLICY,
      checkSeconds: -30,
    }),
    900_000,
  );
});

Deno.test("combineTreeEvidence - a fresh advance stands on its own", () => {
  assertEquals(
    combineTreeEvidence("advanced", undefined, POLICY),
    "advanced",
  );
});

Deno.test("combineTreeEvidence - an advance seen inside the last check window still counts", () => {
  // The deadline can land moments after a sample, leaving the fresh probe a
  // near-zero window. The sample covers the rest of the interval, so a run
  // that demonstrably advanced is not killed by unlucky timing.
  assertEquals(
    combineTreeEvidence(
      "unchanged",
      { outcome: "advanced", ageMs: 120_000 },
      POLICY,
    ),
    "advanced",
  );
});

Deno.test("combineTreeEvidence - an advance older than the check window is spent", () => {
  assertEquals(
    combineTreeEvidence(
      "unchanged",
      { outcome: "advanced", ageMs: 300_001 },
      POLICY,
    ),
    "unchanged",
    "evidence older than one check interval no longer justifies a grant",
  );
});

Deno.test("combineTreeEvidence - an unknown fresh probe stays unknown (no fail-open)", () => {
  assertEquals(
    combineTreeEvidence(
      "unknown",
      { outcome: "advanced", ageMs: 1_000 },
      POLICY,
    ),
    "unknown",
    "an unverifiable tree dies on schedule, sample or no sample",
  );
});

Deno.test("combineTreeEvidence - an unchanged sample adds nothing", () => {
  assertEquals(
    combineTreeEvidence(
      "unchanged",
      { outcome: "unchanged", ageMs: 1_000 },
      POLICY,
    ),
    "unchanged",
  );
});

Deno.test("combineTreeEvidence - samples are ignored without a check interval", () => {
  assertEquals(
    combineTreeEvidence("unchanged", { outcome: "advanced", ageMs: 1_000 }, {
      enabled: true,
      grantSeconds: 900,
      activityStallSeconds: 300,
    }),
    "unchanged",
  );
});
