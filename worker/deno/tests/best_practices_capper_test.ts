/**
 * Tests for the best-practices finding capper (Issue #2148).
 *
 * The capper is a pure helper — these tests exercise the priority order,
 * the stable-sort tie-breaker, and the cap behaviour directly.
 */

import { assertEquals } from "@std/assert";

import {
  cap,
  type Finding,
  SEVERITY_PRIORITY,
} from "../lib/best_practices_capper.ts";

/** Compact factory — keeps the test bodies readable. */
function f(id: string, severity: Finding["severity"]): Finding {
  return { id, severity, title: `T-${id}`, body: `B-${id}` };
}

// ---------------------------------------------------------------------------
// Severity priority table
// ---------------------------------------------------------------------------

Deno.test("SEVERITY_PRIORITY - missing-linter ranks above every other severity", () => {
  assertEquals(
    SEVERITY_PRIORITY["missing-linter"] < SEVERITY_PRIORITY.high,
    true,
  );
  assertEquals(SEVERITY_PRIORITY.high < SEVERITY_PRIORITY.medium, true);
  assertEquals(SEVERITY_PRIORITY.medium < SEVERITY_PRIORITY.low, true);
});

// ---------------------------------------------------------------------------
// cap - empty / no-op cases
// ---------------------------------------------------------------------------

Deno.test("cap - empty input returns empty", () => {
  assertEquals(cap([], 6), []);
});

Deno.test("cap - max=0 returns empty even with input", () => {
  assertEquals(cap([f("a", "high")], 0), []);
});

Deno.test("cap - negative max returns empty", () => {
  assertEquals(cap([f("a", "high")], -1), []);
});

Deno.test("cap - max larger than input returns every finding in priority order", () => {
  const out = cap([f("a", "low"), f("b", "high"), f("c", "medium")], 99);
  assertEquals(out.map((x) => x.id), ["b", "c", "a"]);
});

// ---------------------------------------------------------------------------
// cap - priority order
// ---------------------------------------------------------------------------

Deno.test("cap - sorts missing-linter > high > medium > low", () => {
  const out = cap(
    [
      f("low-1", "low"),
      f("med-1", "medium"),
      f("high-1", "high"),
      f("lint-1", "missing-linter"),
    ],
    4,
  );
  assertEquals(out.map((x) => x.id), ["lint-1", "high-1", "med-1", "low-1"]);
});

Deno.test("cap - missing-linter always lands first", () => {
  const out = cap(
    [
      f("high-1", "high"),
      f("high-2", "high"),
      f("lint-1", "missing-linter"),
    ],
    3,
  );
  assertEquals(out[0]!.id, "lint-1");
});

// ---------------------------------------------------------------------------
// cap - stable tie-break within same severity
// ---------------------------------------------------------------------------

Deno.test("cap - ties preserve original input order within the same severity", () => {
  const out = cap(
    [
      f("high-A", "high"),
      f("high-B", "high"),
      f("high-C", "high"),
    ],
    3,
  );
  assertEquals(out.map((x) => x.id), ["high-A", "high-B", "high-C"]);
});

Deno.test("cap - interleaved severities sort correctly and preserve intra-severity order", () => {
  const out = cap(
    [
      f("med-X", "medium"),
      f("high-A", "high"),
      f("low-1", "low"),
      f("med-Y", "medium"),
      f("high-B", "high"),
    ],
    5,
  );
  assertEquals(
    out.map((x) => x.id),
    ["high-A", "high-B", "med-X", "med-Y", "low-1"],
  );
});

// ---------------------------------------------------------------------------
// cap - the actual cap
// ---------------------------------------------------------------------------

Deno.test("cap - drops surplus low-priority findings when exceeding max", () => {
  const out = cap(
    [
      f("high-1", "high"),
      f("high-2", "high"),
      f("med-1", "medium"),
      f("med-2", "medium"),
      f("low-1", "low"),
      f("low-2", "low"),
      f("low-3", "low"),
    ],
    6,
  );
  assertEquals(out.length, 6);
  assertEquals(
    out.map((x) => x.id),
    ["high-1", "high-2", "med-1", "med-2", "low-1", "low-2"],
  );
});

Deno.test("cap - max=6 with missing-linter still keeps 6 total (missing-linter counts against the cap)", () => {
  const out = cap(
    [
      f("lint-1", "missing-linter"),
      f("high-1", "high"),
      f("high-2", "high"),
      f("high-3", "high"),
      f("high-4", "high"),
      f("high-5", "high"),
      f("high-6", "high"),
    ],
    6,
  );
  assertEquals(out.length, 6);
  // missing-linter must remain in the kept set; the surplus high finding
  // gets dropped instead.
  assertEquals(out[0]!.id, "lint-1");
  assertEquals(out.map((x) => x.id).includes("high-6"), false);
});

// ---------------------------------------------------------------------------
// cap - immutability of input
// ---------------------------------------------------------------------------

Deno.test("cap - does not mutate the input array", () => {
  const input: Finding[] = [
    f("low-1", "low"),
    f("high-1", "high"),
    f("med-1", "medium"),
  ];
  const originalOrder = input.map((x) => x.id);
  cap(input, 6);
  assertEquals(input.map((x) => x.id), originalOrder);
});

// ---------------------------------------------------------------------------
// cap - reserved cost, speed and reliability slot (Issue #2579)
// ---------------------------------------------------------------------------

/** A cost, speed or reliability finding. */
function csr(id: string, severity: Finding["severity"]): Finding {
  return { ...f(id, severity), costSpeedReliability: true };
}

const MEDIUMS = ["m1", "m2", "m3", "m4", "m5", "m6"];

Deno.test("cap - a low cost finding takes the last slot from medium surplus (Issue #2579)", () => {
  const input = [...MEDIUMS.map((id) => f(id, "medium")), csr("c1", "low")];
  assertEquals(
    cap(input, 6).map((x) => x.id),
    ["m1", "m2", "m3", "m4", "m5", "c1"],
  );
});

Deno.test("cap - the reserved slot never displaces a severity:high finding (Issue #2579)", () => {
  const highs = ["h1", "h2", "h3", "h4", "h5", "h6"].map((id) => f(id, "high"));
  assertEquals(
    cap([...highs, csr("c1", "medium")], 6).map((x) => x.id),
    ["h1", "h2", "h3", "h4", "h5", "h6"],
  );
});

Deno.test("cap - only one slot is reserved, for the highest-priority cost finding (Issue #2579)", () => {
  const input = [
    ...MEDIUMS.map((id) => f(id, "medium")),
    csr("c-low", "low"),
    csr("c-med", "medium"),
  ];
  assertEquals(
    cap(input, 6).map((x) => x.id),
    ["m1", "m2", "m3", "m4", "m5", "c-med"],
  );
});

Deno.test("cap - no reservation is needed when a cost finding already fits (Issue #2579)", () => {
  const input = [f("h1", "high"), csr("c1", "low"), f("m1", "medium")];
  assertEquals(cap(input, 6).map((x) => x.id), ["h1", "m1", "c1"]);
});
