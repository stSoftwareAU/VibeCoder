/**
 * The idle-starvation detector treats a paced fleet as by design (#1915).
 *
 * Issue #1915 defers idle-task filing while the week-pace guard (Issue #1885)
 * is engaged: nothing filed could be claimed before the weekly window resets.
 * The Issue #1052 detector watches the *outcome* — "no idle task anywhere
 * while slot capacity sits idle" — so, left alone, it would escalate the
 * worker's own policy to a human after twelve hours, which is exactly the
 * class of false signal #1915 exists to remove.
 *
 * The episode is therefore **ended** while the guard holds, not paused: the
 * guard can stand for the rest of the week, and a paused episode would file
 * the moment it lifted on hours banked while nothing was wrong.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  describeIdleHooksRefusal,
  idleStarvationStatePath,
  loadIdleStarvationEpisode,
  recordIdleStarvationObservation,
} from "../lib/idle_starvation_escalation.ts";

const HOUR_MS = 3_600_000;
/** 2026-09-10T00:00:00Z — GRQ-25's day. */
const START_MS = Date.UTC(2026, 8, 10, 0, 0, 0);

const EVIDENCE = {
  slotUtilisation: "slot-utilisation: slots=2 idle_pct=31.4",
  refusalReason: "week_pace_engaged",
  claimableTotal: 87,
  censusLines: ["[idle-census] repo=stSoftwareAU/GRQ availability=available"],
};

/** One observation of a fleet holding no idle task, at `hour`. */
function observe(opts: {
  hour: number;
  idleSlotSeconds: number;
  weekPaceEngaged?: boolean;
}) {
  return {
    nowMs: START_MS + opts.hour * HOUR_MS,
    runId: "run-a",
    idleSlotSeconds: opts.idleSlotSeconds,
    openIdleTasks: 0,
    expectedIdleTasks: 2,
    ...(opts.weekPaceEngaged === undefined
      ? {}
      : { weekPaceEngaged: opts.weekPaceEngaged }),
    evidence: EVIDENCE,
  };
}

/** A `gh` that refuses every call — nothing here may reach GitHub. */
function refusingGh(args: string[]): Promise<string> {
  return Promise.reject(new Error(`gh must not be called: ${args.join(" ")}`));
}

async function withState(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "idle_starvation_pace_" });
  try {
    await fn(idleStarvationStatePath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test(
  "#1915 - an engaged pace guard defers the episode instead of escalating",
  async () => {
    await withState(async (statePath) => {
      // Both #1052 thresholds are met — 24 hours and 20,000 idle slot-seconds
      // — so without the pace gate this observation files an issue.
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({
          hour: 24,
          idleSlotSeconds: 20_000,
          weekPaceEngaged: true,
        }),
        ghFn: refusingGh,
        log: () => {},
      });
      assertEquals(decision.action, "pace-deferred");
      assertEquals(
        await loadIdleStarvationEpisode(statePath),
        null,
        "the episode must not run while the fleet declines to file by design",
      );
    });
  },
);

Deno.test(
  "#1915 - an episode already running is ended when the guard engages",
  async () => {
    await withState(async (statePath) => {
      const watching = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour: 1, idleSlotSeconds: 3_000 }),
        ghFn: refusingGh,
        log: () => {},
      });
      assertEquals(watching.action, "watching");

      const deferred = await recordIdleStarvationObservation({
        statePath,
        observation: observe({
          hour: 2,
          idleSlotSeconds: 6_000,
          weekPaceEngaged: true,
        }),
        ghFn: refusingGh,
        log: () => {},
      });
      assertEquals(deferred.action, "pace-deferred");
      assertEquals(await loadIdleStarvationEpisode(statePath), null);

      // The guard lifts: the clock restarts here rather than filing on hours
      // banked while the fleet was deliberately not filing.
      const resumed = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour: 26, idleSlotSeconds: 90_000 }),
        ghFn: refusingGh,
        log: () => {},
      });
      assertEquals(resumed.action, "watching");
    });
  },
);

Deno.test(
  "#1915 - with the guard off the detector still escalates (unchanged)",
  async () => {
    await withState(async (statePath) => {
      await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour: 0, idleSlotSeconds: 0 }),
        ghFn: refusingGh,
        log: () => {},
      });
      let created = 0;
      const decision = await recordIdleStarvationObservation({
        statePath,
        observation: observe({ hour: 24, idleSlotSeconds: 20_000 }),
        ghFn: (args: string[]) => {
          if (args[1] === "list") return Promise.resolve("[]");
          created++;
          return Promise.resolve(
            "https://github.com/stSoftwareAU/VibeCoder/issues/4242\n",
          );
        },
        log: () => {},
      });
      assertEquals(decision.action, "filed");
      assertEquals(created, 1);
    });
  },
);

Deno.test(
  "#1915 - the pace guard outranks the other refusal reasons in the evidence",
  () => {
    assertEquals(
      describeIdleHooksRefusal({
        inversionDetected: true,
        claimableTotal: 87,
        weekPaceEngaged: true,
      }),
      "week_pace_engaged",
    );
    // Off, the existing vocabulary is untouched.
    assertEquals(
      describeIdleHooksRefusal({
        inversionDetected: false,
        claimableTotal: 87,
        weekPaceEngaged: false,
      }),
      "audit_found_claimable",
    );
  },
);
