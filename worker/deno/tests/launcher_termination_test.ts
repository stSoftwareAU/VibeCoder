/**
 * Tests for the launcher termination marker (Issue #1072).
 *
 * The marker is what tells a deliberate stop from a crash, so the cases that
 * matter are the ones where believing it would be wrong: a marker already
 * used, a marker left behind by a run whose outcome was never recorded, and a
 * marker that cannot be parsed. Each of those must fall back to "no
 * declaration" and say so, never silently classify the next genuine failure as
 * an operator's kill.
 *
 * Australian English spelling throughout (behaviour, signalled).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  consumeLaunchTerminationMarker,
  LAUNCH_TERMINATION_MARKER_MAX_AGE_SECONDS,
  launchTerminationMarkerPath,
  writeLaunchTerminationMarker,
} from "../lib/launcher_termination.ts";

/** A temporary state directory and its marker path. */
async function setup(): Promise<
  { stateDir: string; path: string; cleanup: () => Promise<void> }
> {
  const stateDir = await Deno.makeTempDir({ prefix: "vibe_launch_term_" });
  return {
    stateDir,
    path: launchTerminationMarkerPath(stateDir),
    cleanup: async () => {
      try {
        await Deno.remove(stateDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

Deno.test("launch termination marker - a signalled run is declared and consumed once", async () => {
  const harness = await setup();
  try {
    const declaredAtMs = Date.now();
    const written = await writeLaunchTerminationMarker(harness.stateDir, {
      signal: "TERM",
      declaredAtMs,
    });
    assert(written.ok, "the launcher must be able to declare its termination");

    const first = await consumeLaunchTerminationMarker(harness.path);
    assertEquals(first?.signal, "TERM");
    assertEquals(first?.declaredAtMs, declaredAtMs);

    // One declaration classifies one outcome: the next launcher outcome is
    // judged on its own evidence, exactly as the quota-pause marker behaves.
    assertEquals(await consumeLaunchTerminationMarker(harness.path), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("launch termination marker - no marker is the ordinary, silent case", async () => {
  const harness = await setup();
  const warnings: string[] = [];
  try {
    assertEquals(
      await consumeLaunchTerminationMarker(harness.path, {
        warn: (m) => warnings.push(m),
      }),
      null,
    );
    assertEquals(warnings, []);
    // An empty path is "there is nowhere to look", not an error.
    assertEquals(await consumeLaunchTerminationMarker(""), null);
  } finally {
    await harness.cleanup();
  }
});

Deno.test("launch termination marker - a stale leftover is refused, loudly", async () => {
  const harness = await setup();
  const warnings: string[] = [];
  try {
    const nowMs = 1_800_000_000_000;
    await writeLaunchTerminationMarker(harness.stateDir, {
      signal: "TERM",
      declaredAtMs: nowMs -
        (LAUNCH_TERMINATION_MARKER_MAX_AGE_SECONDS + 60) * 1000,
    });

    // A run whose outcome was never recorded must not lend its stop to the
    // next failure — that would suppress an escalation the host had earned.
    assertEquals(
      await consumeLaunchTerminationMarker(harness.path, {
        nowMs,
        warn: (m) => warnings.push(m),
      }),
      null,
    );
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertStringIncludes(warnings[0]!, "older than");

    // Consumed even so: a leftover must not be re-read for ever.
    await Deno.stat(harness.path).then(
      () => {
        throw new Error("the stale marker must be removed");
      },
      () => {},
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("launch termination marker - unusable content is discarded and reported", async () => {
  const harness = await setup();
  try {
    for (
      const [content, expected] of [
        ["not json at all", "unparseable"],
        [JSON.stringify({ signal: "TERM" }), "no declaration time"],
      ] as const
    ) {
      const warnings: string[] = [];
      await Deno.writeTextFile(harness.path, content);
      assertEquals(
        await consumeLaunchTerminationMarker(harness.path, {
          warn: (m) => warnings.push(m),
        }),
        null,
      );
      assertEquals(warnings.length, 1, warnings.join("\n"));
      assertStringIncludes(warnings[0]!, expected);
    }
  } finally {
    await harness.cleanup();
  }
});

Deno.test("launch termination marker - a declaration with no signal name still counts", async () => {
  const harness = await setup();
  try {
    // The fact that matters is "this run was stopped from outside"; a launcher
    // that could not name the signal must not have its stop read as a crash.
    await Deno.writeTextFile(
      harness.path,
      JSON.stringify({ declaredAtMs: Date.now() }),
    );
    const marker = await consumeLaunchTerminationMarker(harness.path);
    assertEquals(marker?.signal, "unknown");
  } finally {
    await harness.cleanup();
  }
});
