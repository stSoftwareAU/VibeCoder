/**
 * Tests for the checkout-update escalation, its spool and its attempt bound
 * (Issues #1018, #2110).
 *
 * The escalation of Issue #4204 fired once, at the exact moment the streak
 * equalled the threshold, and a transport that fails is the dominant failure
 * mode here — the fault being reported is often the fault that stops the
 * report. A failed send was therefore lost for ever: the host ran stale code
 * with nothing but a log line.
 *
 * Issue #2110 replaced the transport. The report is a `callbacks.host_failure`
 * invocation on the host, never a GitHub issue, and the retry is bounded.
 *
 * These tests drive the whole thing against the real on-disk state under a
 * temporary log directory — only the git side effects, the clock and the hook
 * invocation are stubbed:
 *   - the qualifying streak invokes the hook once, with the payload facts;
 *   - an invocation that did not return `ok` spools its attempt count and is
 *     retried on the next failing run;
 *   - the fifth failed attempt records `escalation_lost` and settles the
 *     streak, so the sixth run invokes nothing;
 *   - a successful update invokes nothing at all and clears both files;
 *   - `none` and `invalid` hook configuration invoke nothing and never block
 *     the update.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS,
  CHECKOUT_UPDATE_ESCALATION_SPOOL_FILE,
  CHECKOUT_UPDATE_FAILURE_STREAK_FILE,
  type CheckoutEscalationState,
  type CheckoutUpdateDeps,
  type CheckoutUpdateEscalationContext,
  emptyCheckoutStreak,
  parseCheckoutStreak,
  updateCheckout,
} from "../lib/checkout_update.ts";
import type { Result } from "../types.ts";
import {
  CONFIGURED_HOOK,
  HOOK_FAILED,
  HOOK_OK,
  HOOK_PATH,
} from "./support/checkout_escalation_hook.ts";

/**
 * An hourly clock, one tick per failing run.
 *
 * The escalation needs an elapsed span as well as a count since Issue #1017,
 * and these tests drive several "runs" inside a millisecond. An hour between
 * launches is the cadence the threshold was written for, so the streaks below
 * mean what they always meant.
 */
function hourlyClock(): () => number {
  let seconds = 1_700_000_000;
  return () => {
    const current = seconds;
    seconds += 3600;
    return current;
  };
}

/** The git failure these tests drive the streak with. */
const GIT_FAILURE =
  "git fetch origin failed (exit code 128): Could not resolve hostname github.com";

/** A checkout update that always fails, as a lost network makes it. */
const FAILING_RESET: Partial<CheckoutUpdateDeps> = {
  resetToDefaultBranch: () =>
    Promise.resolve({
      ok: false,
      error: new Error(GIT_FAILURE),
    } as Result<void>),
  describeCheckoutState: () => Promise.resolve(null),
  readHeadCommit: () => Promise.resolve(null),
  hostFailureHook: CONFIGURED_HOOK,
  now: hourlyClock(),
};

/** A checkout update that succeeds. */
const OK_RESET: Partial<CheckoutUpdateDeps> = {
  resetToDefaultBranch: () =>
    Promise.resolve({ ok: true, value: undefined } as Result<void>),
  describeCheckoutState: () => Promise.resolve(null),
  readHeadCommit: () => Promise.resolve(null),
  hostFailureHook: CONFIGURED_HOOK,
};

/** Run the body against a throwaway log directory and checkout path. */
async function withLogDir(
  body: (
    options: { repoDir: string; logDir: string; defaultBranch: string },
    paths: { streakFile: string; spoolFile: string },
  ) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "checkout_escalation_spool_" });
  try {
    const logDir = `${tmp}/logs`;
    await body(
      { repoDir: `${tmp}/repo`, logDir, defaultBranch: "trunk" },
      {
        streakFile: `${logDir}/${CHECKOUT_UPDATE_FAILURE_STREAK_FILE}`,
        spoolFile: `${logDir}/${CHECKOUT_UPDATE_ESCALATION_SPOOL_FILE}`,
      },
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Read the persisted escalation state, or null when the file is absent. */
async function readState(
  spoolFile: string,
): Promise<CheckoutEscalationState | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(spoolFile),
    ) as CheckoutEscalationState;
  } catch {
    return null;
  }
}

/** Does the path exist? */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("updateCheckout - the qualifying streak invokes the hook once, with the payload facts (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    const contexts: CheckoutUpdateEscalationContext[] = [];
    const hooks: { path: string; timeoutSeconds: number }[] = [];
    const delivering: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      describeCheckoutState: () =>
        Promise.resolve({ branch: "fix/local", dirtyFiles: 4 }),
      escalate: (context, hook) => {
        contexts.push(context);
        hooks.push(hook);
        return Promise.resolve(HOOK_OK);
      },
    };

    const outcomes = [];
    for (let run = 0; run < 5; run++) {
      outcomes.push(await updateCheckout(options, delivering));
    }

    assertEquals(
      contexts.length,
      1,
      "one delivered report per streak — later failures invoke nothing",
    );
    assertEquals(outcomes.map((outcome) => outcome.escalated), [
      false,
      false,
      true,
      false,
      false,
    ]);

    const context = contexts[0];
    assertEquals(context?.streak, 3);
    assertEquals(context?.attempt, 1);
    assertEquals(context?.repoDir, options.repoDir);
    assertEquals(
      context?.checkout,
      { branch: "fix/local", dirtyFiles: 4 },
      "the payload carries the checkout state the failure was diagnosed with",
    );
    assert(
      (context?.streakStartedAt ?? 0) > 0,
      "the payload can say when the streak started",
    );
    assertStringIncludes(context?.error ?? "", "Could not resolve hostname");
    assertEquals(hooks[0], {
      path: HOOK_PATH,
      timeoutSeconds: CONFIGURED_HOOK.kind === "hook"
        ? CONFIGURED_HOOK.timeoutSeconds
        : 0,
    });

    const state = await readState(paths.spoolFile);
    assertEquals(state?.escalatedStreak, 3, "the marker records the delivery");
    assertEquals(state?.pending, null, "delivery empties the spool");
  });
});

Deno.test("updateCheckout - an invocation that is not ok spools its attempts and is retried (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    const attempts: number[] = [];
    const offline: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      escalate: (context) => {
        attempts.push(context.attempt);
        return Promise.resolve(HOOK_FAILED);
      },
    };

    await updateCheckout(options, offline);
    await updateCheckout(options, offline);
    const third = await updateCheckout(options, offline);

    assertEquals(third.escalated, false, "a non-ok status is not a delivery");
    assertEquals(attempts, [1], "the first attempt is spent on the third run");
    const spooled = await readState(paths.spoolFile);
    assertEquals(spooled?.escalatedStreak, 0, "the streak is not settled yet");
    assertEquals(spooled?.pending?.attempts, 1);
    assertEquals(spooled?.pending?.streak, 3);
    assertStringIncludes(
      spooled?.pending?.error ?? "",
      "Could not resolve hostname github.com",
    );
    assert(
      !Number.isNaN(Date.parse(spooled?.pending?.spooledAt ?? "")),
      "the spooled entry records when delivery was first attempted",
    );

    // The next failing run retries — the attempt count carries across runs.
    await updateCheckout(options, offline);
    assertEquals(attempts, [1, 2]);
    assertEquals((await readState(paths.spoolFile))?.pending?.attempts, 2);

    // And the run whose hook works takes delivery, ending the retries.
    const delivered = await updateCheckout(options, {
      ...offline,
      escalate: (context) => {
        attempts.push(context.attempt);
        return Promise.resolve(HOOK_OK);
      },
    });
    assertEquals(delivered.escalated, true);
    assertEquals(attempts, [1, 2, 3]);
    assertEquals((await readState(paths.spoolFile))?.pending, null);

    // The delivered streak stays quiet from then on.
    await updateCheckout(options, offline);
    assertEquals(attempts, [1, 2, 3]);
  });
});

Deno.test("updateCheckout - the fifth failed attempt loses the report and settles the streak (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    const attempts: number[] = [];
    const logged: string[] = [];
    const broken: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      escalate: (context) => {
        attempts.push(context.attempt);
        return Promise.resolve(HOOK_FAILED);
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    };

    // Runs 1-2 are below the threshold; runs 3-7 each spend one attempt, and
    // run 8 must find the streak settled.
    for (let run = 0; run < 8; run++) {
      await updateCheckout(options, broken);
    }

    assertEquals(
      attempts,
      [1, 2, 3, 4, 5],
      "the retry is bounded at CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS",
    );
    assertEquals(CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS, attempts.length);
    assertEquals(
      logged.filter((message) => message.includes("escalation_lost")).length,
      1,
      "the loss is recorded exactly once",
    );
    const state = await readState(paths.spoolFile);
    assertEquals(
      state?.escalatedStreak,
      7,
      "the streak is settled, so no later run tries again",
    );
    assertEquals(
      state?.pending?.attempts,
      CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS,
      "the undelivered evidence is kept, so the recovery line can say so",
    );
  });
});

Deno.test("updateCheckout - a successful update invokes nothing and clears both files (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: () => Promise.resolve(HOOK_FAILED),
      });
    }
    assert(
      (await readState(paths.spoolFile))?.pending !== null,
      "precondition: an undelivered report is queued",
    );

    const invoked: CheckoutUpdateEscalationContext[] = [];
    const logged: string[] = [];
    const recovered = await updateCheckout(options, {
      ...OK_RESET,
      escalate: (context) => {
        invoked.push(context);
        return Promise.resolve(HOOK_OK);
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    });

    assertEquals(recovered.ok, true);
    assertEquals(
      invoked,
      [],
      "recovery reports nothing — the condition has already cleared",
    );
    assertEquals(
      parseCheckoutStreak(await Deno.readTextFile(paths.streakFile)),
      emptyCheckoutStreak(),
    );
    assertEquals(await exists(paths.spoolFile), false);
    const recoveryLine = logged.find((message) =>
      message.includes("failure streak has ended")
    );
    assert(recoveryLine !== undefined, "the streak's end is recorded locally");
    assertStringIncludes(recoveryLine, "still undelivered");

    // The next streak starts clean: it escalates again at the threshold.
    const attempts: number[] = [];
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: (context) => {
          attempts.push(context.streak);
          return Promise.resolve(HOOK_OK);
        },
      });
    }
    assertEquals(attempts, [3], "a cleared streak escalates afresh");
  });
});

Deno.test("updateCheckout - a recovery after a delivered report says the streak ended (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: () => Promise.resolve(HOOK_OK),
      });
    }

    const logged: string[] = [];
    await updateCheckout(options, {
      ...OK_RESET,
      escalate: () => {
        throw new Error("recovery must never invoke the hook");
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    });

    const recoveryLine = logged.find((message) =>
      message.includes("failure streak has ended")
    );
    assert(recoveryLine !== undefined);
    assertEquals(
      recoveryLine.includes("still undelivered"),
      false,
      "a delivered report is not reported as lost",
    );
    assertEquals(await exists(paths.spoolFile), false);
  });
});

Deno.test("updateCheckout - no hook configured is recorded once and never blocks the update (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    const invoked: number[] = [];
    const logged: string[] = [];
    const noHook: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      hostFailureHook: { kind: "none" },
      escalate: (context) => {
        invoked.push(context.attempt);
        return Promise.resolve(HOOK_OK);
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    };

    const outcomes = [];
    for (let run = 0; run < 5; run++) {
      outcomes.push(await updateCheckout(options, noHook));
    }

    assertEquals(invoked, [], "there is no hook to invoke");
    assertEquals(
      logged.filter((message) => message.includes("no_hook_configured")).length,
      1,
      "the absent hook is said once, not on every later failing run",
    );
    assertEquals(
      outcomes.map((outcome) => outcome.streak),
      [1, 2, 3, 4, 5],
      "the update itself proceeds and keeps counting",
    );
    assertEquals(outcomes.every((outcome) => outcome.escalated), false);
    assertEquals(
      (await readState(paths.spoolFile))?.escalatedStreak,
      3,
      "the streak is settled: nothing about this host will change by retrying",
    );
  });
});

Deno.test("updateCheckout - an unreadable callbacks block is recorded as config_invalid (Issue #2110)", async () => {
  await withLogDir(async (options) => {
    const invoked: number[] = [];
    const logged: string[] = [];
    const broken: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      hostFailureHook: {
        kind: "invalid",
        error: "callbacks.host_failure must be a string",
      },
      escalate: (context) => {
        invoked.push(context.attempt);
        return Promise.resolve(HOOK_OK);
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    };

    const outcomes = [];
    for (let run = 0; run < 4; run++) {
      outcomes.push(await updateCheckout(options, broken));
    }

    assertEquals(invoked, [], "a hook that will not parse is never spawned");
    const reported = logged.filter((message) =>
      message.includes("config_invalid")
    );
    assertEquals(reported.length, 1);
    assertStringIncludes(reported[0] ?? "", "must be a string");
    assertEquals(outcomes.map((outcome) => outcome.streak), [1, 2, 3, 4]);
  });
});

Deno.test("updateCheckout - a seam that throws is recorded and retried, never rethrown (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    const logged: string[] = [];
    const outcome = await updateCheckout(options, {
      ...FAILING_RESET,
      readFailureStreak: () =>
        Promise.resolve({ count: 2, firstFailureAt: 1_600_000_000 }),
      escalate: () => Promise.reject(new Error("the hook seam blew up")),
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    });

    assertEquals(outcome.ok, false);
    assertEquals(outcome.escalated, false);
    assertStringIncludes(outcome.error ?? "", "Could not resolve hostname");
    assert(
      logged.some((message) =>
        message.includes("escalation failed") &&
        message.includes("the hook seam blew up")
      ),
      "the seam fault names itself rather than being folded into the status",
    );
    assertEquals((await readState(paths.spoolFile))?.pending?.attempts, 1);
  });
});

Deno.test("updateCheckout - a corrupt escalation store re-escalates rather than silencing the host (Issue #1018)", async () => {
  await withLogDir(async (options, paths) => {
    await Deno.mkdir(options.logDir, { recursive: true });
    await Deno.writeTextFile(paths.spoolFile, "{ not json at all");

    const attempts: number[] = [];
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: (context) => {
          attempts.push(context.streak);
          return Promise.resolve(HOOK_OK);
        },
      });
    }

    assertEquals(
      attempts,
      [3],
      "an unreadable store means nothing is known to have been delivered",
    );
    assertEquals(
      (await readState(paths.spoolFile))?.escalatedStreak,
      3,
      "and the repaired store then keeps the rest of the streak quiet",
    );
  });
});

Deno.test("updateCheckout - a spool entry written before the attempt count reads as one attempt (Issue #2110)", async () => {
  await withLogDir(async (options, paths) => {
    await Deno.mkdir(options.logDir, { recursive: true });
    // The pre-#2110 shape: evidence, no attempts field.
    await Deno.writeTextFile(
      paths.spoolFile,
      JSON.stringify({
        escalatedStreak: 0,
        pending: {
          repoDir: options.repoDir,
          streak: 3,
          error: GIT_FAILURE,
          checkout: null,
          spooledAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    const attempts: number[] = [];
    await updateCheckout(options, {
      ...FAILING_RESET,
      readFailureStreak: () =>
        Promise.resolve({ count: 3, firstFailureAt: 1_600_000_000 }),
      escalate: (context) => {
        attempts.push(context.attempt);
        return Promise.resolve(HOOK_FAILED);
      },
    });

    assertEquals(
      attempts,
      [2],
      "the queued entry exists because an attempt failed, so it counts as one",
    );
  });
});

Deno.test("updateCheckout - a marker left over from an earlier streak does not silence the host (Issue #1018)", async () => {
  await withLogDir(async (options, paths) => {
    // A recovery whose clear could not remove the file: the marker survives a
    // streak it no longer describes. The next streak must still be reported.
    await Deno.mkdir(options.logDir, { recursive: true });
    await Deno.writeTextFile(
      paths.spoolFile,
      JSON.stringify({ escalatedStreak: 3, pending: null }),
    );

    const attempts: number[] = [];
    for (let run = 0; run < 4; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: (context) => {
          attempts.push(context.streak);
          return Promise.resolve(HOOK_OK);
        },
      });
    }

    assertEquals(
      attempts,
      [3],
      "the new streak escalates once; the stale marker neither silences it " +
        "nor lets it repeat",
    );
  });
});

Deno.test("updateCheckout - a spool that cannot be written is reported as unqueued (Issue #1018)", async () => {
  await withLogDir(async (options) => {
    const logged: string[] = [];
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: () => Promise.resolve(HOOK_FAILED),
        writeEscalationState: () =>
          Promise.reject(new Error("read-only file system")),
        log: (_logDir, message) => {
          logged.push(message);
          return Promise.resolve();
        },
      });
    }

    assert(
      logged.some((message) => message.includes("could NOT be queued")),
      "evidence that did not reach the disk is never reported as spooled",
    );
    assert(
      logged.some((message) =>
        message.includes("Could not persist") &&
        message.includes("read-only file system")
      ),
      "the persistence failure names its own cause",
    );
  });
});

Deno.test("updateCheckout - no escalation path spawns a process (Issues #2110, #2088)", async () => {
  await withLogDir(async (options) => {
    const originalCommand = Deno.Command;
    const spawned: string[] = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class {
      constructor(command: string | URL) {
        spawned.push(String(command));
        throw new Error(`the checkout update must spawn nothing: ${command}`);
      }
    };
    try {
      // A whole streak through to the loss, then a recovery — the real
      // escalate seam, not a stub.
      for (let run = 0; run < 8; run++) {
        await updateCheckout(options, {
          ...FAILING_RESET,
          hostFailureHook: { kind: "none" },
        });
      }
      await updateCheckout(options, {
        ...OK_RESET,
        hostFailureHook: { kind: "none" },
      });
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = originalCommand;
    }
    assertEquals(spawned, [], "no gh, no git, no hook — nothing is spawned");
  });
});
