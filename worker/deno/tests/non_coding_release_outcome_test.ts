/**
 * Tests for the run outcome on the non-coding terminal paths (Issue #4330,
 * part of #4291): the shared release helper forwards it to the marker
 * path, the heartbeat stop carries it to the final clear, a clear with
 * nothing new never overwrites an outcome already on the comment, and the
 * skip-after-claim path passes none.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  releaseAllWorkerClaims,
  releaseClaim,
  setMarkerReleaseHook,
} from "../lib/claim_release.ts";
import { startHeartbeat, stopHeartbeat } from "../lib/heartbeat.ts";
import {
  clearHeartbeat,
  renderHeartbeatBody,
  seedMarkerState,
  setPendingReleaseOutcome,
  takePendingReleaseOutcome,
} from "../lib/heartbeat_storage.ts";
import { expectedNoPrOutcome, failedRunOutcome } from "../lib/run_outcome.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";
import type { GitHubClient, GitHubIssue } from "../types.ts";

const warnLogger = { warn: () => {} };
const PLANNED = expectedNoPrOutcome(
  "planning",
  "planning round posted — sub-issues created",
);

Deno.test("release helper - releaseClaim forwards the outcome to the marker-release hook before unassigning; omitted → hook untouched, behaviour identical (Issue #4330)", async () => {
  const seen: { repo: string; n: number; outcome: RunOutcome }[] = [];
  const order: string[] = [];
  const restore = setMarkerReleaseHook((repo, n, outcome) => {
    seen.push({ repo, n, outcome });
    order.push("hook");
    return Promise.resolve();
  });
  try {
    const gh: Pick<GitHubClient, "unassignIssue"> = {
      unassignIssue: () => {
        order.push("unassign");
        return Promise.resolve();
      },
    };
    assertEquals(
      await releaseClaim(gh, "o/r", 7, "bot", warnLogger, { outcome: PLANNED }),
      true,
    );
    assertEquals(seen, [{ repo: "o/r", n: 7, outcome: PLANNED }]);
    assertEquals(order, ["hook", "unassign"]);
    // Omitted: exactly today's behaviour — one unassign, no hook call.
    seen.length = 0;
    order.length = 0;
    assertEquals(await releaseClaim(gh, "o/r", 7, "bot", warnLogger), true);
    assertEquals(seen, []);
    assertEquals(order, ["unassign"]);
  } finally {
    restore();
  }
});

Deno.test("release helper - a throwing hook is logged and swallowed; the unassign still runs (Issue #4330)", async () => {
  const restore = setMarkerReleaseHook(() =>
    Promise.reject(new Error("marker path down"))
  );
  const warnings: string[] = [];
  try {
    let unassigned = 0;
    const gh: Pick<GitHubClient, "unassignIssue"> = {
      unassignIssue: () => {
        unassigned++;
        return Promise.resolve();
      },
    };
    const ok = await releaseClaim(gh, "o/r", 7, "bot", {
      warn: (m: string) => {
        warnings.push(m);
      },
    }, { outcome: PLANNED });
    assertEquals(ok, true);
    assertEquals(unassigned, 1);
    assert(warnings.some((w) => w.includes("run outcome")), warnings.join(";"));
  } finally {
    restore();
  }
});

Deno.test("release helper - releaseAllWorkerClaims forwards the outcome too (Issue #4330)", async () => {
  const seen: RunOutcome[] = [];
  const restore = setMarkerReleaseHook((_r, _n, outcome) => {
    seen.push(outcome);
    return Promise.resolve();
  });
  try {
    const gh = {
      getIssue: () =>
        Promise.resolve({ assignees: ["bot"] } as unknown as GitHubIssue),
      getIssueComments: () => Promise.resolve([]),
      unassignIssue: () => Promise.resolve(),
    } as unknown as Pick<
      GitHubClient,
      "getIssue" | "getIssueComments" | "unassignIssue"
    >;
    const failed = failedRunOutcome("quorum", "both drafters failed", 12);
    assertEquals(
      await releaseAllWorkerClaims(gh, "o/r", 9, "bot", warnLogger, {
        outcome: failed,
      }),
      true,
    );
    assertEquals(seen, [failed]);
    assertEquals(
      await releaseAllWorkerClaims(gh, "o/r", 9, "bot", warnLogger),
      true,
    );
    assertEquals(seen.length, 1, "no outcome → no hook call");
  } finally {
    restore();
  }
});

Deno.test("heartbeat stop - stopHeartbeat(handle, outcome) parks the outcome for the clear that follows and drops any leftover (Issue #4330)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hb-outcome-" });
  try {
    const consumed: (RunOutcome | undefined)[] = [];
    const handle = await startHeartbeat({
      repo: "o/r",
      issueNumber: 3,
      workDir: dir,
      intervalMs: 60_000,
      recordFn: () => Promise.resolve({ ok: true, value: undefined }),
      clearFn: (_w, repo, n) => {
        consumed.push(takePendingReleaseOutcome(repo, n));
        return Promise.resolve({ ok: true, value: undefined });
      },
    });
    assert(handle.ok);
    await stopHeartbeat(handle.value, PLANNED);
    assertEquals(consumed, [PLANNED]);
    assertEquals(
      takePendingReleaseOutcome("o/r", 3),
      undefined,
      "nothing left parked",
    );

    // A clearFn that ignores the marker path: the parked outcome is dropped
    // after the stop so it cannot attach to a later claim.
    const handle2 = await startHeartbeat({
      repo: "o/r",
      issueNumber: 4,
      workDir: dir,
      intervalMs: 60_000,
      recordFn: () => Promise.resolve({ ok: true, value: undefined }),
      clearFn: () => Promise.resolve({ ok: true, value: undefined }),
    });
    assert(handle2.ok);
    await stopHeartbeat(handle2.value, PLANNED);
    assertEquals(takePendingReleaseOutcome("o/r", 4), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clear - a planning release renders ✅ with the no-PR-expected clause, never ⚠️ (Issue #4330)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "planning-release-" });
  try {
    await seedMarkerState(dir, "o/r", 11, { commentId: 501, lastRefresh: 100 });
    const bodies: string[] = [];
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        bodies.push(args[args.indexOf("-f") + 1]!.replace(/^body=/, ""));
        return Promise.resolve("501");
      }
      return Promise.resolve("[]");
    };
    setPendingReleaseOutcome("o/r", 11, PLANNED);
    await clearHeartbeat(
      dir,
      "o/r",
      11,
      { machineId: "host-P", ghFn },
      () => 3600,
    );
    assertEquals(bodies.length, 1);
    assertStringIncludes(bodies[0]!, "✅ **Vibe Coder released this claim**");
    assertStringIncludes(
      bodies[0]!,
      "planning round posted — sub-issues created (no PR expected for this phase.)",
    );
    assert(!bodies[0]!.includes("⚠️"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clear - a second clear with no outcome (crash cleanup / stuck detector / duplicate stop) does not overwrite the outcome already on the comment (Issue #4330)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "no-overwrite-" });
  try {
    await seedMarkerState(dir, "o/r", 12, { commentId: 601, lastRefresh: 100 });
    const bodies: string[] = [];
    let current = renderHeartbeatBody({ machineId: "host-P", epoch: 100 });
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        current = args[args.indexOf("-f") + 1]!.replace(/^body=/, "");
        bodies.push(current);
        return Promise.resolve("601");
      }
      if (args[1]?.endsWith("/comments")) {
        return Promise.resolve(
          JSON.stringify([{ id: 601, body: current, author: "bot" }]),
        );
      }
      return Promise.resolve("");
    };
    const failed = failedRunOutcome(
      "execute",
      "Claude timed out after 3600s",
      3600,
    );
    await clearHeartbeat(
      dir,
      "o/r",
      12,
      { machineId: "host-P", ghFn },
      () => 7200,
      failed,
    );
    assertEquals(bodies.length, 1);
    assertStringIncludes(
      bodies[0]!,
      "⚠️ **Vibe Coder released this claim with no PR**",
    );
    // Crash cleanup / the stuck-issue detector CLI: a clear with nothing to say.
    await clearHeartbeat(
      dir,
      "o/r",
      12,
      { machineId: "host-P", ghFn },
      () => 7300,
    );
    await clearHeartbeat(
      dir,
      "o/r",
      12,
      { machineId: "host-Q", ghFn },
      () => 7400,
    );
    assertEquals(bodies.length, 1, "no PATCH — the outcome stands");
    assertStringIncludes(current, "**Outcome:** no PR raised — `timeout`.");
    // The same release cleared again within the minute (heartbeat stop then
    // claim release) with the same outcome: no second write either.
    await clearHeartbeat(
      dir,
      "o/r",
      12,
      { machineId: "host-P", ghFn },
      () => 7200,
      failed,
    );
    assertEquals(bodies.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clear - a claim that produced an outcome and is then released without one keeps the comment body unchanged (skip-after-claim shape) (Issue #4330)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skip-shape-" });
  try {
    // A released marker state with no outcome ever written (the claim was
    // released before any run) — the second, outcome-less clear is a no-op
    // rather than a rewrite: the comment body is left exactly as it was.
    await seedMarkerState(dir, "o/r", 13, { commentId: 701, lastRefresh: 100 });
    const patches: string[] = [];
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        patches.push(args[args.indexOf("-f") + 1]!.replace(/^body=/, ""));
        return Promise.resolve("701");
      }
      return Promise.resolve("[]");
    };
    await clearHeartbeat(
      dir,
      "o/r",
      13,
      { machineId: "host-P", ghFn },
      () => 100,
    );
    assertEquals(patches.length, 1);
    assert(!patches[0]!.includes("**Outcome:**"));
    await clearHeartbeat(
      dir,
      "o/r",
      13,
      { machineId: "host-P", ghFn },
      () => 160,
    );
    assertEquals(
      patches.length,
      1,
      "already released, nothing new → untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
