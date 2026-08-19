/**
 * Tests for non-agent phase heartbeats (Issue #4305).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startPhaseProgress } from "../lib/phase_progress.ts";

Deno.test("phase_progress - logs start, periodic heartbeats, and completion with elapsed", async () => {
  const lines: string[] = [];
  const handle = startPhaseProgress({
    label: "setup (o/r#7)",
    log: (m) => lines.push(m),
    intervalMs: 25,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
  } finally {
    handle.done();
  }

  assertStringIncludes(lines[0]!, "[phase] setup (o/r#7): started");
  const beats = lines.filter((l) => l.includes("still running"));
  assert(beats.length >= 2, `expected heartbeats, got: ${lines.join(" | ")}`);
  assertStringIncludes(beats[0]!, "elapsed");
  const last = lines[lines.length - 1]!;
  assertStringIncludes(last, "completed in");
});

Deno.test("phase_progress - done stops the heartbeat, is idempotent, and names the outcome", async () => {
  const lines: string[] = [];
  const handle = startPhaseProgress({
    label: "execute (o/r#7)",
    log: (m) => lines.push(m),
    intervalMs: 20,
  });
  handle.done("failure");
  handle.done("failure");
  const countAfterDone = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 70));

  assertEquals(lines.length, countAfterDone, "no lines after done()");
  const completions = lines.filter((l) => l.includes("failure in"));
  assertEquals(completions.length, 1, "done() must log exactly once");
});

Deno.test("phase_progress - elapsed formatting uses the injected clock", () => {
  const lines: string[] = [];
  let clock = 10_000;
  const handle = startPhaseProgress({
    label: "baseline_quality (o/r#7)",
    log: (m) => lines.push(m),
    intervalMs: 60_000,
    now: () => clock,
  });
  clock += 83_000;
  handle.done();
  assertStringIncludes(lines[lines.length - 1]!, "completed in 1m23s");
});
