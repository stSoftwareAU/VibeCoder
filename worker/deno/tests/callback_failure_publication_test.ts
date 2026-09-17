/**
 * The callback-failure streak is published where host-side health reporting
 * can read it (Issue #2297).
 *
 * Regression cover for the GRQ-25 incident of 2026-09-16: the `success` hook
 * failed on every terminal run for two days, `recordCallbackOutcomes` wrote its
 * one `ERROR` record into `worker.log` — and nothing consumed it, so the board
 * read the host as dead. Worse, the record fired four times rather than once
 * because the count lived only in `WORK_DIR`, the volume the launcher reset
 * three times that day.
 *
 * The properties that matter here are that the streak reaches the host log
 * directory as JSON carrying the facts the record carries, that a wiped work
 * volume does not restart the count or the "failing since" timestamp, and that
 * the per-cycle liveness line and the fleet summary say a hook is failing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CALLBACK_FAILURE_STREAK_FILE,
  callbackFailureStreakCounts,
  callbackFailureStreakPath,
  formatHookFailureFields,
  hostLogDirectory,
  parseCallbackFailureSnapshot,
  readCallbackFailureSnapshot,
} from "../lib/callback_failure_publication.ts";
import {
  CALLBACK_FAILURE_ESCALATION_THRESHOLD,
  recordCallbackOutcomes,
} from "../lib/callback_failure_streak.ts";
import type { CallbackInvocation } from "../lib/run_callbacks.ts";
import {
  formatFleetSummary,
  recordHookFailure,
  resetFleetTelemetry,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";

const RUN = { repository: "stSoftwareAU/GRQ-AutoTrader", issueNumber: 1092 };

/** The GRQ-25 shape: the `success` hook, exit 1 after 189 seconds. */
function invocation(
  overrides: Partial<CallbackInvocation> = {},
): CallbackInvocation {
  return {
    event: "success",
    path: "/workspace/.grq-vibecoder/callbacks/success.sh",
    status: "failed",
    exitCode: 1,
    stdout: "",
    stderr: "fatal: could not read Username for 'https://github.com'",
    durationMs: 189_100,
    ...overrides,
  };
}

/** A work directory and a host log directory, removed together. */
async function dirs() {
  const root = await Deno.makeTempDir({ prefix: "issue2297-" });
  const workDir = `${root}/work`;
  const hostLogDir = `${root}/logs`;
  await Deno.mkdir(workDir);
  await Deno.mkdir(hostLogDir);
  return {
    root,
    workDir,
    hostLogDir,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

/** A clock that advances a minute per reading, so timestamps are ordered. */
function clock(startIso: string) {
  let ms = Date.parse(startIso);
  return () => {
    const reading = ms;
    ms += 60_000;
    return reading;
  };
}

Deno.test(
  "#2297 - the streak is published to the host log directory with the facts the record carries",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      const errors: string[] = [];
      const deps = {
        hostLogDir,
        now: clock("2026-09-16T08:58:00Z"),
        logError: (message: string) => errors.push(message),
      };
      for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
        await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      }
      assertEquals(errors.length, 1, JSON.stringify(errors));
      assertStringIncludes(
        errors[0]!,
        "failing since 2026-09-16T08:58:00.000Z",
      );

      const published = parseCallbackFailureSnapshot(
        await Deno.readTextFile(
          `${hostLogDir}/${CALLBACK_FAILURE_STREAK_FILE}`,
        ),
      );
      assert(published, "the host copy must parse");
      const entry = published.events.success;
      assert(entry, "the host copy must carry the failing event");
      assertEquals(entry.event, "success");
      assertEquals(entry.streak, CALLBACK_FAILURE_ESCALATION_THRESHOLD);
      assertEquals(
        entry.path,
        "/workspace/.grq-vibecoder/callbacks/success.sh",
      );
      // Failing since the first failure of this streak, not the latest one.
      assertEquals(entry.firstFailureAt, "2026-09-16T08:58:00.000Z");
      assertEquals(entry.lastFailureAt, "2026-09-16T09:00:00.000Z");
      assertEquals(entry.exitCode, 1);
      assertEquals(entry.durationSeconds, 189.1);
      assertEquals(entry.status, "failed");
      assertStringIncludes(entry.stderr ?? "", "could not read Username");

      // The work-volume copy carries the same facts — the host copy is a
      // second home for it, not a replacement.
      const work = parseCallbackFailureSnapshot(
        await Deno.readTextFile(callbackFailureStreakPath(workDir)),
      );
      assertEquals(work?.events.success?.streak, entry.streak);
      assertEquals(work?.events.success?.firstFailureAt, entry.firstFailureAt);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - a wiped work volume neither restarts the count nor re-records the streak",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      const errors: string[] = [];
      const deps = {
        hostLogDir,
        now: clock("2026-09-16T08:58:00Z"),
        logError: (message: string) => errors.push(message),
      };
      for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
        await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      }
      assertEquals(errors.length, 1);

      // 07:42Z, 18:58Z and 20:46Z on 2026-09-16: the launcher recreated the
      // `vibe-work` volume, taking the count with it (Issue #2077).
      await Deno.remove(callbackFailureStreakPath(workDir));

      for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
        await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      }

      // The reset used to zero the count, so the third failure after it wrote
      // a second record claiming a three-issue streak. It now reads six.
      assertEquals(errors.length, 1, JSON.stringify(errors));
      const snapshot = await readCallbackFailureSnapshot({
        workDir,
        hostLogDir,
      });
      assertEquals(snapshot.events.success?.streak, 6);
      assertEquals(
        snapshot.events.success?.firstFailureAt,
        "2026-09-16T08:58:00.000Z",
        "failing-since survives the reset",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - a run that never invoked the failing hook still carries its streak across the reset",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      const errors: string[] = [];
      const deps = {
        hostLogDir,
        now: clock("2026-09-16T08:58:00Z"),
        logError: (message: string) => errors.push(message),
      };
      for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
        await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      }
      await Deno.remove(callbackFailureStreakPath(workDir));

      // The next run failed, so only `failure` and `always` fired — `success`
      // is not in this run's invocations at all. The rebuilt work-volume copy
      // must still carry the `success` streak it inherited from the host copy,
      // or the run after it restarts the count at one.
      await recordCallbackOutcomes(
        workDir,
        [invocation({ event: "failure" }), invocation({ event: "always" })],
        RUN,
        deps,
      );
      const rebuilt = parseCallbackFailureSnapshot(
        await Deno.readTextFile(callbackFailureStreakPath(workDir)),
      );
      assertEquals(rebuilt?.events.success?.streak, 3);

      await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      const snapshot = await readCallbackFailureSnapshot({
        workDir,
        hostLogDir,
      });
      assertEquals(snapshot.events.success?.streak, 4);
      assertEquals(
        snapshot.events.success?.firstFailureAt,
        "2026-09-16T08:58:00.000Z",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - the work-volume copy is preferred while it exists",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      await Deno.writeTextFile(
        callbackFailureStreakPath(workDir),
        JSON.stringify({ version: 1, events: { always: { streak: 7 } } }),
      );
      await Deno.writeTextFile(
        `${hostLogDir}/${CALLBACK_FAILURE_STREAK_FILE}`,
        JSON.stringify({ version: 1, events: { always: { streak: 2 } } }),
      );
      const snapshot = await readCallbackFailureSnapshot({
        workDir,
        hostLogDir,
      });
      assertEquals(snapshot.events.always?.streak, 7);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - an older worker's plain-number streak file still reads",
  async () => {
    const { workDir, cleanup } = await dirs();
    try {
      await Deno.writeTextFile(
        callbackFailureStreakPath(workDir),
        JSON.stringify({ success: 4, always: 0 }),
      );
      const snapshot = await readCallbackFailureSnapshot({ workDir });
      assertEquals(callbackFailureStreakCounts(snapshot), {
        success: 4,
        always: 0,
      });
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - a malformed copy reads as no streak, and says so rather than throwing",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      await Deno.writeTextFile(callbackFailureStreakPath(workDir), "{oops");
      const warnings: string[] = [];
      const snapshot = await readCallbackFailureSnapshot({
        workDir,
        hostLogDir,
        warn: (message) => warnings.push(message),
      });
      assertEquals(callbackFailureStreakCounts(snapshot), {});
      assertEquals(parseCallbackFailureSnapshot("{oops"), null);
      // A count silently lost restarts the streak and re-records a fault that
      // never went away — the file that could not be read is named.
      assertEquals(warnings.length, 1, JSON.stringify(warnings));
      assertStringIncludes(warnings[0]!, callbackFailureStreakPath(workDir));
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - a copy that is simply not there yet is silent — that is the first run",
  async () => {
    const { workDir, hostLogDir, cleanup } = await dirs();
    try {
      const warnings: string[] = [];
      const snapshot = await readCallbackFailureSnapshot({
        workDir,
        hostLogDir,
        warn: (message) => warnings.push(message),
      });
      assertEquals(callbackFailureStreakCounts(snapshot), {});
      assertEquals(warnings, []);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "#2297 - a host copy that cannot be written is reported, never swallowed",
  async () => {
    const { workDir, root, cleanup } = await dirs();
    try {
      // A file where the host log directory should be: the publish must fail.
      const hostLogDir = `${root}/not-a-directory`;
      await Deno.writeTextFile(hostLogDir, "");
      const errors: string[] = [];
      const warnings: string[] = [];
      await recordCallbackOutcomes(workDir, [invocation()], RUN, {
        hostLogDir,
        logError: (message: string) => errors.push(message),
        logWarn: (message: string) => warnings.push(message),
      });
      // The run continues, so it is a warning — but it is said out loud, and
      // the unreadable copy is named as well as the unwritable one.
      assertEquals(errors, [], JSON.stringify(errors));
      const failedWrite = warnings.find((w) => w.includes("Could not write"));
      assert(failedWrite, JSON.stringify(warnings));
      assertStringIncludes(failedWrite, CALLBACK_FAILURE_STREAK_FILE);
      assertStringIncludes(failedWrite, hostLogDir);
      assert(
        warnings.some((w) => w.includes("Could not read")),
        JSON.stringify(warnings),
      );

      // A caller that wires only a fault sink still hears about it.
      const faultsOnly: string[] = [];
      await recordCallbackOutcomes(workDir, [invocation()], RUN, {
        hostLogDir,
        logError: (message: string) => faultsOnly.push(message),
      });
      assertEquals(faultsOnly.length, 1, JSON.stringify(faultsOnly));
      // The work-volume copy still landed on both runs: one unwritable
      // directory never costs the other copy.
      const snapshot = await readCallbackFailureSnapshot({ workDir });
      assertEquals(snapshot.events.success?.streak, 2);
    } finally {
      await cleanup();
    }
  },
);

Deno.test("#2297 - the liveness line names every run hook's streak", () => {
  assertEquals(
    formatHookFailureFields({ success: 41, failure: 3 }),
    "hook_fail_success=41 hook_fail_failure=3 hook_fail_always=0",
  );
  assertEquals(
    formatHookFailureFields({}),
    "hook_fail_success=0 hook_fail_failure=0 hook_fail_always=0",
  );
});

Deno.test("#2297 - the host log directory is the HOME/logs mount", () => {
  assertEquals(
    hostLogDirectory((name) => name === "HOME" ? "/home/vibe" : undefined),
    "/home/vibe/logs",
  );
  // HOME then USERPROFILE, the order `agent_transcript.ts` resolves it in.
  assertEquals(
    hostLogDirectory((name) => name === "USERPROFILE" ? "C:/vibe" : undefined),
    "C:/vibe/logs",
  );
  assertEquals(hostLogDirectory(() => "  "), null);
  assertEquals(hostLogDirectory(() => undefined), null);
});

Deno.test(
  "#2297 - the fleet summary counts the hook failures beside the run outcomes",
  () => {
    resetFleetTelemetry();
    startFleetTelemetry(0);
    try {
      assertStringIncludes(formatFleetSummary(1_000), "hook_failures=0");
      recordHookFailure();
      recordHookFailure(2);
      assertStringIncludes(formatFleetSummary(1_000), "hook_failures=3");
      // Nothing to record is not a record: zero, a negative and a non-number
      // leave the count where it was rather than corrupting it.
      recordHookFailure(0);
      recordHookFailure(-2);
      recordHookFailure(Number.NaN);
      assertStringIncludes(formatFleetSummary(1_000), "hook_failures=3");
    } finally {
      resetFleetTelemetry();
    }
  },
);
