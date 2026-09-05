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
  type CallbackFailureStreaks,
  recordCallbackOutcomes,
  workerCheckoutDir,
} from "../lib/callback_failure_streak.ts";
import type { CallbackInvocation } from "../lib/run_callbacks.ts";

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
