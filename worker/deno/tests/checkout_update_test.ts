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
 * Issue #624 adds the frozen path: the checkout is held at `pinned_ref` rather
 * than reset to `origin/<branch>`, the skip is logged with its mode and ref, a
 * checkout already on the pin does no git write, and a ref that does not
 * resolve fails loudly into the same streak.
 *
 * Issue #735 adds the discoverability line: an update that actually changed
 * the checkout names `VIBE_SKIP_CHECKOUT_UPDATE` — the opt-out that would have
 * preserved the overwritten work — and one that changed nothing stays quiet.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECKOUT_UPDATE_ESCALATION_THRESHOLD,
  CHECKOUT_UPDATE_FAILURE_STREAK_FILE,
  checkoutOverwriteNotice,
  type CheckoutUpdateDeps,
  diagnoseUpdateFailure,
  parseOriginRepo,
  SKIP_CHECKOUT_UPDATE_ENV,
  updateCheckout,
} from "../lib/checkout_update.ts";
import type { Result } from "../types.ts";

/** The tag a frozen host is pinned to, and the commit it resolves to. */
const PINNED_REF = "v1.2.3";
const PINNED_SHA = "1111111111111111111111111111111111111111";
/** A commit that is *not* the pin — the checkout has drifted off it. */
const OTHER_SHA = "2222222222222222222222222222222222222222";

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
    fetchOrigin: (_repoDir, _logDir) => {
      order.push("fetchOrigin");
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
    resolveCommit: (_repoDir, ref) => {
      order.push(`resolveCommit:${ref}`);
      return Promise.resolve(ref === PINNED_REF ? PINNED_SHA : null);
    },
    readHeadCommit: (_repoDir) => {
      order.push("readHeadCommit");
      return Promise.resolve(OTHER_SHA);
    },
    checkoutPinnedRef: (_repoDir, _ref, _logDir) => {
      order.push("checkoutPinnedRef");
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
    readEscalationState: (_logDir) => {
      order.push("readEscalationState");
      return Promise.resolve({ escalatedStreak: 0, pending: null });
    },
    writeEscalationState: (_logDir, state) => {
      order.push(`writeEscalationState:${state.escalatedStreak}`);
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

  // Fourth failure (streak 3 -> 4) after a delivered escalation — stay quiet.
  //
  // Issue #1018 changed what proves "already escalated": the streak count no
  // longer does, because an attempt that threw left nothing delivered. The
  // marker recorded on a successful send is what silences the rest of the
  // streak, so this case now states that marker instead of implying it from
  // the count (the retry half is covered in
  // checkout_update_escalation_spool_test.ts).
  {
    const order: string[] = [];
    const outcome = await updateCheckout(
      OPTIONS,
      recordingDeps(order, {
        resetToDefaultBranch: failingReset(order),
        readFailureStreak: (_logDir) => Promise.resolve(3),
        readEscalationState: (_logDir) =>
          Promise.resolve({
            escalatedStreak: CHECKOUT_UPDATE_ESCALATION_THRESHOLD,
            pending: null,
          }),
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

// ============================================================================
// The opt-out is named where it matters (Issue #735)
// ============================================================================

Deno.test("checkoutOverwriteNotice - names the opt-out only when the checkout changed (Issue #735)", () => {
  const repoDir = "/tmp/repo";
  const unchanged = checkoutOverwriteNotice(
    repoDir,
    { head: OTHER_SHA, dirtyFiles: 0 },
    { head: OTHER_SHA, dirtyFiles: 0 },
  );
  assertEquals(unchanged, "", "an update that overwrote nothing says nothing");

  const moved = checkoutOverwriteNotice(
    repoDir,
    { head: OTHER_SHA, dirtyFiles: 0 },
    { head: PINNED_SHA, dirtyFiles: 0 },
  );
  assertStringIncludes(moved, repoDir);
  assertStringIncludes(moved, SKIP_CHECKOUT_UPDATE_ENV);

  const discarded = checkoutOverwriteNotice(
    repoDir,
    { head: OTHER_SHA, dirtyFiles: 3 },
    { head: OTHER_SHA, dirtyFiles: 0 },
  );
  assertStringIncludes(discarded, "3 uncommitted change(s) discarded");
  assertStringIncludes(discarded, SKIP_CHECKOUT_UPDATE_ENV);

  // Unreadable state is never guessed at: no state, no claim.
  assertEquals(
    checkoutOverwriteNotice(
      repoDir,
      { head: null, dirtyFiles: null },
      { head: PINNED_SHA, dirtyFiles: 0 },
    ),
    "",
  );
  // Work that appeared during the update is not work the update discarded.
  assertEquals(
    checkoutOverwriteNotice(
      repoDir,
      { head: OTHER_SHA, dirtyFiles: 0 },
      { head: OTHER_SHA, dirtyFiles: 2 },
    ),
    "",
  );
});

Deno.test("updateCheckout - an update that moved the checkout logs the opt-out (Issue #735)", async () => {
  const order: string[] = [];
  // Two reads: the snapshot before the update, and the one after it.
  const heads = [OTHER_SHA, PINNED_SHA];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      readHeadCommit: (_repoDir) => {
        order.push("readHeadCommit");
        return Promise.resolve(heads.shift() ?? PINNED_SHA);
      },
      describeCheckoutState: (_repoDir) =>
        Promise.resolve({ branch: "trunk", dirtyFiles: 0 }),
    }),
  );

  assertEquals(outcome.ok, true);
  assertStringIncludes(outcome.overwriteNotice, SKIP_CHECKOUT_UPDATE_ENV);
  assert(
    order.some((entry) =>
      entry.startsWith("log:") && entry.includes(SKIP_CHECKOUT_UPDATE_ENV)
    ),
    "the hint must reach run_core.log, not only the command's message",
  );
});

Deno.test("updateCheckout - an update that changed nothing keeps quiet (Issue #735)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    OPTIONS,
    recordingDeps(order, {
      describeCheckoutState: (_repoDir) =>
        Promise.resolve({ branch: "trunk", dirtyFiles: 0 }),
    }),
  );

  assertEquals(outcome.ok, true);
  assertEquals(outcome.overwriteNotice, "");
  assertEquals(
    order.some((entry) => entry.includes(SKIP_CHECKOUT_UPDATE_ENV)),
    false,
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

// ============================================================================
// Frozen mode — hold the checkout at the pinned ref (Issue #624, part of #583)
// ============================================================================

/** Options for a frozen host pinned to {@link PINNED_REF}. */
const FROZEN_OPTIONS = {
  ...OPTIONS,
  updateMode: "frozen" as const,
  pinnedRef: PINNED_REF,
};

Deno.test("updateCheckout - frozen holds the checkout at the pinned ref and never resets to origin (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(FROZEN_OPTIONS, recordingDeps(order));

  assertEquals(outcome.ok, true);
  assertEquals(outcome.mode, "frozen");
  assertEquals(outcome.ref, PINNED_REF);
  assertEquals(outcome.branch, "");
  // Fetch first — a tag pushed since the last launch must resolve — then the
  // pin. The default branch is neither resolved nor reset to.
  assertEquals(order.includes("fetchOrigin"), true);
  assertEquals(order.includes("checkoutPinnedRef"), true);
  assertEquals(order.includes("resetToDefaultBranch"), false);
  assertEquals(order.includes("resolveDefaultBranch"), false);
  assert(
    order.indexOf("fetchOrigin") < order.indexOf("checkoutPinnedRef"),
    "the fetch must precede the checkout of the pin",
  );
});

Deno.test("updateCheckout - frozen logs the skipped update with its mode and ref (Issue #624)", async () => {
  const order: string[] = [];
  await updateCheckout(FROZEN_OPTIONS, recordingDeps(order));

  assertEquals(
    order.includes(
      `log:Checkout update skipped: update_mode=frozen, pinned to ${PINNED_REF}`,
    ),
    true,
    "the skip must be stated in run_core.log, never silent",
  );
});

Deno.test("updateCheckout - frozen accepts a commit SHA as the pin (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    { ...OPTIONS, updateMode: "frozen", pinnedRef: PINNED_SHA },
    recordingDeps(order, {
      resolveCommit: (_repoDir, ref) => {
        order.push(`resolveCommit:${ref}`);
        return Promise.resolve(ref === PINNED_SHA ? PINNED_SHA : null);
      },
    }),
  );

  assertEquals(outcome.ok, true);
  assertEquals(outcome.ref, PINNED_SHA);
  assertEquals(order.includes("checkoutPinnedRef"), true);
  assert(
    order.includes(
      `log:Checkout update skipped: update_mode=frozen, pinned to ${PINNED_SHA}`,
    ),
  );
});

Deno.test("updateCheckout - frozen does no git write when HEAD is already the pin (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    FROZEN_OPTIONS,
    recordingDeps(order, {
      readHeadCommit: (_repoDir) => {
        order.push("readHeadCommit");
        return Promise.resolve(PINNED_SHA);
      },
    }),
  );

  assertEquals(outcome.ok, true);
  assertEquals(order.includes("checkoutPinnedRef"), false, "no checkout");
  assertEquals(order.includes("fetchOrigin"), false, "not even a fetch");
  // Still stated: a no-op launch says which ref the host is holding at.
  assertEquals(
    order.includes(
      `log:Checkout update skipped: update_mode=frozen, pinned to ${PINNED_REF}`,
    ),
    true,
  );
});

Deno.test("updateCheckout - frozen fails loud on a pinned ref that does not resolve (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    { ...OPTIONS, updateMode: "frozen", pinnedRef: "v9.9.9-typo" },
    recordingDeps(order, {
      resolveCommit: (_repoDir, ref) => {
        order.push(`resolveCommit:${ref}`);
        return Promise.resolve(null);
      },
    }),
  );

  assertEquals(outcome.ok, false);
  const error = outcome.error ?? "";
  assertStringIncludes(error, "v9.9.9-typo");
  assertStringIncludes(error, "pinned_ref");
  assertStringIncludes(error, ".config.json");
  assertEquals(order.includes("checkoutPinnedRef"), false);
  assertEquals(outcome.streak, 1, "a bad pin counts towards the crash-loop");
});

Deno.test("updateCheckout - frozen escalates a pin that keeps failing to resolve (Issue #624)", async () => {
  const order: string[] = [];
  const deps = recordingDeps(order, {
    resolveCommit: (_repoDir, _ref) => Promise.resolve(null),
    readFailureStreak: (_logDir) =>
      Promise.resolve(CHECKOUT_UPDATE_ESCALATION_THRESHOLD - 1),
  });

  const outcome = await updateCheckout(FROZEN_OPTIONS, deps);

  assertEquals(outcome.ok, false);
  assertEquals(outcome.streak, CHECKOUT_UPDATE_ESCALATION_THRESHOLD);
  assertEquals(outcome.escalated, true);
  assertEquals(order.includes("escalate"), true);
});

Deno.test("updateCheckout - frozen with no pinned ref fails loud naming the field (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    { ...OPTIONS, updateMode: "frozen" },
    recordingDeps(order),
  );

  assertEquals(outcome.ok, false);
  assertStringIncludes(outcome.error ?? "", "pinned_ref");
  assertEquals(order.includes("checkoutPinnedRef"), false);
  assert(
    order.some((entry) =>
      entry.startsWith("log:Checkout update skipped: update_mode=frozen")
    ),
    "even a mis-configured frozen host says what it did",
  );
});

Deno.test("updateCheckout - frozen still pins when the fetch fails but the ref resolves locally (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    FROZEN_OPTIONS,
    recordingDeps(order, {
      fetchOrigin: (_repoDir, _logDir) => {
        order.push("fetchOrigin");
        return Promise.resolve({
          ok: false,
          error: new Error("git fetch origin failed (exit code 128)"),
        } as Result<void>);
      },
    }),
  );

  assertEquals(outcome.ok, true, "an offline host still runs its pinned code");
  assertEquals(order.includes("checkoutPinnedRef"), true);
  assert(
    order.some((entry) =>
      entry.startsWith("log:Fetch failed while holding") &&
      entry.includes(PINNED_REF)
    ),
    "the fetch failure is said out loud, not swallowed",
  );
});

Deno.test("updateCheckout - frozen fails loud when the fetch fails and the ref is unknown locally (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(
    FROZEN_OPTIONS,
    recordingDeps(order, {
      resolveCommit: (_repoDir, _ref) => Promise.resolve(null),
      fetchOrigin: (_repoDir, _logDir) =>
        Promise.resolve({
          ok: false,
          error: new Error("git fetch origin failed (exit code 128)"),
        } as Result<void>),
    }),
  );

  assertEquals(outcome.ok, false);
  assertStringIncludes(outcome.error ?? "", PINNED_REF);
  assertEquals(order.includes("checkoutPinnedRef"), false);
});

Deno.test("updateCheckout - an absent update mode is dynamic and unchanged (Issue #624)", async () => {
  const order: string[] = [];
  const outcome = await updateCheckout(OPTIONS, recordingDeps(order));

  assertEquals(outcome.ok, true);
  assertEquals(outcome.mode, "dynamic");
  assertEquals(outcome.ref, "");
  assertEquals(outcome.branch, "trunk");
  assertEquals(order.includes("resetToDefaultBranch"), true);
  assertEquals(order.includes("checkoutPinnedRef"), false);
  assertEquals(order.includes("fetchOrigin"), false);
  assert(order.includes(`log:Updating ${OPTIONS.repoDir} to origin/trunk`));
});
