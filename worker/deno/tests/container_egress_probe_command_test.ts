/**
 * Tests for the container-egress-probe command (Issue #997).
 *
 * The command is the launcher's instruction sheet: its exit status decides
 * whether the host builds, waits or parks. These tests drive the real command
 * function — with a runtime executable that does not exist, so nothing is
 * launched — and assert on the statuses, the argument validation and the
 * evidence file it leaves behind.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EGRESS_BLOCKED_EXIT,
  NETWORK_DOWN_EXIT,
  probeEgress,
} from "../commands/container_egress_probe.ts";
import { NETWORK_UNAVAILABLE_MARKER } from "../lib/github_user_resolution.ts";

/** A supported runtime dialect at a path no host has. */
const ABSENT_RUNTIME = "/nonexistent/vibe-test/docker";

Deno.test("probeEgress - refuses to run without a runtime", async () => {
  const result = await probeEgress({});
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "--runtime");
});

Deno.test("probeEgress - refuses a runtime the launchers do not support", async () => {
  const result = await probeEgress({ runtime: "nsjail" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "not a container runtime");
});

Deno.test("probeEgress - refuses a target that is a name rather than an address", async () => {
  const result = await probeEgress({
    runtime: ABSENT_RUNTIME,
    target: "github.com:443",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "IP literal");
});

Deno.test("probeEgress - a probe that cannot run never blocks the launch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe_egress_cmd_" });
  try {
    const out = `${dir}/evidence.txt`;
    const result = await probeEgress({
      runtime: ABSENT_RUNTIME,
      image: "vibe-coder:absent",
      out,
    });

    // Exit 0 with a stated verdict: silence would be indistinguishable from
    // "the network is fine".
    assertEquals(result.success, true);
    assertEquals(result.exitCode, undefined);
    assertEquals(result.data?.verdict, "inconclusive");
    const evidence = await Deno.readTextFile(out);
    assertStringIncludes(evidence, "inconclusive");
    assertStringIncludes(evidence, "no image in the local store");
    // Nothing may claim the network is down when nothing was measured.
    assert(!evidence.includes(NETWORK_UNAVAILABLE_MARKER));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeEgress - the exit statuses the launchers branch on are distinct", () => {
  // The launchers hardcode these two numbers; a drift here is a host that
  // parks when it should wait, or waits when it should call a human.
  const statuses: number[] = [EGRESS_BLOCKED_EXIT, NETWORK_DOWN_EXIT];
  assertEquals(statuses, [3, 4]);
  assertEquals(new Set(statuses).size, 2);
});
