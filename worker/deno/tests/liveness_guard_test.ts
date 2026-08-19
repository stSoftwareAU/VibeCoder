/**
 * Tests for liveness_guard.ts — the combined 8-hour liveness guard
 * (Issue #2478, part of #2472).
 *
 * Mirrors repo_blocked_alert_test.ts: real temp dirs (`Deno.makeTempDir`),
 * an injected `nowFn`, and injected signal collectors so the unit path
 * never touches a live clock or `gh`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  checkLivenessWindow,
  DEFAULT_LIVENESS_THRESHOLD_HOURS,
  type IdleTaskActivitySignal,
  LIVENESS_STATE_FILENAME,
} from "../lib/liveness_guard.ts";

const HOUR = 3600;
const T = 1_000_000;

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "liveness-test-" });
}

/** Constant idle-task signal helper. */
function idle(
  raised: number | null,
  claimed: number | null,
): () => Promise<IdleTaskActivitySignal> {
  return () =>
    Promise.resolve({ lastRaisedEpoch: raised, lastClaimedEpoch: claimed });
}

/** Constant productive-work signal helper. */
function productive(epoch: number | null): () => Promise<number | null> {
  return () => Promise.resolve(epoch);
}

/** Capture `[liveness] ALERT` lines emitted to the console during `fn`. */
async function captureAlerts(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[liveness] ALERT")) lines.push(line);
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// ============================================================================
// Default threshold
// ============================================================================

Deno.test("liveness guard - default threshold is 8 hours", () => {
  assertEquals(DEFAULT_LIVENESS_THRESHOLD_HOURS, 8);
});

// ============================================================================
// Core dual-zero alerting lifecycle
// ============================================================================

Deno.test("liveness guard - dual-zero fires exactly one alert after 8h and not before", async () => {
  const dir = await makeTempDir();
  try {
    const base = {
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      latestProductiveWorkEpochFn: productive(null),
    };

    // T: dual-zero first observed. No alert yet (countdown starts).
    let alerts: string[] = [];
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({ ...base, nowFn: () => T });
      assertEquals(r.ok, true);
      if (r.ok) assertEquals(r.value.alerted, false);
    });
    assertEquals(alerts.length, 0);

    // T + 8h - 1s: still below threshold, no alert.
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...base,
        nowFn: () => T + 8 * HOUR - 1,
      });
      if (r.ok) assertEquals(r.value.alerted, false);
    });
    assertEquals(alerts.length, 0);

    // T + 8h + 1s: threshold crossed — exactly one alert, flag flips true.
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...base,
        nowFn: () => T + 8 * HOUR + 1,
      });
      if (r.ok) {
        assertEquals(r.value.alerted, true);
        assertEquals(r.value.stalledForHours, 8);
      }
    });
    assertEquals(alerts.length, 1);

    // A second call within the same period must not re-alert.
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...base,
        nowFn: () => T + 9 * HOUR,
      });
      if (r.ok) assertEquals(r.value.alerted, false);
    });
    assertEquals(alerts.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Productive work suppresses — proves the BOTH requirement
// ============================================================================

Deno.test("liveness guard - recent productive work suppresses alert even with zero idle tasks", async () => {
  const dir = await makeTempDir();
  try {
    const base = {
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      // Productive work 1 hour ago — well inside the 8h window.
      latestProductiveWorkEpochFn: productive(T - 1 * HOUR),
    };

    let firstAlert: string[] = [];
    firstAlert = await captureAlerts(async () => {
      await checkLivenessWindow({ ...base, nowFn: () => T });
    });
    assertEquals(firstAlert.length, 0);

    // Even 9h after the recording point, the productive signal moved with the
    // injected function would normally be stale, but here it stays fresh
    // relative to each `now`, so no alert ever fires.
    const stillFresh = {
      ...base,
      latestProductiveWorkEpochFn: productive(T + 8 * HOUR),
    };
    const alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...stillFresh,
        nowFn: () => T + 8 * HOUR + 1,
      });
      if (r.ok) assertEquals(r.value.alerted, false);
    });
    assertEquals(alerts.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Raised-but-not-claimed must NOT suppress — proves claimed is the live signal
// ============================================================================

Deno.test("liveness guard - idle task raised but never claimed still fires the alert", async () => {
  const dir = await makeTempDir();
  try {
    const base = {
      workDir: dir,
      repos: ["org/repo"],
      // Raised very recently, but claimed is null and productive is null.
      latestIdleTaskActivityFn: idle(T + 7 * HOUR, null),
      latestProductiveWorkEpochFn: productive(null),
    };

    // T: dual-zero start (claimed + productive both null).
    await checkLivenessWindow({ ...base, nowFn: () => T });

    // T + 8h + 1s: a recent raise must NOT suppress — alert fires.
    const alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...base,
        nowFn: () => T + 8 * HOUR + 1,
      });
      if (r.ok) {
        assertEquals(r.value.alerted, true);
        assertEquals(r.value.lastIdleClaimedEpoch, null);
        assertEquals(r.value.lastIdleRaisedEpoch, T + 7 * HOUR);
      }
    });
    assertEquals(alerts.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Reset after activity resumes — a future dual-zero can alert again
// ============================================================================

Deno.test("liveness guard - state resets after activity resumes so a later dual-zero re-alerts", async () => {
  const dir = await makeTempDir();
  try {
    const silent = {
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      latestProductiveWorkEpochFn: productive(null),
    };

    // First dual-zero period → alert at T + 8h.
    await checkLivenessWindow({ ...silent, nowFn: () => T });
    let alerts = await captureAlerts(async () => {
      await checkLivenessWindow({ ...silent, nowFn: () => T + 8 * HOUR + 1 });
    });
    assertEquals(alerts.length, 1);

    // Activity resumes: a fresh claim arrives → state resets, no alert.
    const resumeNow = T + 9 * HOUR;
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...silent,
        latestIdleTaskActivityFn: idle(resumeNow, resumeNow),
        nowFn: () => resumeNow,
      });
      if (r.ok) {
        assertEquals(r.value.alerted, false);
        assertEquals(r.value.firstDetectedDualZero, 0);
      }
    });
    assertEquals(alerts.length, 0);

    // Silence again from a new point → a brand-new alert fires after 8h.
    const restart = resumeNow + 1 * HOUR;
    await checkLivenessWindow({ ...silent, nowFn: () => restart });
    alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        ...silent,
        nowFn: () => restart + 8 * HOUR + 1,
      });
      if (r.ok) assertEquals(r.value.alerted, true);
    });
    assertEquals(alerts.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Fleet-wide scope — the freshest signal across all repos proves liveness
// ============================================================================

Deno.test("liveness guard - fleet-wide: one live repo suppresses the alert for the whole fleet", async () => {
  const dir = await makeTempDir();
  try {
    // repo1 silent, repo2 has a recent claim.
    const repos = ["org/repo1", "org/repo2"];
    const idleFn = (repo: string): Promise<IdleTaskActivitySignal> =>
      repo === "org/repo2"
        ? Promise.resolve({ lastRaisedEpoch: T, lastClaimedEpoch: T })
        : Promise.resolve({ lastRaisedEpoch: null, lastClaimedEpoch: null });

    const alerts = await captureAlerts(async () => {
      const r = await checkLivenessWindow({
        workDir: dir,
        repos,
        latestIdleTaskActivityFn: idleFn,
        latestProductiveWorkEpochFn: productive(null),
        nowFn: () => T + 8 * HOUR + 1,
      });
      if (r.ok) {
        assertEquals(r.value.alerted, false);
        assertEquals(r.value.lastIdleClaimedEpoch, T);
      }
    });
    assertEquals(alerts.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// State persistence — entry written to the documented state file
// ============================================================================

Deno.test("liveness guard - persists the scope entry to the state file", async () => {
  const dir = await makeTempDir();
  try {
    await checkLivenessWindow({
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      latestProductiveWorkEpochFn: productive(null),
      nowFn: () => T,
    });
    const content = await Deno.readTextFile(
      `${dir}/${LIVENESS_STATE_FILENAME}`,
    );
    // firstDetectedDualZero recorded at T, not yet alerted.
    assertEquals(content.includes(String(T)), true);
    assertEquals(content.includes("false"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Best-effort fleet-health comment posted once per period
// ============================================================================

Deno.test("liveness guard - posts a single fleet-health comment via the injected gh runner", async () => {
  const dir = await makeTempDir();
  try {
    const ghCalls: string[][] = [];
    const ghCommandFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve("");
    };
    const base = {
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      latestProductiveWorkEpochFn: productive(null),
      ghCommandFn,
      fleetHealthIssue: { repo: "org/repo", number: 42 },
    };

    await checkLivenessWindow({ ...base, nowFn: () => T });
    await checkLivenessWindow({ ...base, nowFn: () => T + 8 * HOUR + 1 });

    // Exactly one comment posted (once per period).
    const comments = ghCalls.filter((a) =>
      a[0] === "issue" && a[1] === "comment"
    );
    assertEquals(comments.length, 1);
    assertEquals(comments[0]?.includes("42"), true);

    // A further silent check does not post again.
    await checkLivenessWindow({ ...base, nowFn: () => T + 9 * HOUR });
    const after = ghCalls.filter((a) => a[0] === "issue" && a[1] === "comment");
    assertEquals(after.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Injected log sink (Issue #2479)
// ============================================================================

Deno.test("liveness guard - ALERT routes through the injected log sink, not console.log", async () => {
  const dir = await makeTempDir();
  try {
    const base = {
      workDir: dir,
      repos: ["org/repo"],
      latestIdleTaskActivityFn: idle(null, null),
      latestProductiveWorkEpochFn: productive(null),
    };

    const injected: string[] = [];
    // Capture console.log too, to prove the ALERT did NOT leak to the tty.
    const consoleLines = await captureAlerts(async () => {
      // Start the countdown, then cross the threshold.
      await checkLivenessWindow({
        ...base,
        nowFn: () => T,
        log: (m) => injected.push(m),
      });
      const r = await checkLivenessWindow({
        ...base,
        nowFn: () => T + 8 * HOUR + 1,
        log: (m) => injected.push(m),
      });
      assertEquals(r.ok, true);
      if (r.ok) assertEquals(r.value.alerted, true);
    });

    // Exactly one ALERT line reached the injected sink.
    const injectedAlerts = injected.filter((m) =>
      m.includes("[liveness] ALERT")
    );
    assertEquals(injectedAlerts.length, 1);
    assertEquals(injectedAlerts[0]?.includes("stalled_for_hours=8"), true);
    // And none leaked to console.log (the default sink).
    assertEquals(consoleLines.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
