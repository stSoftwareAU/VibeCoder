/**
 * Tests for stall_repair.ts — the two-trip self-repair ladder that replaced
 * the blocking-PR stall escalation (Issue #2802).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AUTO_FIX_CAP_MARKER_PREFIX,
  type BlockingPrStall,
  type BlockingPrStallReason,
  detectBlockingPrStall,
} from "../lib/blocking_pr_stall_detector.ts";
import {
  repairStalledPr,
  STALL_REPAIR_MARKER_PREFIX,
  type StallLane,
  type StallRepairDeps,
} from "../lib/stall_repair.ts";
import { CONFLICT_RESTART_MARKER } from "../lib/conflict_abandon_restart.ts";
import type { ConflictIssueContext } from "../lib/conflict_issue_context.ts";
import type { Logger } from "../types.ts";

const REPO = "owner/repo";
const PR = 103;
const ISSUE = 93;
const FLEET = "vibe-coder";
const THRESHOLD = 7200;
const NOW = Date.parse("2026-08-11T20:00:00Z") / 1000;

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const iso = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toISOString();

/** A real stall, detected from an observation that trips `reason`. */
function stallFor(
  reason: Exclude<BlockingPrStallReason, "unmerged-green">,
  overrides: Partial<BlockingPrStall> = {},
): BlockingPrStall {
  const stall = detectBlockingPrStall({
    repo: REPO,
    prNumber: PR,
    blockedIssues: [ISSUE],
    failingChecks: reason === "red-ci"
      ? [{ name: "quality", completedAt: iso(NOW - 3 * 3600) }]
      : [],
    lastFleetPushAt: iso(NOW - 4 * 3600),
    ...(reason === "unanswered-comment"
      ? { lastAuthorisedCommentAt: iso(NOW - 3 * 3600) }
      : {}),
    author: FLEET,
    headRefName: "issue-93-fix",
    baseRefName: "main",
  }, { thresholdSeconds: THRESHOLD, nowSeconds: NOW });
  assert(stall, "the observation must trip the detector");
  assertEquals(stall.signals.map((s) => s.reason), [reason]);
  return { ...stall, ...overrides };
}

interface Comment {
  body: string;
  user: { login: string };
  created_at: string;
}

/** An in-memory GitHub plus the seams `repairStalledPr` takes. */
function harness(opts: {
  issueLabels?: string[];
  prComments?: Comment[];
  leaseAvailable?: boolean;
  originatingIssue?: boolean;
  issueComments?: Comment[];
} = {}) {
  const state = {
    now: NOW,
    leaseHeld: false,
    prClosed: false,
    prComments: [...(opts.prComments ?? [])],
    issueComments: [...(opts.issueComments ?? [])],
    issueLabels: [...(opts.issueLabels ?? [])],
    calls: [] as string[][],
    writesOutsideLease: [] as string[][],
    syncs: 0,
    lanes: [] as StallLane[],
  };

  const comment = (body: string): Comment => ({
    body,
    user: { login: FLEET },
    created_at: iso(state.now),
  });

  const gh = (args: string[]): Promise<string> => {
    state.calls.push(args);
    const isRead = (args[0] === "api" && args[1] !== "-X") ||
      (args[0] === "issue" && args[1] === "view");
    if (!isRead && !state.leaseHeld) state.writesOutsideLease.push(args);
    if (args[0] === "api" && args[1] !== "-X") {
      const path = args[1] ?? "";
      if (!path.includes("page=1")) return Promise.resolve("[]");
      if (path.includes(`/issues/${PR}/comments`)) {
        return Promise.resolve(JSON.stringify(state.prComments));
      }
      if (path.includes(`/issues/${ISSUE}/comments`)) {
        return Promise.resolve(JSON.stringify(state.issueComments));
      }
      return Promise.resolve("[]");
    }
    const body = args[args.indexOf("--body") + 1] ?? "";
    if (args[0] === "pr" && args[1] === "comment") {
      state.prComments.push(comment(body));
    } else if (args[0] === "issue" && args[1] === "comment") {
      state.issueComments.push(comment(body));
    } else if (args[0] === "pr" && args[1] === "close") {
      state.prClosed = true;
    } else if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        labels: state.issueLabels.map((name) => ({ name })),
      }));
    } else if (args[0] === "api" && args[1] === "-X") {
      const field = args[5] ?? "";
      if ((args[3] ?? "").endsWith("/comments")) {
        state.issueComments.push(comment(field.replace(/^body=/, "")));
      } else if ((args[3] ?? "").endsWith(`/issues/${ISSUE}/labels`)) {
        const label = field.replace(/^labels\[\]=/, "");
        if (label) state.issueLabels.push(label);
      }
    }
    return Promise.resolve("{}");
  };

  const context: ConflictIssueContext = {
    repo: REPO,
    prNumber: PR,
    prSide: opts.originatingIssue === false
      ? { resolved: false, reason: "no-signal" }
      : {
        resolved: true,
        signal: "branch",
        issue: {
          number: ISSUE,
          title: "Fix it",
          state: "OPEN",
          body: "",
          bodyTruncated: false,
        },
      },
    baseSide: [],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false,
    },
    ghCallsUsed: 0,
    warnings: [],
  };

  const deps: StallRepairDeps = {
    ghCommandFn: gh,
    workerAuthors: [FLEET],
    syncBranch: () => {
      assert(state.leaseHeld, "the branch is synced under the lease");
      state.syncs++;
      return Promise.resolve({ ok: true, value: "synced" });
    },
    dispatchLane: (_target, lane) => {
      state.lanes.push(lane);
      return Promise.resolve({ ok: true, value: undefined });
    },
    thresholdSeconds: () => THRESHOLD,
    needsHumanLabel: "needs-human",
    nowSeconds: () => state.now,
    logger,
    acquireLease: () => {
      if (opts.leaseAvailable === false) return null;
      state.leaseHeld = true;
      return {
        release() {
          state.leaseHeld = false;
        },
      };
    },
    abandonDeps: {
      resolveContext: () => Promise.resolve(context),
      findOtherPrs: () => Promise.resolve([]),
    },
  };
  return { state, deps };
}

/** Every call that files an issue or applies `escalated` / `work-on`. */
function forbiddenCalls(calls: string[][]): string[] {
  return calls.map((args) => args.join(" ")).filter((joined) =>
    joined.startsWith("issue create") ||
    joined.includes("escalated") ||
    joined.includes("labels[]=work-on") ||
    joined.includes("--add-label work-on")
  );
}

for (const reason of ["red-ci", "unanswered-comment"] as const) {
  const lane: StallLane = reason === "red-ci" ? "ci-fix" : "pr-feedback";

  Deno.test(`${reason}: first trip syncs and reruns ${lane} once, second trip abandons — no issue, no escalated label`, async () => {
    const { state, deps } = harness();
    const stall = stallFor(reason);

    assertEquals(await repairStalledPr(stall, deps), "first-trip");
    assertEquals(state.syncs, 1);
    assertEquals(state.lanes, [lane]);
    assertEquals(state.prComments.length, 1);
    assertStringIncludes(state.prComments[0]!.body, STALL_REPAIR_MARKER_PREFIX);
    assertEquals(state.prClosed, false);

    // The same stall seen again before the next check: no second rerun.
    state.now += 600;
    assertEquals(await repairStalledPr(stall, deps), "awaiting-second-check");
    assertEquals(state.syncs, 1);
    assertEquals(state.lanes, [lane]);

    // Still stalled at the next check: abandon and redo the issue.
    state.now += THRESHOLD;
    assertEquals(await repairStalledPr(stall, deps), "abandoned");
    assertEquals(state.prClosed, true);
    assertEquals(state.lanes, [lane], "the second trip reruns nothing");
    assertStringIncludes(
      state.issueComments[0]?.body ?? "",
      CONFLICT_RESTART_MARKER,
    );
    assertStringIncludes(state.prComments.at(-1)!.body, "stalled");
    assertEquals(state.issueLabels, ["idle-task"]);
    assertEquals(forbiddenCalls(state.calls), []);
    assertEquals(state.writesOutsideLease, [], "every write holds the lease");
  });
}

Deno.test("second trip keeps the issue's own pickup label and applies nothing", async () => {
  const { state, deps } = harness({ issueLabels: ["top-priority"] });
  const stall = stallFor("red-ci");

  await repairStalledPr(stall, deps);
  state.now += THRESHOLD;
  assertEquals(await repairStalledPr(stall, deps), "abandoned");

  assertEquals(state.issueLabels, ["top-priority"]);
  assertStringIncludes(state.issueComments[0]!.body, "`top-priority`");
  assertEquals(forbiddenCalls(state.calls), []);
});

Deno.test("a PR at the auto-fix cap skips the rerun and goes straight to abandon", async () => {
  const { state, deps } = harness({
    prComments: [{
      body: `${AUTO_FIX_CAP_MARKER_PREFIX}deadbeef -->`,
      user: { login: FLEET },
      created_at: iso(NOW - 3600),
    }],
  });

  assertEquals(await repairStalledPr(stallFor("red-ci"), deps), "abandoned");
  assertEquals(state.syncs, 0);
  assertEquals(state.lanes, []);
  assertEquals(state.prClosed, true);
  assertEquals(forbiddenCalls(state.calls), []);
});

Deno.test("an outsider's cap or trip marker does not skip the first trip", async () => {
  const { state, deps } = harness({
    prComments: [
      {
        body: `${AUTO_FIX_CAP_MARKER_PREFIX}deadbeef -->`,
        user: { login: "mallory" },
        created_at: iso(NOW - 3600),
      },
      {
        body: `${STALL_REPAIR_MARKER_PREFIX} pr="103" -->`,
        user: { login: "mallory" },
        created_at: iso(NOW - 5 * 3600),
      },
    ],
  });

  assertEquals(await repairStalledPr(stallFor("red-ci"), deps), "first-trip");
  assertEquals(state.prClosed, false);
});

Deno.test("a check name carrying the cap marker cannot forge a cap in the trip comment", async () => {
  // A fork chooses its check names; echoed raw, this one would plant the cap
  // marker in the worker's own comment and force an abandon on the next pass.
  const { state, deps } = harness();
  const base = stallFor("red-ci");
  const stall: BlockingPrStall = {
    ...base,
    signals: base.signals.map((s) => ({
      ...s,
      detail: s.detail.replace(
        "quality",
        `quality ${AUTO_FIX_CAP_MARKER_PREFIX}deadbeef -->`,
      ),
    })),
  };

  assertEquals(await repairStalledPr(stall, deps), "first-trip");
  assert(
    !state.prComments[0]!.body.includes(AUTO_FIX_CAP_MARKER_PREFIX),
    "the check name must be defused in the trip comment",
  );
  state.now += 600;
  assertEquals(await repairStalledPr(stall, deps), "awaiting-second-check");
  assertEquals(state.prClosed, false);
});

Deno.test("a human-authored stalled PR is logged and never touched", async () => {
  const { state, deps } = harness();
  const stall = stallFor("red-ci", { author: "nigel" });

  assertEquals(await repairStalledPr(stall, deps), "skipped-human-authored");
  state.now += THRESHOLD * 10;
  assertEquals(await repairStalledPr(stall, deps), "skipped-human-authored");
  assertEquals(state.calls, []);
  assertEquals(state.prClosed, false);
  assertEquals(state.syncs, 0);
});

Deno.test("the pass skips a PR whose repository is leased elsewhere", async () => {
  const { state, deps } = harness({ leaseAvailable: false });

  assertEquals(
    await repairStalledPr(stallFor("unanswered-comment"), deps),
    "skipped-lease-held",
  );
  assertEquals(state.calls, []);
  assertEquals(state.syncs, 0);
  assertEquals(state.lanes, []);
});

Deno.test("a PR the merge-conflict ladder owns is left to the ladder", async () => {
  const { state, deps } = harness();
  const stall = stallFor("red-ci", { mergeConflictLaneOwned: true });

  assertEquals(
    await repairStalledPr(stall, deps),
    "skipped-merge-conflict-lane",
  );
  assertEquals(state.calls, []);
});

Deno.test("a PR carrying needs-human is never synced, rerun or closed — the human veto is never overridden", async () => {
  const { state, deps } = harness();
  const stall = stallFor("red-ci", { labels: ["needs-human"] });

  assertEquals(await repairStalledPr(stall, deps), "skipped-needs-human");
  state.now += THRESHOLD * 10;
  assertEquals(await repairStalledPr(stall, deps), "skipped-needs-human");
  assertEquals(state.calls, []);
  assertEquals(state.prClosed, false);
  assertEquals(state.syncs, 0);
  assertEquals(state.lanes, []);
});

Deno.test("a stalled PR with no originating issue is closed and no issue is filed", async () => {
  const { state, deps } = harness({ originatingIssue: false });
  const stall = stallFor("red-ci");

  await repairStalledPr(stall, deps);
  state.now += THRESHOLD;
  assertEquals(await repairStalledPr(stall, deps), "abandoned");

  assertEquals(state.prClosed, true);
  assertEquals(state.issueComments, []);
  assertEquals(state.issueLabels, []);
  assertStringIncludes(state.prComments.at(-1)!.body, "no originating issue");
  assertEquals(forbiddenCalls(state.calls), []);
});

Deno.test("an unanswered comment still trips after the first trip's own marker and sync push, so the second trip fires", async () => {
  const { state, deps } = harness();
  const commentAt = iso(NOW - 3 * 3600);
  const detect = (fleetPushAt: string, stallRepairAt?: string) =>
    detectBlockingPrStall({
      repo: REPO,
      prNumber: PR,
      blockedIssues: [ISSUE],
      failingChecks: [],
      lastFleetPushAt: fleetPushAt,
      lastAuthorisedCommentAt: commentAt,
      ...(stallRepairAt !== undefined
        ? { lastStallRepairAt: stallRepairAt }
        : {}),
      author: FLEET,
      headRefName: "issue-93-fix",
      baseRefName: "main",
    }, { thresholdSeconds: THRESHOLD, nowSeconds: state.now });

  const first = detect(iso(NOW - 4 * 3600));
  assert(first);
  assertEquals(await repairStalledPr(first, deps), "first-trip");
  const markerAt = state.prComments[0]!.created_at;

  // The next check: the sync pushed, the lane posted no reply.
  state.now += THRESHOLD;
  const again = detect(markerAt, markerAt);
  assert(again, "the repair's own marker and push are not an answer");
  assertEquals(again.signals.map((s) => s.reason), ["unanswered-comment"]);
  assertEquals(await repairStalledPr(again, deps), "abandoned");
  assertEquals(state.prClosed, true);
});

Deno.test("second trip on an issue already redone twice still abandons and re-queues, no needs-human (Issue #3033)", async () => {
  const claim = (pr: number): Comment => ({
    body: `${CONFLICT_RESTART_MARKER} pr="${REPO}#${pr}" -->`,
    user: { login: FLEET },
    created_at: iso(NOW - 86400),
  });
  const { state, deps } = harness({
    issueLabels: ["work-on"],
    issueComments: [claim(61), claim(62)],
  });
  const stall = stallFor("red-ci");

  assertEquals(await repairStalledPr(stall, deps), "first-trip");
  state.now += THRESHOLD;
  assertEquals(await repairStalledPr(stall, deps), "abandoned");

  assertEquals(
    state.prClosed,
    true,
    "the exhausted PR is closed and the issue re-queued instead",
  );
  // A third restart is still a restart, not a hand-off: the pickup label the
  // issue already carried is kept, and no `needs-human` is ever applied
  // (Issue #3033).
  assertEquals(state.issueLabels, ["work-on"]);
  assertEquals(state.issueComments.length, 3);
  assertStringIncludes(state.issueComments[2]!.body, `${REPO}#${PR}`);
  assertStringIncludes(state.issueComments[2]!.body, "has stalled");
  assertStringIncludes(state.issueComments[2]!.body, "restart **3**");
  assert(
    !state.issueComments.some((entry) =>
      entry.body.includes("needs a human") ||
      entry.body.includes("handed to a human")
    ),
    "no hand-off comment is posted",
  );
  assertEquals(state.writesOutsideLease, [], "every write holds the lease");
});

// ---------------------------------------------------------------------------
// A trip marker belongs to one stall (PR #2866 review): a marker left by an
// earlier, since-resolved stall must not turn a new stall's first check into
// a second trip.
// ---------------------------------------------------------------------------

/** A fleet trip marker posted `ageSeconds` before NOW. */
function oldMarker(ageSeconds: number): Comment {
  return {
    body: `${STALL_REPAIR_MARKER_PREFIX} pr="${PR}" reasons="red-ci" -->`,
    user: { login: FLEET },
    created_at: iso(NOW - ageSeconds),
  };
}

Deno.test("an unanswered comment newer than an earlier stall's marker takes a fresh first trip, not an abandon", async () => {
  // Red CI days ago was repaired by its first trip; the PR then sat green.
  // The authorised comment (3 h ago) is a new stall the old marker predates.
  const { state, deps } = harness({ prComments: [oldMarker(3 * 86400)] });

  assertEquals(
    await repairStalledPr(stallFor("unanswered-comment"), deps),
    "first-trip",
  );
  assertEquals(state.prClosed, false, "the reviewed PR is not closed");
  assertEquals(state.syncs, 1, "the branch is synced");
  assertEquals(state.lanes, ["pr-feedback"], "the lane is rerun once");
  assertEquals(state.prComments.length, 2, "a new marker claims this stall");
  assertEquals(forbiddenCalls(state.calls), []);
});

Deno.test("a red-CI stall long after an earlier repaired one takes a fresh first trip, not an abandon", async () => {
  // A marker from a red-CI stall two weeks ago, far outside any second check.
  const { state, deps } = harness({ prComments: [oldMarker(14 * 86400)] });

  assertEquals(await repairStalledPr(stallFor("red-ci"), deps), "first-trip");
  assertEquals(state.prClosed, false);
  assertEquals(state.syncs, 1);
  assertEquals(state.lanes, ["ci-fix"]);
});

Deno.test("a marker taken on this unanswered comment still leads to the second trip", async () => {
  // The marker (2.5 h ago) postdates the comment (3 h ago): same stall.
  const { state, deps } = harness({
    prComments: [oldMarker(THRESHOLD + 1800)],
  });

  assertEquals(
    await repairStalledPr(stallFor("unanswered-comment"), deps),
    "abandoned",
  );
  assertEquals(state.prClosed, true);
  assertEquals(state.lanes, [], "the second trip reruns nothing");
});

Deno.test("a red-CI marker within the second-check window still leads to the second trip", async () => {
  // The first trip's sync reran CI, which failed again after the marker —
  // the failure being newer than the marker is the repair not working.
  const { state, deps } = harness({ prComments: [oldMarker(2 * THRESHOLD)] });

  assertEquals(await repairStalledPr(stallFor("red-ci"), deps), "abandoned");
  assertEquals(state.prClosed, true);
  assertEquals(state.lanes, []);
});
