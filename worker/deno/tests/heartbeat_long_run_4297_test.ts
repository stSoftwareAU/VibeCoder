/**
 * The claim heartbeat tolerates a multi-hour run (Issue #4297, part of
 * #4290).
 *
 * With progress extensions an execute run may legitimately outlive the flat
 * one-hour `claudeTimeout`. Nothing in the claim machinery may treat such a
 * run as abandoned: the heartbeat loop must keep beating for its whole
 * length, and both staleness checks must read a refreshed heartbeat as live
 * however long the run has been going. The failure this guards against is a
 * second worker adopting a claim that already has an active run — duplicate
 * heartbeat comments, duplicate PRs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { startHeartbeat, stopHeartbeat } from "../lib/heartbeat.ts";
import {
  formatHeartbeatMarker,
  recordHeartbeat,
} from "../lib/heartbeat_storage.ts";
import {
  isIssueStuck,
  shouldSkipRecoveryForMarker,
  STUCK_ISSUE_DEFAULTS,
} from "../lib/stuck_detection.ts";

/** The production cadence: one beat a minute (`DEFAULT_HEARTBEAT_INTERVAL_MS`). */
const BEAT_SECONDS = 60;

Deno.test("heartbeat - the beat loop is unbounded: it keeps recording well past the beat count of a one-hour run (Issue #4297)", async () => {
  // The one-hour run this issue extends is 60 beats. Drive many more than
  // that on a compressed interval: nothing in the loop caps the count, so a
  // multi-hour run keeps its claim alive.
  const workDir = await Deno.makeTempDir({ prefix: "hb_long_run_" });
  let beats = 0;
  try {
    const started = await startHeartbeat({
      repo: "o/a",
      issueNumber: 1,
      workDir,
      intervalMs: 2,
      recordFn: () => {
        beats++;
        return Promise.resolve({ ok: true as const, value: undefined });
      },
      clearFn: () => Promise.resolve({ ok: true as const, value: undefined }),
    });
    assert(started.ok, "the heartbeat must start");
    if (!started.ok) return;

    const deadline = Date.now() + 5_000;
    while (beats < 75 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await stopHeartbeat(started.value);
    assert(
      beats >= 75,
      `the loop stopped beating after ${beats} beats — a long run would be reaped`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("heartbeat - a four-hour run beating every minute is never stuck, at any point past 3600s (Issue #4297)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "hb_long_stuck_" });
  const repo = "o/a";
  const issueNumber = 42;
  const startEpoch = 1_700_000_000;
  const runSeconds = 4 * 3600;
  try {
    for (let elapsed = 0; elapsed <= runSeconds; elapsed += BEAT_SECONDS) {
      const now = startEpoch + elapsed;
      const recorded = await recordHeartbeat(
        workDir,
        repo,
        issueNumber,
        () => now,
      );
      assert(recorded.ok, `beat at +${elapsed}s failed`);
      const stuck = await isIssueStuck(
        workDir,
        repo,
        issueNumber,
        STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
        () => now,
      );
      assertEquals(
        stuck,
        false,
        `a beating run was declared stuck at +${elapsed}s of run time`,
      );
    }

    // Control: stop beating, and the same run is reaped once the beat ages
    // past the stuck timeout — the check reads heartbeat freshness, not run
    // length, which is exactly why an extended run survives it.
    const silentUntil = startEpoch + runSeconds +
      STUCK_ISSUE_DEFAULTS.stuckIssueTimeout + 1;
    assertEquals(
      await isIssueStuck(
        workDir,
        repo,
        issueNumber,
        STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
        () => silentUntil,
      ),
      true,
      "a heartbeat that stops beating must still be reaped",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("heartbeat - another worker's recovery scan skips a four-hour run whose marker is fresh (Issue #4297)", async () => {
  const startEpoch = 1_700_000_000;
  const nowEpoch = startEpoch + 4 * 3600; // four hours into the run
  const markerComment = (epoch: number) =>
    Promise.resolve(JSON.stringify([{
      body: `🤖 Vibe Coder working\n${formatHeartbeatMarker("host-a", epoch)}`,
      author: "vibe-worker",
    }]));

  // The run's own machine refreshed the marker one beat ago.
  assertEquals(
    await shouldSkipRecoveryForMarker(
      "o/a",
      42,
      "host-b", // a DIFFERENT machine scanning for stuck issues
      STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
      () => nowEpoch,
      () => markerComment(nowEpoch - BEAT_SECONDS),
      ["vibe-worker"],
    ),
    true,
    "a four-hour run with a fresh marker must not be recovered",
  );

  // Control: the marker has not been refreshed since the run started, so the
  // claim really is abandoned and recovery proceeds.
  assertEquals(
    await shouldSkipRecoveryForMarker(
      "o/a",
      42,
      "host-b",
      STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
      () => nowEpoch,
      () => markerComment(startEpoch),
      ["vibe-worker"],
    ),
    false,
    "a marker that stopped being refreshed must not suppress recovery",
  );
});
