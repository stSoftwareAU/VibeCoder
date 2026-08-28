/**
 * Tests for the work-volume ratchet classifier (Issue #384).
 *
 * The volume image is thin-provisioned: blocks are allocated to it when the
 * guest writes and are never returned when the guest deletes. These tests
 * pin the two things that failed on GRQ-23 — the classifier that recognises
 * the condition, and the operator-facing sentences that name the remedy
 * instead of logging `reclaimed 0 bytes` for ever.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyWorkVolumeRatchet,
  DEFAULT_RATCHET_FLOOR_BYTES,
  describeGuestReclaimToHost,
  describeWorkVolumeRatchet,
  WORK_VOLUME_RATCHET_NAME,
} from "../lib/work_volume_ratchet.ts";
import { WORK_VOLUME_NAME } from "../lib/container_launch.ts";

const GIB = 1_073_741_824;

Deno.test("classifyWorkVolumeRatchet - the peak the guest reached is what the host lost", () => {
  // GRQ-23: the volume peaked at 36.5 GB, the guest now holds 13 GB.
  const r = classifyWorkVolumeRatchet(13 * GIB, 36.5 * GIB);
  assertEquals(r.ratcheted, true);
  assertEquals(r.deadBytes, 23.5 * GIB);
  assertEquals(r.peakBytes, 36.5 * GIB);
  assertEquals(r.usedBytes, 13 * GIB);
});

Deno.test("classifyWorkVolumeRatchet - a volume that has not shrunk is not ratcheted", () => {
  const r = classifyWorkVolumeRatchet(13 * GIB, 13 * GIB);
  assertEquals(r.ratcheted, false);
  assertEquals(r.deadBytes, 0);
});

Deno.test("classifyWorkVolumeRatchet - a gap under the floor is noise, not the ratchet", () => {
  const under = classifyWorkVolumeRatchet(13 * GIB, 13 * GIB + 1024);
  assertEquals(under.ratcheted, false);
  assertEquals(
    under.deadBytes,
    1024,
    "the gap is still measured, just not named",
  );

  const exactly = classifyWorkVolumeRatchet(
    13 * GIB,
    13 * GIB + DEFAULT_RATCHET_FLOOR_BYTES,
  );
  assertEquals(exactly.ratcheted, true);
});

Deno.test("classifyWorkVolumeRatchet - an unknown reading is never a ratchet claim", () => {
  assertEquals(classifyWorkVolumeRatchet(null, 36 * GIB).ratcheted, false);
  assertEquals(classifyWorkVolumeRatchet(13 * GIB, null).ratcheted, false);
  assertEquals(classifyWorkVolumeRatchet(null, null).deadBytes, 0);
});

Deno.test("classifyWorkVolumeRatchet - a peak below the current reading cannot go negative", () => {
  const r = classifyWorkVolumeRatchet(20 * GIB, 5 * GIB);
  assertEquals(r.deadBytes, 0);
  assertEquals(r.ratcheted, false);
});

Deno.test("describeWorkVolumeRatchet - names the dead space and the volume, or says nothing", () => {
  const detail = describeWorkVolumeRatchet(
    classifyWorkVolumeRatchet(13 * GIB, 36.5 * GIB),
  );
  assertStringIncludes(detail, "23.5 GB");
  assertStringIncludes(detail, "vibe-work");
  assertStringIncludes(detail, "Issues #384, #478");

  assertEquals(
    describeWorkVolumeRatchet(classifyWorkVolumeRatchet(13 * GIB, 13 * GIB)),
    "",
    "a volume that has not ratcheted must add nothing to the line",
  );
});

Deno.test("describeGuestReclaimToHost - a guest sweep that freed bytes says the host gained none", () => {
  const line = describeGuestReclaimToHost(
    11 * GIB,
    classifyWorkVolumeRatchet(13 * GIB, 36.5 * GIB),
  );
  assertStringIncludes(line, "0 bytes returned to the host");
  assertStringIncludes(line, "11.0 GB");
  assertStringIncludes(line, "only grows");
  // Issue #478: the remedy is the launcher's, not an operator's. The old
  // line promised the launch-time fstrim would hand the blocks back — false
  // on the Apple container runtime, which refuses FITRIM — and then told a
  // human to run `volume delete vibe-work` on an unattended host.
  assertStringIncludes(line, "recreates the volume");
  assert(
    !line.includes("stop the container and"),
    `the remedy must not be addressed to a human: ${line}`,
  );
  assertStringIncludes(line, "Issues #384, #478");
});

Deno.test("describeGuestReclaimToHost - a sweep that freed nothing still explains the category error", () => {
  const line = describeGuestReclaimToHost(
    0,
    classifyWorkVolumeRatchet(13 * GIB, 36.5 * GIB),
  );
  assertStringIncludes(line, "0 bytes returned to the host");
  assertStringIncludes(line, "23.5 GB");
  assert(
    !line.includes("0.0 GB freed"),
    `a sweep that freed nothing must not claim it did: ${line}`,
  );
});

Deno.test("describeGuestReclaimToHost - no ratchet still states that the host figure is not the guest's", () => {
  const line = describeGuestReclaimToHost(
    2 * GIB,
    classifyWorkVolumeRatchet(13 * GIB, 13 * GIB),
  );
  assertStringIncludes(line, "0 bytes returned to the host");
  assertStringIncludes(line, "Issues #384, #478");
});

Deno.test("work-volume name - the ratchet message names the volume the launcher mounts", () => {
  assertEquals(
    WORK_VOLUME_RATCHET_NAME,
    WORK_VOLUME_NAME,
    "the remedy an operator is told to run must name the real volume",
  );
});
