/**
 * Tests for the per-observer, time-bounded disagreement streak
 * (Issue #1051).
 *
 * The wiring into the idle hooks is covered by
 * `run_core_idle_task_filer_test.ts`; these exercise the module's own
 * promises — that the bound is elapsed time, that observers do not clear
 * one another, that a run survives a restart, and that no shape of state
 * file can throw at a launcher.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  createIdleDisagreementTracker,
  IDLE_DISAGREEMENT_BOUND_MS,
  IDLE_DISAGREEMENT_CONTINUITY_MS,
  IDLE_DISAGREEMENT_STATE_FILE,
  idleDisagreementStatePath,
  loadIdleDisagreementState,
} from "../lib/idle_disagreement_streak.ts";

const MINUTE = 60 * 1000;

/** A work directory that lives only as long as the test using it. */
async function withWorkDir(
  fn: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "idle_disagreement_" });
  try {
    await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test(
  "idle disagreement - the bound is elapsed time, not observations",
  async () => {
    await withWorkDir(async (workDir) => {
      const tracker = createIdleDisagreementTracker({ workDir });
      // A hundred observations inside the bound stay inside it.
      const start = 10 * 1000;
      let now = 0;
      for (let i = 0; i < 100; i++) {
        now += start;
        const decision = await tracker.record("s1", now);
        assertEquals(decision.action, "within-bound", `at ${now}ms`);
      }
      // One more, past the bound, trips it — the run began at the first
      // observation, so that is what the elapsed time is measured from.
      const past = await tracker.record(
        "s1",
        start + IDLE_DISAGREEMENT_BOUND_MS + 1,
      );
      assertEquals(past.action, "bound-exceeded");
      assertEquals(past.elapsedMs, IDLE_DISAGREEMENT_BOUND_MS + 1);
    });
  },
);

Deno.test(
  "idle disagreement - exactly one forced attempt per bound",
  async () => {
    await withWorkDir(async (workDir) => {
      const tracker = createIdleDisagreementTracker({ workDir });
      let now = 0;
      let exceeded = 0;
      // Six bounds' worth of disagreement, sampled every minute.
      const span = 6 * IDLE_DISAGREEMENT_BOUND_MS;
      while (now < span) {
        now += MINUTE;
        if ((await tracker.record("s1", now)).action === "bound-exceeded") {
          exceeded++;
        }
      }
      assertEquals(
        exceeded,
        5,
        "one forced attempt per completed bound, never one per observation",
      );
    });
  },
);

Deno.test(
  "idle disagreement - one observer's clear leaves another's run alone",
  async () => {
    await withWorkDir(async (workDir) => {
      const tracker = createIdleDisagreementTracker({ workDir });
      await tracker.record("s1", 0);
      await tracker.record("s2", 0);
      // `s2` claimed work; `s1` is still being refused.
      await tracker.clear("s2");

      assertEquals(await tracker.peek("s2"), undefined);
      const s1 = await tracker.peek("s1");
      assertEquals(s1?.sinceMs, 0);

      const later = await tracker.record("s1", IDLE_DISAGREEMENT_BOUND_MS + 1);
      assertEquals(
        later.action,
        "bound-exceeded",
        "the starved slot must reach the bound however busy its sibling was",
      );
    });
  },
);

Deno.test(
  "idle disagreement - a run survives a new tracker over the same directory",
  async () => {
    await withWorkDir(async (workDir) => {
      const first = createIdleDisagreementTracker({ workDir });
      await first.record("cycle", 0);
      await first.record("cycle", 5 * MINUTE);

      // A new worker process reads the file the last one wrote.
      const second = createIdleDisagreementTracker({ workDir });
      const decision = await second.record("cycle", 25 * MINUTE);
      assertEquals(decision.action, "bound-exceeded");
      assertEquals(decision.elapsedMs, 25 * MINUTE);
      assertEquals(decision.observations, 3);
      assertEquals(decision.persisted, true);
    });
  },
);

Deno.test(
  "idle disagreement - a long absence starts a fresh run",
  async () => {
    await withWorkDir(async (workDir) => {
      const tracker = createIdleDisagreementTracker({ workDir });
      await tracker.record("cycle", 0);
      // The host was off for a day. It was not disagreeing for a day; it
      // was not looking, so a stale run must not force a wrapper at once.
      const after = await tracker.record(
        "cycle",
        IDLE_DISAGREEMENT_CONTINUITY_MS + MINUTE,
      );
      assertEquals(after.action, "within-bound");
      assertEquals(after.elapsedMs, 0);
      assertEquals(after.observations, 1);
    });
  },
);

Deno.test(
  "idle disagreement - a clock that went backwards restarts rather than trips",
  async () => {
    await withWorkDir(async (workDir) => {
      const tracker = createIdleDisagreementTracker({ workDir });
      await tracker.record("cycle", 10 * MINUTE);
      const back = await tracker.record("cycle", MINUTE);
      assertEquals(back.action, "within-bound");
      assertEquals(back.elapsedMs, 0);
    });
  },
);

Deno.test(
  "idle disagreement - no work directory keeps the run in memory",
  async () => {
    const tracker = createIdleDisagreementTracker({});
    assertEquals(tracker.path, undefined);
    const first = await tracker.record("s1", 0);
    assertEquals(first.persisted, false);
    const past = await tracker.record("s1", IDLE_DISAGREEMENT_BOUND_MS + 1);
    assertEquals(past.action, "bound-exceeded");
  },
);

Deno.test(
  "idle disagreement - an unwritable state file is reported, not thrown",
  async () => {
    const messages: string[] = [];
    const tracker = createIdleDisagreementTracker({
      // A directory that does not exist: `atomicWrite` refuses it.
      workDir: "/nonexistent-idle-disagreement-dir",
      log: (m) => messages.push(m),
    });
    const decision = await tracker.record("s1", 0);
    assertEquals(decision.action, "within-bound");
    assertEquals(
      messages.some((m) => m.includes("could not persist")),
      true,
      `expected the failed write to be reported; got ${
        JSON.stringify(messages)
      }`,
    );
  },
);

Deno.test(
  "idle disagreement - every unreadable state file reads as empty",
  async () => {
    await withWorkDir(async (workDir) => {
      const path = idleDisagreementStatePath(workDir);
      assertEquals(path, `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`);

      // Missing.
      assertEquals(await loadIdleDisagreementState(path), {});

      // Truncated — the read that would have thrown must not.
      const truncated = '{"cycle": {"sinceMs":';
      assertThrows(() => JSON.parse(truncated));
      await Deno.writeTextFile(path, truncated);
      assertEquals(await loadIdleDisagreementState(path), {});

      // An array, a scalar, and the pre-#1051 `{count, lastCycleId}` shape.
      for (
        const content of [
          "[]",
          '"cycle"',
          JSON.stringify({ s1: { count: 5, lastCycleId: "c7" } }),
          JSON.stringify({ s1: { sinceMs: "soon" }, s2: -1, cycle: null }),
        ]
      ) {
        await Deno.writeTextFile(path, content);
        assertEquals(await loadIdleDisagreementState(path), {}, content);
      }

      // A partially-valid entry keeps what it can and defaults the rest.
      await Deno.writeTextFile(
        path,
        JSON.stringify({ s1: { sinceMs: 1234 }, s2: { count: 3 } }),
      );
      assertEquals(await loadIdleDisagreementState(path), {
        s1: { sinceMs: 1234, lastSeenMs: 1234, observations: 0 },
      });
    });
  },
);
