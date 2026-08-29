/**
 * Tests for checkout_update.ts — the host-side worker-checkout update and the
 * crash-loop escalation it inherited from the retired in-container bootstrap
 * reset (Issues #512, #513, #4204).
 *
 * Covers the "active development tree" diagnosis, the consecutive-failure
 * streak (one escalation per streak, cleared by a success), the streak file's
 * home under the log directory, and that an escalation problem never masks the
 * underlying update failure.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECKOUT_UPDATE_ESCALATION_THRESHOLD,
  CHECKOUT_UPDATE_FAILURE_STREAK_FILE,
  type CheckoutUpdateDeps,
  diagnoseUpdateFailure,
  parseOriginRepo,
  updateCheckout,
} from "../lib/checkout_update.ts";
import type { Result } from "../types.ts";

/** Build a recording dependency set with everything succeeding by default. */
function recordingDeps(
  order: string[],
  overrides: Partial<CheckoutUpdateDeps> = {},
): CheckoutUpdateDeps {
  return {
    resolveDefaultBranch: (_repoDir) => {
      order.push("resolveDefaultBranch");
      return Promise.resolve({ ok: true, value: "trunk" } as Result<string>);
    },
    resetToDefaultBranch: (_repoDir, _branch, _logDir) => {
      order.push("resetToDefaultBranch");
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
    describeCheckoutState: (_repoDir) => {
      order.push("describeCheckoutState");
      return Promise.resolve(null);
    },
    readFailureStreak: (_logDir) => {
      order.push("readStreak");
      return Promise.resolve(0);
    },
    writeFailureStreak: (_logDir, count) => {
      order.push(`writeStreak:${count}`);
      return Promise.resolve();
    },
    escalate: (_context) => {
      order.push("escalate");
      return Promise.resolve();
    },
    log: (_logDir, message) => {
      order.push(`log:${message}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** A resetToDefaultBranch override that always fails. */
function failingReset(order: string[]) {
  return (_repoDir: string, _branch: string, _logDir: string) => {
    order.push("resetToDefaultBranch");
    return Promise.resolve({
      ok: false,
      error: new Error("git checkout trunk failed (exit code 1)"),
    } as Result<void>);
  };
}

/** Baseline options pointing at a throwaway checkout and log directory. */
const OPTIONS = { repoDir: "/tmp/repo", logDir: "/tmp/logs" };

Deno.test("updateCheckout - a successful update clears the failure streak (Issue #4204)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      readFailureStreak: (_logDir) => Promise.resolve(2),
    }),
  );

  assertEquals(outcome.ok, true);
  assertEquals(outcome.branch, "trunk");
  assertEquals(outcome.streak, 0);
  assertEquals(order.includes("writeStreak:0"), true);
  assertEquals(order.includes("escalate"), false);
});

Deno.test("updateCheckout - a failure on a development checkout names the collision (Issue #4204)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      resetToDefaultBranch: failingReset(order),
      describeCheckoutState: (_repoDir) =>
        Promise.resolve({ branch: "fix/some-feature", dirtyFiles: 3 }),
    }),
  );

  assertEquals(outcome.ok, false);
  const error = outcome.error ?? "";
  assertStringIncludes(error, "active development tree");
  assertStringIncludes(error, "fix/some-feature");
  assertStringIncludes(error, "3 uncommitted change");
  assertStringIncludes(error, "4204");
  // The enriched detail reaches run_core.log too, not only the return value.
  assert(
    order.some((entry) =>
      entry.startsWith("log:Checkout update failed") &&
      entry.includes("active development tree")
    ),
  );
});

Deno.test("updateCheckout - a clean on-branch failure keeps the plain git error (Issue #4204)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      resetToDefaultBranch: failingReset(order),
      describeCheckoutState: (_repoDir) =>
        Promise.resolve({ branch: "trunk", dirtyFiles: 0 }),
    }),
  );

  assertEquals(outcome.ok, false);
  assertEquals(
    (outcome.error ?? "").includes("active development tree"),
    false,
    "a clean checkout on the default branch is not a dev-tree collision",
  );
});

Deno.test("updateCheckout - the third consecutive failure escalates, once (Issue #4204)", async () => {
  // Streak 2 -> this failure makes 3 -> escalate.
  {
    const order: string[] = [];
    const outcome = await updateCheckout(
      OPTIONS,
      recordingDeps(order, {
        resetToDefaultBranch: failingReset(order),
        readFailureStreak: (_logDir) => Promise.resolve(2),
      }),
    );
    assertEquals(outcome.ok, false);
    assertEquals(outcome.streak, CHECKOUT_UPDATE_ESCALATION_THRESHOLD);
    assertEquals(outcome.escalated, true);
    assertEquals(order.includes("writeStreak:3"), true);
    assertEquals(order.includes("escalate"), true);
  }

  // First failure (streak 0 -> 1): no escalation yet.
  {
    const order: string[] = [];
    const outcome = await updateCheckout(
      OPTIONS,
      recordingDeps(order, { resetToDefaultBranch: failingReset(order) }),
    );
    assertEquals(outcome.streak, 1);
    assertEquals(outcome.escalated, false);
    assertEquals(order.includes("writeStreak:1"), true);
    assertEquals(order.includes("escalate"), false);
  }

  // Fourth failure (streak 3 -> 4): already escalated this streak — stay quiet.
  {
    const order: string[] = [];
    const outcome = await updateCheckout(
      OPTIONS,
      recordingDeps(order, {
        resetToDefaultBranch: failingReset(order),
        readFailureStreak: (_logDir) => Promise.resolve(3),
      }),
    );
    assertEquals(outcome.streak, 4);
    assertEquals(order.includes("writeStreak:4"), true);
    assertEquals(
      order.includes("escalate"),
      false,
      "one escalation per streak — a crash-loop must not spam the repo",
    );
  }
});

Deno.test("updateCheckout - escalation problems never mask the update failure (Issue #4204)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      resetToDefaultBranch: failingReset(order),
      readFailureStreak: (_logDir) => Promise.resolve(2),
      escalate: (_context) => {
        order.push("escalate");
        return Promise.reject(new Error("gh is not authenticated"));
      },
    }),
  );

  assertEquals(outcome.ok, false);
  assertEquals(outcome.escalated, false);
  assertStringIncludes(outcome.error ?? "", "git checkout trunk failed");
  // The escalation failure is logged, best-effort, and never thrown.
  assert(
    order.some((entry) =>
      entry.startsWith("log:") && entry.includes("escalation failed")
    ),
  );
});

Deno.test("updateCheckout - an unresolvable default branch fails loud and counts a failure", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      resolveDefaultBranch: (_repoDir) =>
        Promise.resolve({
          ok: false,
          error: new Error("refs/remotes/origin/HEAD is unset"),
        } as Result<string>),
    }),
  );

  assertEquals(outcome.ok, false);
  assertEquals(outcome.branch, "");
  assertEquals(order.includes("resetToDefaultBranch"), false);
  assertStringIncludes(
    outcome.error ?? "",
    "cannot resolve the default branch",
  );
  assertStringIncludes(outcome.error ?? "", "--default-branch");
  assertEquals(outcome.streak, 1);
});

Deno.test("updateCheckout - a named branch is used as given and origin/HEAD is not consulted", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    { ...OPTIONS, defaultBranch: "release" },
    recordingDeps(order),
  );

  assertEquals(outcome.ok, true);
  assertEquals(outcome.branch, "release");
  assertEquals(order.includes("resolveDefaultBranch"), false);
});

Deno.test("updateCheckout - the streak file lives under the log directory (Issue #513)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "checkout_update_streak_" });
  try {
    const logDir = `${tmp}/logs`;
    const streakFile = `${logDir}/${CHECKOUT_UPDATE_FAILURE_STREAK_FILE}`;
    const options = { repoDir: `${tmp}/repo`, logDir, defaultBranch: "trunk" };
    // Only the git and GitHub side effects are stubbed: the streak really is
    // read from and written to disk.
    const failing: Partial<CheckoutUpdateDeps> = {
      resetToDefaultBranch: () =>
        Promise.resolve({
          ok: false,
          error: new Error("git fetch origin failed (exit code 128)"),
        } as Result<void>),
      describeCheckoutState: () => Promise.resolve(null),
      escalate: () => Promise.resolve(),
    };

    const first = await updateCheckout(options, failing);
    assertEquals(first.streak, 1);
    assertEquals((await Deno.readTextFile(streakFile)).trim(), "1");

    const second = await updateCheckout(options, failing);
    assertEquals(second.streak, 2);
    assertEquals((await Deno.readTextFile(streakFile)).trim(), "2");

    const third = await updateCheckout(options, failing);
    assertEquals(third.streak, CHECKOUT_UPDATE_ESCALATION_THRESHOLD);
    assertEquals(third.escalated, true);

    // A success resets the count to zero, so the next blip starts over.
    const recovered = await updateCheckout(options, {
      ...failing,
      resetToDefaultBranch: () =>
        Promise.resolve({ ok: true, value: undefined } as Result<void>),
    });
    assertEquals(recovered.ok, true);
    assertEquals((await Deno.readTextFile(streakFile)).trim(), "0");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("diagnoseUpdateFailure - enriches only an actual development tree", () => {
  const bare = "git checkout trunk failed (exit code 1)";
  assertEquals(diagnoseUpdateFailure(bare, "trunk", null), bare);
  assertEquals(
    diagnoseUpdateFailure(bare, "trunk", { branch: "trunk", dirtyFiles: 0 }),
    bare,
  );
  assertStringIncludes(
    diagnoseUpdateFailure(bare, "trunk", { branch: "trunk", dirtyFiles: 2 }),
    "active development tree",
  );
  assertStringIncludes(
    diagnoseUpdateFailure(bare, "trunk", { branch: "wip", dirtyFiles: 0 }),
    "active development tree",
  );
});

Deno.test("parseOriginRepo - reads owner/repo from SSH and HTTPS origins", () => {
  assertEquals(
    parseOriginRepo("git@github.com:stSoftwareAU/VibeCoder.git"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(
    parseOriginRepo("https://github.com/stSoftwareAU/VibeCoder"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(parseOriginRepo("https://example.com/not/github"), null);
});
