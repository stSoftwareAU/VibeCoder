/**
 * Tests for the re-armed checkout-update escalation and its spool (Issue
 * #1018).
 *
 * The escalation of Issue #4204 fired once, at the exact moment the streak
 * equalled the threshold, and its `gh issue create` needs the network whose
 * loss is the dominant cause of the streak. A failed send was therefore lost
 * for ever: the host ran stale code with nothing but a log line.
 *
 * These tests drive the two halves of the fix against the real on-disk state
 * under a temporary log directory — only the git and GitHub side effects are
 * stubbed:
 *   - a failed attempt leaves the streak eligible, so every later failing run
 *     tries again;
 *   - a successful attempt records the marker and stays quiet for the rest of
 *     the streak;
 *   - undelivered evidence is spooled and delivered once connectivity returns;
 *   - a successful update clears both the streak and the spool, so a stale
 *     entry cannot report a condition that has already cleared.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECKOUT_UPDATE_ESCALATION_SPOOL_FILE,
  CHECKOUT_UPDATE_FAILURE_STREAK_FILE,
  type CheckoutEscalationState,
  type CheckoutUpdateDeps,
  type CheckoutUpdateEscalationContext,
  updateCheckout,
} from "../lib/checkout_update.ts";
import type { Result } from "../types.ts";

/** A checkout update that always fails, as a lost network makes it. */
const FAILING_RESET: Partial<CheckoutUpdateDeps> = {
  resetToDefaultBranch: () =>
    Promise.resolve({
      ok: false,
      error: new Error(
        "git fetch origin failed (exit code 128): Could not resolve hostname github.com",
      ),
    } as Result<void>),
  describeCheckoutState: () => Promise.resolve(null),
};

/** A checkout update that succeeds. */
const OK_RESET: Partial<CheckoutUpdateDeps> = {
  resetToDefaultBranch: () =>
    Promise.resolve({ ok: true, value: undefined } as Result<void>),
  describeCheckoutState: () => Promise.resolve(null),
  readHeadCommit: () => Promise.resolve(null),
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

Deno.test("updateCheckout - a failed escalation is retried on every later failing run (Issue #1018)", async () => {
  await withLogDir(async (options) => {
    const attempts: number[] = [];
    const offline: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      escalate: (context) => {
        attempts.push(context.streak);
        return Promise.reject(
          new Error(
            "gh issue create exited 1: error connecting to api.github.com",
          ),
        );
      },
    };

    const outcomes = [];
    for (let run = 0; run < 5; run++) {
      outcomes.push(await updateCheckout(options, offline));
    }

    assertEquals(outcomes.map((outcome) => outcome.streak), [1, 2, 3, 4, 5]);
    assertEquals(
      outcomes.every((outcome) => outcome.escalated),
      false,
      "a send that threw never counts as delivered",
    );
    assertEquals(
      attempts,
      [3, 4, 5],
      "every run at or above the threshold retries while delivery keeps failing",
    );
  });
});

Deno.test("updateCheckout - a delivered escalation silences the rest of the streak (Issue #1018)", async () => {
  await withLogDir(async (options, paths) => {
    const attempts: number[] = [];
    let deliveries = 0;
    const flaky: Partial<CheckoutUpdateDeps> = {
      ...FAILING_RESET,
      escalate: (context) => {
        attempts.push(context.streak);
        // The first attempt (streak 3) throws; the second one lands.
        if (attempts.length === 1) {
          return Promise.reject(
            new Error("error connecting to api.github.com"),
          );
        }
        deliveries++;
        return Promise.resolve();
      },
    };

    const outcomes = [];
    for (let run = 0; run < 6; run++) {
      outcomes.push(await updateCheckout(options, flaky));
    }

    assertEquals(deliveries, 1, "exactly one issue is raised per streak");
    assertEquals(
      attempts,
      [3, 4],
      "the retry stops the moment one attempt is delivered",
    );
    assertEquals(outcomes.map((outcome) => outcome.escalated), [
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    const state = await readState(paths.spoolFile);
    assertEquals(state?.escalatedStreak, 4, "the marker records the delivery");
    assertEquals(state?.pending, null, "delivery empties the spool");
  });
});

Deno.test("updateCheckout - undelivered evidence is spooled and delivered once (Issue #1018)", async () => {
  await withLogDir(async (options, paths) => {
    // Three failing runs with no network at all: nothing is delivered, and the
    // evidence is queued rather than lost.
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: () =>
          Promise.reject(new Error("error connecting to api.github.com")),
      });
    }

    const spooled = await readState(paths.spoolFile);
    assertEquals(spooled?.escalatedStreak, 0);
    assertEquals(spooled?.pending?.streak, 3);
    assertStringIncludes(
      spooled?.pending?.error ?? "",
      "Could not resolve hostname github.com",
    );
    assert(
      !Number.isNaN(Date.parse(spooled?.pending?.spooledAt ?? "")),
      "the spooled entry records when delivery was first attempted",
    );

    // Connectivity returns while the checkout is still failing: the queued
    // evidence is delivered, exactly once, and the spool is emptied.
    const delivered: CheckoutUpdateEscalationContext[] = [];
    for (let run = 0; run < 2; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: (context) => {
          delivered.push(context);
          return Promise.resolve();
        },
      });
    }

    assertEquals(delivered.length, 1, "the spool delivers exactly once");
    assertStringIncludes(
      delivered[0]?.error ?? "",
      "Could not resolve hostname github.com",
    );
    assert(
      (delivered[0]?.spooledAt ?? "").length > 0,
      "the delivered report says it was queued while the network was down",
    );
    const drained = await readState(paths.spoolFile);
    assertEquals(drained?.pending ?? null, null);
  });
});

Deno.test("updateCheckout - a successful update clears the streak and the spool (Issue #1018)", async () => {
  await withLogDir(async (options, paths) => {
    const logged: string[] = [];
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: () =>
          Promise.reject(new Error("error connecting to api.github.com")),
      });
    }
    assert(
      (await readState(paths.spoolFile))?.pending !== null,
      "precondition: an undelivered report is queued",
    );

    let escalatedAfterRecovery = false;
    const recovered = await updateCheckout(options, {
      ...OK_RESET,
      escalate: () => {
        escalatedAfterRecovery = true;
        return Promise.resolve();
      },
      log: (_logDir, message) => {
        logged.push(message);
        return Promise.resolve();
      },
    });

    assertEquals(recovered.ok, true);
    assertEquals(escalatedAfterRecovery, false, "the condition has cleared");
    assertEquals((await Deno.readTextFile(paths.streakFile)).trim(), "0");
    assertEquals(
      await readState(paths.spoolFile),
      null,
      "a stale spool cannot report a condition that has already cleared",
    );
    assert(
      logged.some((message) => message.includes("discard")),
      "dropping a queued report is said out loud, never silent",
    );

    // The next streak starts clean: it escalates again at the threshold.
    const attempts: number[] = [];
    for (let run = 0; run < 3; run++) {
      await updateCheckout(options, {
        ...FAILING_RESET,
        escalate: (context) => {
          attempts.push(context.streak);
          return Promise.resolve();
        },
      });
    }
    assertEquals(attempts, [3], "a cleared streak escalates afresh");
  });
});
