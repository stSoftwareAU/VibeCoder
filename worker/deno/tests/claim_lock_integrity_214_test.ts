/**
 * Tests for the claim-lock integrity invariants (Issue #214).
 *
 * VibeCoder#185 was unassigned at 06:31Z by the host that was working it,
 * with no release comment, while its heartbeat kept beating to 06:40Z. The
 * assignee is the claim lock every other host checks, so for nine minutes
 * any host could have started a second agent on the same issue and branch.
 *
 * Three invariants are asserted here, each through the real function:
 *
 *   1. A claim is refused when the issue is unassigned but its heartbeat
 *      beat within the live window.
 *   2. A recovery or cleanup pass never touches an issue a live slot owns.
 *   3. A release stops the heartbeat and posts the outcome BEFORE dropping
 *      the assignee, and no heartbeat can be written after a release.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  claimIssue,
  findLiveHeartbeatMarker,
  LIVE_HEARTBEAT_WINDOW_SECONDS,
} from "../lib/claim_issue.ts";
import {
  formatHeartbeatMarker,
  heartbeatFilePath,
  recordHeartbeat,
  releaseClaim,
} from "../lib/heartbeat_storage.ts";
import { startHeartbeat, stopHeartbeat } from "../lib/heartbeat.ts";
import { isHeldByLiveSlot, setLiveSlotHolds } from "../lib/live_slot_holds.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import {
  detectAssignedWithClosedPr,
  detectAssignedWithoutHeartbeat,
  recoverStuckIssue,
} from "../lib/stuck_recovery.ts";
import {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
} from "../lib/recovery_telemetry.ts";
import type { StuckIssueConfig } from "../lib/stuck_detection.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 185;

/** Current epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Comment payload the `gh api .../comments` reads return. */
function commentsJson(
  entries: Array<{ body: string; author?: string }>,
): string {
  return JSON.stringify(
    entries.map((e, index) => ({
      id: 1000 + index,
      body: e.body,
      created_at: new Date(0).toISOString(),
      author: e.author ?? "stservice",
      user: { login: e.author ?? "stservice" },
    })),
  );
}

/**
 * A `gh` runner covering the reads the claim path makes: an unassigned
 * issue, open, with the supplied comments.
 */
function claimGh(comments: string): {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--json assignees")) return Promise.resolve("[]");
    if (joined.includes("--json state")) return Promise.resolve("OPEN");
    if (joined.includes("/comments")) return Promise.resolve(comments);
    return Promise.resolve("");
  };
  return { ghCommandFn, calls };
}

// ---------------------------------------------------------------------------
// Invariant 1 — a live heartbeat makes an unassigned issue unavailable
// ---------------------------------------------------------------------------

Deno.test("findLiveHeartbeatMarker - a beat inside the window is live", () => {
  const now = 1_700_000_000;
  const live = findLiveHeartbeatMarker(
    [{ machineId: "vibe-coder-38625", epoch: now - 120, cleared: false }],
    now,
  );
  assert(live !== null);
  assertEquals(live.machineId, "vibe-coder-38625");
  assertEquals(live.ageSeconds, 120);
});

Deno.test("findLiveHeartbeatMarker - a beat older than the window is not live", () => {
  const now = 1_700_000_000;
  const live = findLiveHeartbeatMarker(
    [{
      machineId: "vibe-coder-38625",
      epoch: now - LIVE_HEARTBEAT_WINDOW_SECONDS - 1,
      cleared: false,
    }],
    now,
  );
  assertEquals(live, null);
});

Deno.test("findLiveHeartbeatMarker - a released (cleared) marker is not live", () => {
  const now = 1_700_000_000;
  const live = findLiveHeartbeatMarker(
    [{ machineId: "vibe-coder-38625", epoch: 0, cleared: true }],
    now,
  );
  assertEquals(live, null);
});

Deno.test("findLiveHeartbeatMarker - picks the most recent live beat", () => {
  const now = 1_700_000_000;
  const live = findLiveHeartbeatMarker([
    { machineId: "old-host", epoch: now - 400, cleared: false },
    { machineId: "new-host", epoch: now - 30, cleared: false },
  ], now);
  assert(live !== null);
  assertEquals(live.machineId, "new-host");
});

Deno.test("claimIssue - refuses an unassigned issue whose heartbeat is still beating", async () => {
  const marker = formatHeartbeatMarker("vibe-coder-38625", nowSeconds() - 60);
  const { ghCommandFn, calls } = claimGh(commentsJson([{ body: marker }]));

  const result = await claimIssue({
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "VibeCoderST",
    workerId: "VibeCoderST-1",
    fleetAuthors: ["VibeCoderST", "stservice"],
    ghCommandFn,
    sleepFn: () => Promise.resolve(),
    wasClosedThisRun: () => false,
  });

  assert(result.ok);
  assertEquals(result.value.claimed, false);
  assertEquals(result.value.reason, "heartbeat_active");
  assertStringIncludes(result.value.reasonDetail ?? "", "vibe-coder-38625");
  // No assignment was attempted — the issue is someone else's in-flight work.
  assert(!calls.some((c) => c.join(" ").includes("--add-assignee")));
});

Deno.test("claimIssue - claims when the only heartbeat marker is a released one", async () => {
  const released = `${formatHeartbeatMarker("vibe-coder-38625", 0)} ` +
    `<!-- cleared: claim released by machine vibe-coder-38625 -->`;
  const { ghCommandFn, calls } = claimGh(commentsJson([{ body: released }]));

  const result = await claimIssue({
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "VibeCoderST",
    workerId: "VibeCoderST-1",
    fleetAuthors: ["VibeCoderST", "stservice"],
    ghCommandFn,
    sleepFn: () => Promise.resolve(),
    wasClosedThisRun: () => false,
  });

  assert(result.ok);
  assertEquals(result.value.claimed, true);
  assert(calls.some((c) => c.join(" ").includes("--add-assignee")));
});

Deno.test("claimIssue - ignores a live heartbeat marker forged by a non-fleet author", async () => {
  const marker = formatHeartbeatMarker("attacker-box", nowSeconds() - 10);
  const { ghCommandFn } = claimGh(
    commentsJson([{ body: marker, author: "random-user" }]),
  );

  const result = await claimIssue({
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "VibeCoderST",
    workerId: "VibeCoderST-1",
    fleetAuthors: ["VibeCoderST", "stservice"],
    ghCommandFn,
    sleepFn: () => Promise.resolve(),
    wasClosedThisRun: () => false,
  });

  assert(result.ok);
  assertEquals(result.value.claimed, true);
});

// ---------------------------------------------------------------------------
// Invariant 2 — maintenance passes leave a live slot's issue alone
// ---------------------------------------------------------------------------

/** Install a registry holding one issue; returns the restore function. */
function holdIssue(repo: string, issueNumber: number): () => void {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire(repo, issueNumber, "s1");
  return setLiveSlotHolds(() => registry.heldIssues());
}

Deno.test("live slot holds - an unregistered provider reports no holds", () => {
  assertEquals(isHeldByLiveSlot(REPO, ISSUE), false);
});

Deno.test("recoverStuckIssue - refuses to unassign an issue a live slot owns", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  const restore = holdIssue(REPO, ISSUE);
  try {
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      REPO,
      ISSUE,
      "stservice",
      1800,
      (args: string[]) => {
        calls.push(args);
        return Promise.resolve("");
      },
    );

    assertEquals(result.ok, false);
    assertEquals(calls.length, 0, "no GitHub mutation may be attempted");
  } finally {
    restore();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - still recovers an issue no slot owns", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  const restore = holdIssue(REPO, 999);
  try {
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      REPO,
      ISSUE,
      "stservice",
      1800,
      (args: string[]) => {
        calls.push(args);
        return Promise.resolve("");
      },
    );

    assertEquals(result.ok, true);
    assert(calls.some((c) => c.includes("--remove-assignee")));
  } finally {
    restore();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAssignedWithoutHeartbeat - leaves an issue a live slot owns alone", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  const restore = holdIssue(REPO, ISSUE);
  __resetRecoveryDecisions();
  try {
    const mutations: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      const joined = args.join(" ");
      if (
        joined.includes("--remove-assignee") ||
        (args[0] === "issue" && args[1] === "comment")
      ) {
        mutations.push(args);
      }
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: ISSUE,
          title: "Claim lock dropped mid-run",
          assignees: [{ login: "stservice" }],
          labels: [],
          updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        }]));
      }
      return Promise.resolve("");
    };

    const config: StuckIssueConfig = {
      workDir,
      repos: [REPO],
      stuckIssueTimeout: 1800,
      assignedNoHeartbeatTimeout: 1800,
      staleAssignmentTimeout: 7200,
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "stservice",
      undefined,
      ghFn,
    );

    assertEquals(recovered, 0);
    assertEquals(mutations.length, 0);
    const decisions = __getRecoveryDecisions();
    assertEquals(decisions.at(-1)?.decision, "skipped:live_slot");
  } finally {
    restore();
    __resetRecoveryDecisions();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAssignedWithClosedPr - leaves an issue a live slot owns alone", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  const restore = holdIssue(REPO, ISSUE);
  try {
    const mutations: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      const joined = args.join(" ");
      if (
        joined.includes("--remove-assignee") || args[1] === "comment" ||
        args[1] === "close"
      ) {
        mutations.push(args);
      }
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: ISSUE,
          title: "Claim lock dropped mid-run",
          assignees: [{ login: "stservice" }],
          labels: [],
          updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        }]));
      }
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve("");
    };

    const config: StuckIssueConfig = {
      workDir,
      repos: [REPO],
      stuckIssueTimeout: 1800,
      assignedNoHeartbeatTimeout: 1800,
      staleAssignmentTimeout: 7200,
    };

    const recovered = await detectAssignedWithClosedPr(
      config,
      "stservice",
      "planning",
      ghFn,
    );

    assertEquals(recovered, 0);
    assertEquals(mutations.length, 0);
  } finally {
    restore();
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Invariant 3 — release order, and no heartbeat after release
// ---------------------------------------------------------------------------

Deno.test("releaseClaim - clears the heartbeat before dropping the assignee", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  try {
    await recordHeartbeat(workDir, REPO, ISSUE);
    const order: string[] = [];
    // One live marker comment on the thread, authored by the fleet — the
    // release PATCHes it with the outcome before the assignee is dropped.
    const liveMarker = formatHeartbeatMarker(
      "vibe-coder-38625",
      nowSeconds() - 60,
    );
    const ghFn = (args: string[]): Promise<string> => {
      const joined = args.join(" ");
      if (joined.includes("--remove-assignee")) {
        order.push("unassign");
        return Promise.resolve("");
      }
      if (joined.includes("-X PATCH")) {
        order.push("marker");
        return Promise.resolve("42");
      }
      if (joined.includes("/comments")) {
        return Promise.resolve(JSON.stringify([{
          id: 42,
          body: liveMarker,
          author: "stservice",
          user: { login: "stservice" },
        }]));
      }
      return Promise.resolve("");
    };

    const result = await releaseClaim(workDir, REPO, ISSUE, {
      githubUser: "stservice",
      ghFn,
      markerOptions: { machineId: "vibe-coder-38625", ghFn },
    });

    assert(result.ok);
    assertEquals(result.value.unassigned, true);
    assertEquals(order.at(-1), "unassign", "the assignee is dropped last");
    assert(
      order.includes("marker"),
      "the release comment is written before the unassign",
    );

    // The heartbeat file is gone.
    let stillThere = true;
    try {
      await Deno.stat(heartbeatFilePath(workDir, REPO, ISSUE));
    } catch {
      stillThere = false;
    }
    assertEquals(stillThere, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recordHeartbeat - is refused after the claim is released", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  try {
    assertEquals((await recordHeartbeat(workDir, REPO, ISSUE)).ok, true);

    await releaseClaim(workDir, REPO, ISSUE, {
      githubUser: "stservice",
      ghFn: () => Promise.resolve(""),
    });

    const late = await recordHeartbeat(workDir, REPO, ISSUE);
    assertEquals(late.ok, false, "a beat after release must be refused");
    if (!late.ok) {
      assertStringIncludes(late.error.message, "already released");
    }
    // And it left no heartbeat file behind for recovery to trip over.
    let stillThere = true;
    try {
      await Deno.stat(heartbeatFilePath(workDir, REPO, ISSUE));
    } catch {
      stillThere = false;
    }
    assertEquals(stillThere, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("startHeartbeat - a new claim on a released issue may beat again", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "claim-214-" });
  try {
    await recordHeartbeat(workDir, REPO, ISSUE);
    await releaseClaim(workDir, REPO, ISSUE, {
      githubUser: "stservice",
      ghFn: () => Promise.resolve(""),
    });
    assertEquals((await recordHeartbeat(workDir, REPO, ISSUE)).ok, false);

    const started = await startHeartbeat({
      repo: REPO,
      issueNumber: ISSUE,
      workDir,
      intervalMs: 3_600_000,
      recordFn: (dir, repo, issueNumber) =>
        recordHeartbeat(dir, repo, issueNumber),
      clearFn: () => Promise.resolve({ ok: true, value: undefined }),
    });

    assert(started.ok, "the new claim's initial beat must succeed");
    assertEquals((await recordHeartbeat(workDir, REPO, ISSUE)).ok, true);
    await stopHeartbeat(started.value);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
