/**
 * Tests for the two-signal disk-telemetry verdict (Issue #345).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assessDiskTelemetry } from "../lib/disk_telemetry.ts";

const READABLE = {
  hostDiskKnown: true,
  hostDiskDetail: "42.0 GB free (8.7%) of 480.0 GB",
  workVolumeKnown: true,
  workVolumeDetail: "total 18.4 GB",
};

Deno.test("assessDiskTelemetry - both signals readable is not a condition", () => {
  const verdict = assessDiskTelemetry(READABLE);
  assertEquals(verdict.blind, false);
  assertEquals(verdict.notes, []);
});

Deno.test("assessDiskTelemetry - both signals blind marks the host unhealthy and names both (Issue #345)", () => {
  const verdict = assessDiskTelemetry({
    ...READABLE,
    hostDiskKnown: false,
    hostDiskDetail: "no launch baseline and df unreadable",
    workVolumeKnown: false,
    workVolumeDetail: "12 directories measured and every bucket read 0 bytes",
  });
  assertEquals(verdict.blind, true);
  assertStringIncludes(verdict.detail, "df unreadable");
  assertStringIncludes(verdict.detail, "every bucket read 0 bytes");
  assertEquals(verdict.notes.length, 1);
  assertStringIncludes(verdict.notes[0]!, "cannot see its own disk filling");
});

Deno.test("assessDiskTelemetry - one blind signal is named but the host stays healthy", () => {
  const hostOnly = assessDiskTelemetry({
    ...READABLE,
    hostDiskKnown: false,
    hostDiskDetail: "no launch baseline and df unreadable",
  });
  assertEquals(hostOnly.blind, false);
  assertEquals(hostOnly.notes.length, 1);
  assertStringIncludes(hostOnly.notes[0]!, "host-disk telemetry blind");

  const volumeOnly = assessDiskTelemetry({
    ...READABLE,
    workVolumeKnown: false,
    workVolumeDetail: "the work root could not be read",
  });
  assertEquals(volumeOnly.blind, false);
  assertEquals(volumeOnly.notes.length, 1);
  assertStringIncludes(volumeOnly.notes[0]!, "work-volume telemetry blind");
  assert(volumeOnly.notes[0]!.includes("could not be read"));
});
