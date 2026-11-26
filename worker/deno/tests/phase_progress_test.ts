/**
 * Tests for non-agent phase heartbeats (Issue #4305).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  startPhaseProgress,
  withPhaseProgress,
} from "../lib/phase_progress.ts";

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

Deno.test("withPhaseProgress - reports the pending wait and returns its result", async () => {
  const lines: string[] = [];
  const pending = Promise.withResolvers<number>();
  let now = 0;
  const run = withPhaseProgress({
    label: "cycle_end_breaker_interval",
    log: (line) => lines.push(line),
    now: () => now,
  }, () => pending.promise);
  assertEquals(lines, ["[phase] cycle_end_breaker_interval: started"]);
  now = 83_000;
  pending.resolve(300);
  assertEquals(await run, 300);
  assertEquals(lines, [
    "[phase] cycle_end_breaker_interval: started",
    "[phase] cycle_end_breaker_interval: completed in 1m23s",
  ]);
});

Deno.test("withPhaseProgress - reports a rejection and retains the original error", async () => {
  const lines: string[] = [];
  const cause = new Error("state file is read-only");
  const error = await assertRejects(
    () =>
      withPhaseProgress({
        label: "cycle_end_breaker_record",
        log: (line) => lines.push(line),
        now: () => 0,
      }, () => {
        throw cause;
      }),
    Error,
    "state file is read-only",
  );
  assertEquals(error, cause);
  assertEquals(lines, [
    "[phase] cycle_end_breaker_record: started",
    "[phase] cycle_end_breaker_record: threw in 0s",
  ]);
});
