/**
 * A callback that fails on every issue is recorded once, locally (Issue #2111).
 *
 * Regression cover for the GRQ-23 incident of 2026-09-05: the `always` hook
 * failed on every issue across at least five runs, cost ~100s of slot time
 * each time, and raised nothing a human saw. The properties that matter are
 * that the condition surfaces at all, that it surfaces exactly once per streak
 * rather than once per issue, that a success clears it so the record always
 * says something true about now — and, since Issue #2111, that the whole
 * exchange stays inside the container: the log and the count file are the
 * record, and the module has no seam that could reach `gh`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as streakModule from "../lib/callback_failure_streak.ts";
import {
  CALLBACK_FAILURE_ESCALATION_THRESHOLD,
  CALLBACK_FAILURE_STREAK_FILE,
  type CallbackFailureStreaks,
  recordCallbackOutcomes,
} from "../lib/callback_failure_streak.ts";
import {
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
} from "../lib/run_callbacks.ts";

const RUN = { repository: "stSoftwareAU/VibeCoder", issueNumber: 984 };

function invocation(
  overrides: Partial<CallbackInvocation> = {},
): CallbackInvocation {
  return {
    event: "always",
    path: "/opt/vibe-hooks/always.sh",
    status: "failed",
    exitCode: 1,
    stdout: "",
    stderr:
      "remote: Write access to repository not granted.\nfatal: … error 403",
    durationMs: 100_900,
    ...overrides,
  };
}

/** An in-memory streak store, so no test touches the host's work directory. */
function memoryStore(initial: CallbackFailureStreaks = {}) {
  let streaks: CallbackFailureStreaks = { ...initial };
  return {
    readStreaks: () => Promise.resolve({ ...streaks }),
    writeStreaks: (_workDir: string, next: CallbackFailureStreaks) => {
      streaks = { ...next };
      return Promise.resolve();
    },
    read: () => streaks,
  };
}

/** Captures both log sinks, which are now the entire output of the module. */
function sinks() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    deps: {
      log: (message: string) => logs.push(message),
      logError: (message: string) => errors.push(message),
    },
  };
}

Deno.test(
  "#2111 - the threshold crossing writes one error record carrying every fact",
  async () => {
    const store = memoryStore();
    const { logs, errors, deps } = sinks();

    // Ten issues in a row, all failing the same way.
    for (let issue = 1; issue <= 10; issue++) {
      await recordCallbackOutcomes(
        "/work",
        [invocation()],
        { repository: RUN.repository, issueNumber: issue },
        { ...store, ...deps },
      );
    }

    assertEquals(errors.length, 1, JSON.stringify(errors));
    const record = errors[0]!;
    assertStringIncludes(record, "always");
    assertStringIncludes(record, "/opt/vibe-hooks/always.sh");
    assertStringIncludes(
      record,
      `${CALLBACK_FAILURE_ESCALATION_THRESHOLD} consecutive`,
    );
    // The crossing run, not the tenth: the record is written once, at three.
    assertStringIncludes(
      record,
      `${RUN.repository}#${CALLBACK_FAILURE_ESCALATION_THRESHOLD}`,
    );
    assertStringIncludes(record, "failed, exit 1, 100.9s");
    assertStringIncludes(record, "Write access to repository not granted");
    assertStringIncludes(
      record,
      `callback schema version this worker exports: ${CALLBACK_SCHEMA_VERSION}`,
    );
    assertStringIncludes(record, "docs/CALLBACKS.md");
    // One multi-line record, not a line per fact.
    assert(record.includes("\n"), record);
    // Nothing else to say: later failures in the streak add no output at all.
    assertEquals(logs, []);
    // The count keeps climbing so a later read knows how long it has run.
    assertEquals(store.read().always, 10);
  },
);

Deno.test(
  "#2111 - the stderr in the record is redacted",
  async () => {
    const store = memoryStore();
    const { errors, deps } = sinks();
    const leaky = invocation({
      stderr: "fatal: auth failed with GITHUB_TOKEN=ghp_" + "a".repeat(36),
    });
    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await recordCallbackOutcomes("/work", [leaky], RUN, {
        ...store,
        ...deps,
      });
    }
    assertEquals(errors.length, 1);
    assert(!errors[0]!.includes("ghp_" + "a".repeat(36)), errors[0]);
    assertStringIncludes(errors[0]!, "REDACTED");
  },
);

Deno.test(
  "#2111 - a single success clears the streak, so the next fault is recorded afresh",
  async () => {
    const store = memoryStore();
    const { errors, deps } = sinks();
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, { ...store, ...deps });

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(errors.length, 1);

    await record(invocation({ status: "ok", exitCode: 0 }));
    assertEquals(store.read().always, 0);

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(errors.length, 2, "a fresh streak is a fresh record");
  },
);

Deno.test(
  "#2111 - recovery after a recorded streak logs exactly one line and resets the count",
  async () => {
    const store = memoryStore();
    const { logs, errors, deps } = sinks();
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, { ...store, ...deps });
    const success = invocation({
      status: "ok",
      exitCode: 0,
      durationMs: 2_300,
    });

    // Below the threshold nothing was recorded, so recovery says nothing.
    await record(invocation());
    await record(invocation());
    await record(success);
    assertEquals(errors.length, 0);
    assertEquals(logs, [], "no record, so nothing to retire");
    assertEquals(store.read().always, 0);

    // The GRQ-23 shape of 2026-09-12: recorded, then the hook is upgraded and
    // the next issue's invocation succeeds.
    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(errors.length, 1);
    const streaks = await recordCallbackOutcomes(
      "/work",
      [success],
      { repository: "stSoftwareAU/GRQ-AutoTrader", issueNumber: 266 },
      { ...store, ...deps },
    );

    assertEquals(logs.length, 1, JSON.stringify(logs));
    assertStringIncludes(logs[0]!, "always");
    assertStringIncludes(logs[0]!, "/opt/vibe-hooks/always.sh");
    assertStringIncludes(logs[0]!, "stSoftwareAU/GRQ-AutoTrader#266");
    assertStringIncludes(
      logs[0]!,
      `${CALLBACK_FAILURE_ESCALATION_THRESHOLD} consecutive`,
    );
    assertEquals(logs[0]!.includes("\n"), false, "one line, not a record");
    assertEquals(streaks.always, 0);
    assertEquals(store.read().always, 0);

    // The streak is over: a later success has nothing left to retire.
    await record(success);
    assertEquals(logs.length, 1);
  },
);

Deno.test(
  "#2111 - a timed-out and an un-spawnable hook extend the same streak as a non-zero exit",
  async () => {
    const store = memoryStore();
    const { errors, deps } = sinks();
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, { ...store, ...deps });

    await record(invocation({ status: "timed_out", exitCode: 124 }));
    await record(invocation({ status: "spawn_failed", exitCode: -1 }));
    await record(invocation({ status: "failed", exitCode: 1 }));

    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!, "failed, exit 1");
    assertStringIncludes(errors[0]!, "3 consecutive");
  },
);

Deno.test(
  "#2111 - streaks are per event: a failing always does not record a healthy success hook",
  async () => {
    const store = memoryStore();
    const { errors, deps } = sinks();

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await recordCallbackOutcomes(
        "/work",
        [
          invocation({ event: "success", status: "ok", exitCode: 0 }),
          invocation({ event: "always" }),
        ],
        RUN,
        { ...store, ...deps },
      );
    }

    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!, "The always callback");
    assertEquals(store.read().success, 0);
    assertEquals(store.read().always, CALLBACK_FAILURE_ESCALATION_THRESHOLD);
  },
);

Deno.test(
  "#2111 - each event's recovery retires its own record",
  async () => {
    const store = memoryStore();
    const { logs, deps } = sinks();
    for (let i = 0; i < 10; i++) {
      await recordCallbackOutcomes(
        "/work",
        [invocation({ event: "failure" }), invocation({ event: "always" })],
        RUN,
        { ...store, ...deps },
      );
    }
    await recordCallbackOutcomes(
      "/work",
      [
        invocation({ event: "failure", status: "ok", exitCode: 0 }),
        invocation({ event: "always", status: "ok", exitCode: 0 }),
      ],
      RUN,
      { ...store, ...deps },
    );
    assertEquals(logs.length, 2, JSON.stringify(logs));
    assertStringIncludes(logs[0]!, "The failure callback");
    assertStringIncludes(logs[0]!, "10 consecutive");
    assertStringIncludes(logs[1]!, "The always callback");
    assertStringIncludes(logs[1]!, "10 consecutive");
  },
);

Deno.test(
  "#2111 - no callbacks configured means nothing is read, written or recorded",
  async () => {
    let touched = false;
    const { logs, errors, deps } = sinks();
    const streaks = await recordCallbackOutcomes("/work", [], RUN, {
      ...deps,
      readStreaks: () => {
        touched = true;
        return Promise.resolve({});
      },
      writeStreaks: () => {
        touched = true;
        return Promise.resolve();
      },
    });
    assertEquals(streaks, {});
    assertEquals(touched, false);
    assertEquals(logs, []);
    assertEquals(errors, []);
  },
);

Deno.test(
  "#2111 - the streak survives the run boundary the condition survives",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "issue2111-streak-" });
    try {
      // Run 1 of the host: two failures, below the threshold, nothing said.
      const { errors, deps } = sinks();
      await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      assertEquals(errors.length, 0);

      const persisted = JSON.parse(
        await Deno.readTextFile(`${workDir}/${CALLBACK_FAILURE_STREAK_FILE}`),
      );
      assertEquals(persisted.always, 2);

      // Run 2 of the host, a fresh process: the third failure tips it over.
      await recordCallbackOutcomes(workDir, [invocation()], RUN, deps);
      assertEquals(errors.length, 1);
      assertStringIncludes(errors[0]!, "3 consecutive");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "#2111 - the module exposes no seam that could reach GitHub",
  () => {
    // The only callable export is the recorder itself: no escalator, no
    // resolver, no body or title builder for an issue that is never filed.
    const callable = Object.entries(streakModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    assertEquals(callable, ["recordCallbackOutcomes"]);

    // And its injectable seams are storage and logging only, so no caller can
    // hand it something that writes to GitHub.
    const deps: Required<streakModule.CallbackFailureStreakDeps> = {
      readStreaks: () => Promise.resolve({}),
      writeStreaks: () => Promise.resolve(),
      log: () => {},
      logError: () => {},
    };
    assertEquals(Object.keys(deps).sort(), [
      "log",
      "logError",
      "readStreaks",
      "writeStreaks",
    ]);
  },
);
