/**
 * A callback that fails on every issue is reported once (Issue #1092).
 *
 * Regression cover for the GRQ-23 incident of 2026-09-05: the `always` hook
 * failed on every issue across at least five runs, cost ~100s of slot time
 * each time, and raised nothing. The properties that matter are that the
 * condition surfaces at all, that it surfaces exactly once per streak rather
 * than once per issue, and that a success clears it so the report always
 * says something true about now.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CALLBACK_FAILURE_ESCALATION_THRESHOLD,
  CALLBACK_FAILURE_STREAK_FILE,
  type CallbackFailureReport,
  callbackFailureReportBody,
  type CallbackFailureStreaks,
  callbackFailureTitle,
  callbackRecoveryBody,
  type CallbackRecoveryReport,
  recordCallbackOutcomes,
  workerCheckoutDir,
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

Deno.test(
  "#1092 - a hook failing on every issue is reported exactly once per streak, not once per issue",
  async () => {
    const store = memoryStore();
    const reports: CallbackFailureReport[] = [];
    const escalate = (report: CallbackFailureReport) => {
      reports.push(report);
      return Promise.resolve();
    };

    // Ten issues in a row, all failing the same way.
    for (let issue = 1; issue <= 10; issue++) {
      await recordCallbackOutcomes(
        "/work",
        [invocation()],
        { repository: RUN.repository, issueNumber: issue },
        { ...store, escalate },
      );
    }

    assertEquals(reports.length, 1, JSON.stringify(reports));
    const report = reports[0]!;
    assertEquals(report.event, "always");
    assertEquals(report.streak, CALLBACK_FAILURE_ESCALATION_THRESHOLD);
    assertEquals(report.issueNumber, CALLBACK_FAILURE_ESCALATION_THRESHOLD);
    assertEquals(report.path, "/opt/vibe-hooks/always.sh");
    assertStringIncludes(
      report.stderr,
      "Write access to repository not granted",
    );
    // The count keeps climbing so a later read knows how long it has run.
    assertEquals(store.read().always, 10);
  },
);

Deno.test(
  "#1092 - a single success clears the streak, so the next fault is reported afresh",
  async () => {
    const store = memoryStore();
    const reports: CallbackFailureReport[] = [];
    const escalate = (report: CallbackFailureReport) => {
      reports.push(report);
      return Promise.resolve();
    };
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, { ...store, escalate });

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(reports.length, 1);

    await record(invocation({ status: "ok", exitCode: 0 }));
    assertEquals(store.read().always, 0);

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(reports.length, 2, "a fresh streak is a fresh incident");
  },
);

Deno.test(
  "#1092 - a timed-out and an un-spawnable hook extend the same streak as a non-zero exit",
  async () => {
    const store = memoryStore();
    const reports: CallbackFailureReport[] = [];
    const escalate = (report: CallbackFailureReport) => {
      reports.push(report);
      return Promise.resolve();
    };
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, { ...store, escalate });

    await record(invocation({ status: "timed_out", exitCode: 124 }));
    await record(invocation({ status: "spawn_failed", exitCode: -1 }));
    await record(invocation({ status: "failed", exitCode: 1 }));

    assertEquals(reports.length, 1);
    assertEquals(reports[0]!.status, "failed");
    assertEquals(reports[0]!.streak, 3);
  },
);

Deno.test(
  "#1092 - streaks are per event: a failing always does not report a healthy success hook",
  async () => {
    const store = memoryStore();
    const reports: CallbackFailureReport[] = [];
    const escalate = (report: CallbackFailureReport) => {
      reports.push(report);
      return Promise.resolve();
    };

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await recordCallbackOutcomes(
        "/work",
        [
          invocation({ event: "success", status: "ok", exitCode: 0 }),
          invocation({ event: "always" }),
        ],
        RUN,
        { ...store, escalate },
      );
    }

    assertEquals(reports.length, 1);
    assertEquals(reports[0]!.event, "always");
    assertEquals(store.read().success, 0);
    assertEquals(store.read().always, CALLBACK_FAILURE_ESCALATION_THRESHOLD);
  },
);

Deno.test(
  "#1092 - an escalation that cannot be delivered is reported loud and never alters the run",
  async () => {
    const store = memoryStore();
    const errors: string[] = [];

    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await recordCallbackOutcomes("/work", [invocation()], RUN, {
        ...store,
        escalate: () => Promise.reject(new Error("gh issue create exited 1")),
        logError: (message) => errors.push(message),
      });
    }

    assertEquals(errors.length, 1, JSON.stringify(errors));
    assertStringIncludes(errors[0]!, "gh issue create exited 1");
    assertStringIncludes(errors[0]!, "always");
  },
);

Deno.test(
  "#1092 - no callbacks configured means nothing is read, written or reported",
  async () => {
    let touched = false;
    const streaks = await recordCallbackOutcomes("/work", [], RUN, {
      readStreaks: () => {
        touched = true;
        return Promise.resolve({});
      },
      writeStreaks: () => {
        touched = true;
        return Promise.resolve();
      },
      escalate: () => {
        touched = true;
        return Promise.resolve();
      },
    });
    assertEquals(streaks, {});
    assertEquals(touched, false);
  },
);

Deno.test(
  "#1092 - the streak survives the run boundary the condition survives",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "issue1092-streak-" });
    try {
      // Run 1 of the host: two failures, below the threshold, nothing raised.
      const reports: CallbackFailureReport[] = [];
      const escalate = (report: CallbackFailureReport) => {
        reports.push(report);
        return Promise.resolve();
      };
      await recordCallbackOutcomes(workDir, [invocation()], RUN, { escalate });
      await recordCallbackOutcomes(workDir, [invocation()], RUN, { escalate });
      assertEquals(reports.length, 0);

      const persisted = JSON.parse(
        await Deno.readTextFile(`${workDir}/${CALLBACK_FAILURE_STREAK_FILE}`),
      );
      assertEquals(persisted.always, 2);

      // Run 2 of the host, a fresh process: the third failure tips it over.
      await recordCallbackOutcomes(workDir, [invocation()], RUN, { escalate });
      assertEquals(reports.length, 1);
      assertEquals(reports[0]!.streak, 3);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "workerCheckoutDir - honours VIBE_BASE_DIR, else resolves the repository root (Issue #1092)",
  () => {
    assertEquals(
      workerCheckoutDir(() => "/opt/vibe-coder"),
      "/opt/vibe-coder",
    );
    const fallback = workerCheckoutDir(() => undefined);
    // The module lives at worker/deno/lib/, so the fallback is the repo root.
    assert(
      fallback.endsWith("/") && !fallback.includes("/worker/deno/lib"),
      fallback,
    );
  },
);

// ---------------------------------------------------------------------------
// Issues #2039 / #2041: the report closes itself when the hook recovers.
//
// On 2026-09-11 a contract bump broke every deployed hook on every host. The
// worker raised one report per host per hook — eight issues — and each body
// promised "a single successful invocation clears it". The counter cleared;
// the issues stayed open until a human closed all eight by hand. A report
// that needs a human to retire it after the condition has gone is exactly
// the manual step the streak exists to remove.
// ---------------------------------------------------------------------------

function recoveryDeps(store: ReturnType<typeof memoryStore>) {
  const reports: CallbackFailureReport[] = [];
  const recoveries: CallbackRecoveryReport[] = [];
  return {
    reports,
    recoveries,
    deps: {
      ...store,
      escalate: (report: CallbackFailureReport) => {
        reports.push(report);
        return Promise.resolve();
      },
      resolve: (report: CallbackRecoveryReport) => {
        recoveries.push(report);
        return Promise.resolve();
      },
    },
  };
}

Deno.test(
  "#2039 - a success after a reported streak closes the report; a success after an unreported one closes nothing",
  async () => {
    const store = memoryStore();
    const { reports, recoveries, deps } = recoveryDeps(store);
    const record = (inv: CallbackInvocation) =>
      recordCallbackOutcomes("/work", [inv], RUN, deps);
    const success = invocation({
      status: "ok",
      exitCode: 0,
      durationMs: 2_300,
    });

    // Below the threshold nothing was filed, so there is nothing to close.
    await record(invocation());
    await record(invocation());
    await record(success);
    assertEquals(reports.length, 0);
    assertEquals(recoveries.length, 0, "no report, so no closure");

    // The GRQ-23 shape of 2026-09-12: reported, then the hook is upgraded and
    // the next issue's invocation succeeds.
    for (let i = 0; i < CALLBACK_FAILURE_ESCALATION_THRESHOLD; i++) {
      await record(invocation());
    }
    assertEquals(reports.length, 1);
    await recordCallbackOutcomes(
      "/work",
      [success],
      { repository: "stSoftwareAU/GRQ-AutoTrader", issueNumber: 266 },
      deps,
    );
    assertEquals(recoveries, [{
      event: "always",
      path: "/opt/vibe-hooks/always.sh",
      streak: CALLBACK_FAILURE_ESCALATION_THRESHOLD,
      repository: "stSoftwareAU/GRQ-AutoTrader",
      issueNumber: 266,
    }]);
    assertEquals(store.read().always, 0);

    // The streak is over: a later success has nothing left to close.
    await record(success);
    assertEquals(recoveries.length, 1);
  },
);

Deno.test(
  "#2039 - a long streak's recovery reports how long it ran, and each event closes its own report",
  async () => {
    const store = memoryStore();
    const { recoveries, deps } = recoveryDeps(store);
    for (let i = 0; i < 10; i++) {
      await recordCallbackOutcomes(
        "/work",
        [invocation({ event: "failure" }), invocation({ event: "always" })],
        RUN,
        deps,
      );
    }
    await recordCallbackOutcomes(
      "/work",
      [
        invocation({ event: "failure", status: "ok", exitCode: 0 }),
        invocation({ event: "always", status: "ok", exitCode: 0 }),
      ],
      RUN,
      deps,
    );
    assertEquals(recoveries.map((r) => [r.event, r.streak]), [
      ["failure", 10],
      ["always", 10],
    ]);
  },
);

Deno.test(
  "#2039 - a closure that cannot be delivered is reported loud, and the streak still clears",
  async () => {
    const store = memoryStore({
      always: CALLBACK_FAILURE_ESCALATION_THRESHOLD,
    });
    const errors: string[] = [];
    const streaks = await recordCallbackOutcomes(
      "/work",
      [invocation({ status: "ok", exitCode: 0 })],
      RUN,
      {
        ...store,
        escalate: () => Promise.resolve(),
        resolve: () => Promise.reject(new Error("gh issue close exited 1")),
        logError: (message) => errors.push(message),
      },
    );
    assertEquals(streaks.always, 0);
    assertEquals(errors.length, 1, JSON.stringify(errors));
    assertStringIncludes(errors[0]!, "gh issue close exited 1");
    assertStringIncludes(errors[0]!, "always");
  },
);

Deno.test(
  "#2039 - the report names the schema version the worker exports and promises to close itself",
  () => {
    const report: CallbackFailureReport = {
      event: "always",
      path: "/workspace/.grq-vibecoder/callbacks/always.sh",
      streak: 3,
      repository: "stSoftwareAU/NEAT-AI-core",
      issueNumber: 680,
      status: "failed",
      exitCode: 1,
      durationSeconds: 0.02,
      stderr:
        "[grq:always] ERROR: unsupported callback schema version 2 (this extension understands 1); refusing to guess at the contract",
    };
    assertEquals(
      callbackFailureTitle("always", "GRQ-23"),
      "Post-run always callback failing on GRQ-23",
    );
    const body = callbackFailureReportBody(report, "GRQ-23");
    assertStringIncludes(body, "stSoftwareAU/NEAT-AI-core#680");
    assertStringIncludes(
      body,
      `callback schema version ${CALLBACK_SCHEMA_VERSION}`,
    );
    assertStringIncludes(body, "upgrade the extension");
    assertStringIncludes(body, "closes this issue itself");
    // The 2026-09-11 outage was the worker's contract bump, not the
    // deployment's doing; the report must not pin the blame in advance.
    assert(!body.includes("not a worker one"), body);

    const recovery = callbackRecoveryBody(
      {
        event: "always",
        path: report.path,
        streak: 7,
        repository: "stSoftwareAU/GRQ-AutoTrader",
        issueNumber: 266,
      },
      "GRQ-23",
    );
    assertStringIncludes(recovery, "stSoftwareAU/GRQ-AutoTrader#266");
    assertStringIncludes(recovery, "7 consecutive");
    assertStringIncludes(recovery, "GRQ-23");
  },
);
