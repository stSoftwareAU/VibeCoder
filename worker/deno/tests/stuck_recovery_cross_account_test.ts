/**
 * Cross-account stale-assignment recovery tests (Issue #2671).
 *
 * The recovery scans may auto-unassign a stale assignee from *any* account
 * when that account has posted worker claim/heartbeat markers on the issue —
 * evidence-based, no configured allowlist. These tests verify the
 * evidence rule, every preserved safeguard, the audit note, the
 * cross-account telemetry flag, and the bounded comment-fetch cost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
  formatHeartbeatMarker,
  HEARTBEAT_MARKER_PREFIX,
} from "../lib/stuck_issue_detector.ts";
import {
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
} from "../lib/stuck_recovery.ts";
import {
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

const SCANNING_USER = "stsvcbot";
const LEAKING_ACCOUNT = "Vibecoderbot";

async function makeTempDir(prefix = "xa-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string, machineId = "m1"): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: ["org/repo"],
    machineId,
  };
}

/** Build an issue-list entry assigned to the given logins. */
function buildIssue(
  num: number,
  updatedAt: string,
  assignees: string[],
): Record<string, unknown> {
  return {
    number: num,
    title: `Issue ${num}`,
    assignees: assignees.map((login) => ({ login })),
    labels: [],
    author: { login: "alice" },
    createdAt: updatedAt,
    updatedAt,
    url: `https://example/${num}`,
    milestone: null,
  };
}

/** A comment body + author, as returned by the comments API mock. */
function comment(body: string, login: string): Record<string, unknown> {
  return { body, login };
}

/**
 * Build a gh mock. `comments` is keyed nothing — every comments call
 * returns the same array. `prSearch` defaults to "no open PR". `calls`
 * records every invocation so tests can assert on cost/audit notes.
 */
function makeGh(opts: {
  issues: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
  prSearch?: Record<string, unknown>[];
  calls: string[][];
}): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    opts.calls.push([...args]);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(opts.issues));
    }
    if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
      return Promise.resolve(JSON.stringify(opts.prSearch ?? []));
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve(JSON.stringify(opts.comments ?? []));
    }
    return Promise.resolve("");
  };
}

// ===========================================================================
// Acceptance criterion 1 — recover a cross-account leak with marker evidence
// ===========================================================================

Deno.test("cross-account - recoverStaleGithubAssignments recovers a leaked assignment with cleared marker evidence", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Past staleAssignmentTimeout (14400s) and the 1h cleared-marker grace.
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // The shape clearHeartbeat writes: a claim comment whose marker has been
    // cleared (epoch 0 + cleared suffix), authored by the leaking account.
    const clearedBody = `<!-- CLAIM_LOCK:${LEAKING_ACCOUNT}-worker -->\n` +
      `<!-- ${HEARTBEAT_MARKER_PREFIX}:other-machine:0 --> ` +
      `<!-- cleared: claim released by machine other-machine -->`;

    const ghFn = makeGh({
      issues: [buildIssue(2671, oldUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(clearedBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "recovered");
    assertEquals(e.assignee, LEAKING_ACCOUNT);
    assertEquals(e.crossAccount, true);
    assertEquals(e.markerState, "cleared");

    // The leaking account — not the scanning user — was unassigned.
    const unassign = calls.find((c) => c.includes("--remove-assignee"));
    assertEquals(
      unassign?.[unassign.indexOf("--remove-assignee") + 1],
      LEAKING_ACCOUNT,
    );

    // An audit note naming the recovering machine and the cross-account
    // reason was posted.
    const note = calls.find((c) => c[0] === "issue" && c[1] === "comment");
    const body = note?.[note.indexOf("--body") + 1] ?? "";
    assertEquals(body.includes("m1"), true);
    assertEquals(body.includes("Cross-account"), true);
    assertEquals(body.includes("#2671"), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - detectAssignedWithoutHeartbeat recovers a leaked assignment with live-then-stale marker evidence", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // A stale heartbeat marker (older than the timeout) authored by the
    // leaking account — evidence it is a worker, but its claim is dead.
    const staleBody = formatHeartbeatMarker("other-machine", now - 99999);

    const ghFn = makeGh({
      issues: [buildIssue(3000, oldUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(staleBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const e = __getRecoveryDecisions()[0]!;
    assertEquals(e.decision, "recovered");
    assertEquals(e.assignee, LEAKING_ACCOUNT);
    assertEquals(e.crossAccount, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ===========================================================================
// Negative tests — evidence rule and preserved safeguards
// ===========================================================================

Deno.test("cross-account - assignee with NO marker evidence (human) is never unassigned", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // Issue assigned to a human teammate. The only comment carries no
    // worker marker, so there is no evidence the assignee is a worker.
    const ghFn = makeGh({
      issues: [buildIssue(3100, oldUpdatedAt, ["human-teammate"])],
      comments: [comment("Looks good to me, merging soon.", "human-teammate")],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    // No candidate at all → no telemetry event, no unassign.
    assertEquals(__getRecoveryDecisions().length, 0);
    assertEquals(calls.some((c) => c.includes("--remove-assignee")), false);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - markers authored by a DIFFERENT account do not make the assignee recoverable", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // The issue is assigned to a human, but a *different* account left a
    // marker. Evidence must be attributed to the assignee, not anyone.
    const markerBody = formatHeartbeatMarker("other-machine", now - 99999);
    const ghFn = makeGh({
      issues: [buildIssue(3150, oldUpdatedAt, ["human-teammate"])],
      comments: [comment(markerBody, "some-other-bot")],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    assertEquals(__getRecoveryDecisions().length, 0);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - live marker skips recovery (skipped:live_marker)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // Fresh marker (60s ago) authored by the leaking account — its claim
    // is still alive, so recovery must skip.
    const liveBody = formatHeartbeatMarker("other-machine", now - 60);
    const ghFn = makeGh({
      issues: [buildIssue(3200, oldUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(liveBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    const e = __getRecoveryDecisions()[0]!;
    assertEquals(e.decision, "skipped:live_marker");
    assertEquals(e.crossAccount, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - open linked PR skips recovery (skipped:open_pr)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    const staleBody = formatHeartbeatMarker("other-machine", now - 99999);
    const ghFn = makeGh({
      issues: [buildIssue(3300, oldUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(staleBody, LEAKING_ACCOUNT)],
      prSearch: [{
        number: 777,
        title: "Fix bug (#3300)",
        baseRefName: "main",
        headRefName: "h",
        mergedAt: null,
      }],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    const e = __getRecoveryDecisions()[0]!;
    assertEquals(e.decision, "skipped:open_pr");
    assertEquals(e.linkedOpenPR, "org/repo#777");
    assertEquals(e.crossAccount, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - cleared marker within the 1h grace window skips recovery (skipped:cleared_marker)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Past staleAssignmentTimeout would normally recover, but the grace
    // window is measured against updatedAt. Use an elapsed that is past the
    // assignedNoHeartbeat threshold yet inside the 1h grace, and run the
    // 30-minute scan so the threshold is crossed.
    const elapsed = 1900; // 31m 40s — past 1800s threshold, inside 3600s grace
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    const clearedBody = `<!-- ${HEARTBEAT_MARKER_PREFIX}:other-machine:0 --> ` +
      `<!-- cleared: claim released by machine other-machine -->`;
    const ghFn = makeGh({
      issues: [buildIssue(3400, oldUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(clearedBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    const e = __getRecoveryDecisions()[0]!;
    assertEquals(e.decision, "skipped:cleared_marker");
    assertEquals(e.crossAccount, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - within-threshold updatedAt skips recovery AND does not fetch comments (bounded cost)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Updated 60s ago — well within the stale-assignment threshold.
    const recentUpdatedAt = new Date((now - 60) * 1000).toISOString();
    const calls: string[][] = [];

    const staleBody = formatHeartbeatMarker("other-machine", now - 99999);
    const ghFn = makeGh({
      issues: [buildIssue(3500, recentUpdatedAt, [LEAKING_ACCOUNT])],
      comments: [comment(staleBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);
    // No candidate → no telemetry event.
    assertEquals(__getRecoveryDecisions().length, 0);
    // Cost bound: the comments endpoint must NOT have been queried for an
    // issue that failed the cheap updatedAt pre-check.
    const commentFetches = calls.filter((c) =>
      c[0] === "api" && c[1]?.endsWith("/comments")
    );
    assertEquals(commentFetches.length, 0);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ===========================================================================
// Own-account behaviour unchanged
// ===========================================================================

Deno.test("cross-account - own-account recovery still works and is flagged crossAccount:false", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    // Assigned to the scanning user itself, no markers, no PR → recovered.
    const ghFn = makeGh({
      issues: [buildIssue(3600, oldUpdatedAt, [SCANNING_USER])],
      comments: [],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);
    const e = __getRecoveryDecisions()[0]!;
    assertEquals(e.decision, "recovered");
    assertEquals(e.assignee, SCANNING_USER);
    assertEquals(e.crossAccount, false);

    // The own-account comment keeps its original (non cross-account) wording.
    const note = calls.find((c) => c[0] === "issue" && c[1] === "comment");
    const body = note?.[note.indexOf("--body") + 1] ?? "";
    assertEquals(body.includes("Cross-account"), false);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("cross-account - own and leaked assignee on the same issue both evaluated", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("xa-cache-");
  const workDir = await makeTempDir("xa-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    const calls: string[][] = [];

    const staleBody = formatHeartbeatMarker("other-machine", now - 99999);
    const ghFn = makeGh({
      issues: [
        buildIssue(3700, oldUpdatedAt, [SCANNING_USER, LEAKING_ACCOUNT]),
      ],
      comments: [comment(staleBody, LEAKING_ACCOUNT)],
      calls,
    });

    const recovered = await recoverStaleGithubAssignments(
      config,
      SCANNING_USER,
      () => now,
      ghFn,
      cache,
    );
    // Both assignees recovered (own + cross-account).
    assertEquals(recovered, 2);
    const events = __getRecoveryDecisions();
    assertEquals(events.length, 2);
    const ownEvent = events.find((e) => e.assignee === SCANNING_USER)!;
    const crossEvent = events.find((e) => e.assignee === LEAKING_ACCOUNT)!;
    assertEquals(ownEvent.crossAccount, false);
    assertEquals(crossEvent.crossAccount, true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
